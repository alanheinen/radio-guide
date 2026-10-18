#!/usr/bin/env python3
"""Serve the radio guide with a small stream proxy and now-playing lookups.

    python3 scripts/serve.py [--host 127.0.0.1] [--port 8080]

Besides the static files in web/, it answers:

  /api/health              lets the page know the server's extras are there
  /proxy?u=URL             fetches URL server-side, rewrites HLS playlists so
                           every child playlist and segment also goes through
                           the proxy, and adds CORS headers. For plain HTTP
                           streams on an HTTPS page, and old Shoutcast servers
                           that answer "ICY 200 OK", which browsers refuse
  /api/nowplaying?id=ID[&s=N]
                           what station ID is playing now: the BBC's own track
                           data for BBC stations, otherwise the song title the
                           stream itself carries (ICY metadata, which a
                           browser can't read). Only streams in the station
                           list can be asked about, so this can't be used to
                           fetch arbitrary URLs. Also returns the titles seen
                           recently, while anyone was listening

Requests to private, loopback and link-local addresses are refused so the
proxy can't be used to reach your own network. It binds to 127.0.0.1 unless
you pass --host. Standard library only.

With --data DIR the station data is served from DIR instead of web/data, and
with --refresh HOURS the server rebuilds it (scripts/build.py) at startup and
on that interval, which is how every deployment keeps its schedules current.
--countries picks the countries for those rebuilds (or set COUNTRIES), and
--log FILE sends all output to a file, for running without a console.
"""

from __future__ import annotations

import argparse
import collections
import http.client
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
BUILD = Path(__file__).resolve().parent / "build.py"
DATA = WEB / "data"
DATA_FILES = ("stations.json", "guide.json")
DEFAULT_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 20
CHUNK = 64 * 1024
BBC_RMS = "https://rms.api.bbc.co.uk/v2/"


class Refused(Exception):
    pass


class ICYResponse(http.client.HTTPResponse):
    """Accepts the "ICY 200 OK" status line of Shoutcast v1 servers, which
    http.client (and most browsers) reject, by reading it as HTTP/1.0."""

    def _read_status(self):
        line = str(self.fp.readline(http.client._MAXLINE + 1), "iso-8859-1")
        if len(line) > http.client._MAXLINE:
            raise http.client.LineTooLong("status line")
        if not line:
            raise http.client.RemoteDisconnected("Remote end closed connection without response")
        if line.startswith("ICY "):
            line = "HTTP/1.0 " + line[4:]
        version, status, reason = (line.split(None, 2) + ["", ""])[:3]
        if not version.startswith("HTTP/") or not status.isdigit():
            self._close_conn()
            raise http.client.BadStatusLine(line)
        return version, int(status), reason


http.client.HTTPConnection.response_class = ICYResponse


def check_host(url: str) -> None:
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise Refused("only http and https URLs can be proxied")
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except socket.gaierror as e:
        raise Refused(f"can't resolve {p.hostname}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise Refused(f"{p.hostname} resolves to a private address")


class NoPrivateRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(NoPrivateRedirects)


def upstream(url: str, rng: str = "", headers: dict | None = None, timeout: float = TIMEOUT):
    check_host(url)
    h = {"User-Agent": DEFAULT_UA, "Accept": "*/*", **(headers or {})}
    if rng:
        h["Range"] = rng
    return OPENER.open(urllib.request.Request(url, headers=h), timeout=timeout)


def proxied(url: str) -> str:
    return "/proxy?" + urllib.parse.urlencode({"u": url})


URI_ATTR = re.compile(r'URI="([^"]+)"')


def rewrite_playlist(text: str, base: str) -> str:
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
        elif s.startswith("#"):
            out.append(URI_ATTR.sub(lambda m: f'URI="{proxied(urllib.parse.urljoin(base, m.group(1)))}"', line))
        else:
            out.append(proxied(urllib.parse.urljoin(base, s)))
    return "\n".join(out) + "\n"


def is_playlist(head: bytes) -> bool:
    # Sniff, never trust the Content-Type or extension: an audio stream's
    # first bytes are never "#EXTM3U", and some HLS servers send text/plain.
    return head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"#EXTM3U")


# ---------------------------------------------------------------- stations

class Stations:
    """The station list, read from stations.json and re-read when the hourly
    rebuild replaces it. Now-playing lookups only reach these streams."""

    def __init__(self):
        self.lock = threading.Lock()
        self.mtime = 0.0
        self.by_id: dict[str, dict] = {}

    def get(self, sid: str) -> dict | None:
        path = DATA / "stations.json"
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
        with self.lock:
            if mtime != self.mtime:
                d = json.loads(path.read_text(encoding="utf-8"))
                self.by_id = {s["id"]: {"streams": s["streams"], "bbc": s.get("bbc", "")} for s in d["stations"]}
                self.mtime = mtime
            return self.by_id.get(sid)


STATIONS = Stations()


# ---------------------------------------------------------------- now playing

# "Artist - Title" as most stations send it; iHeart sends
# 'Artist - text="Title" song_spot="M" ...' and marks ads and promos with
# song_spot other than M.
IHEART = re.compile(r'^(.*?)\s*-\s*text="([^"]*)"(.*)$', re.S)
SPOT = re.compile(r'song_spot="([A-Z])"')
ART_URL = re.compile(r"^https?://\S+\.(?:jpe?g|png|webp)(?:\?\S*)?$", re.I)


def parse_icy(meta: str) -> dict:
    fields = dict(re.findall(r"(\w+)='(.*?)';", meta, re.S))
    title = fields.get("StreamTitle", "").strip()
    if not title or fields.get("adw_ad") == "true":
        return {}
    out: dict = {}
    m = IHEART.match(title)
    if m:
        spot = SPOT.search(m.group(3))
        if spot and spot.group(1) != "M":
            return {}
        out = {"artist": m.group(1).strip(), "title": m.group(2).strip()}
    elif " - " in title:
        artist, _, song = title.partition(" - ")
        out = {"artist": artist.strip(), "title": song.strip()}
    else:
        out = {"title": title}
    art = fields.get("StreamUrl", "").strip()
    if ART_URL.match(art):
        out["art"] = art
    return out


def read_icy(url: str) -> dict:
    """Read one metadata block from a stream: everything up to it is audio
    (icy-metaint bytes, typically 8-32 KB), which is thrown away."""
    with upstream(url, headers={"Icy-MetaData": "1"}, timeout=8) as r:
        interval = int(r.headers.get("icy-metaint") or 0)
        name = (r.headers.get("icy-name") or "").strip()
        if not 0 < interval <= 256 * 1024:
            return {"none": True}
        left = interval
        while left > 0:
            chunk = r.read(min(left, CHUNK))
            if not chunk:
                return {"none": True}
            left -= len(chunk)
        n = r.read(1)
        if not n:
            return {"none": True}
        meta = r.read(n[0] * 16).rstrip(b"\0")
    text = meta.decode("utf-8") if _utf8(meta) else meta.decode("latin-1")
    out = parse_icy(text)
    if name:
        out["name"] = name
    return out


def _utf8(b: bytes) -> bool:
    try:
        b.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def read_bbc(sid: str) -> dict:
    """The track on now, if any (not while the presenter talks), and the last
    few, which the BBC keeps itself."""
    q = urllib.parse.urlencode({"experience": "domestic", "offset": 0, "limit": 6})
    with upstream(f"{BBC_RMS}services/{sid}/segments/latest?{q}", timeout=8) as r:
        d = json.load(r)
    out: dict = {"recent": []}
    for seg in d.get("data", []):
        t = seg.get("titles") or {}
        item = {"artist": t.get("primary") or "", "title": t.get("secondary") or ""}
        if seg.get("image_url"):
            item["art"] = seg["image_url"].replace("{recipe}", "320x320")
        off = seg.get("offset") or {}
        if off.get("now_playing"):
            out.update(item)
        out["recent"].append({**item, "label": off.get("label") or ""})
    return out


class NowPlaying:
    """Lookups cached for 20 seconds, so any number of listeners on one
    station cost one upstream request, with the last few distinct titles kept
    per station for "recently played"."""

    TTL = 20
    HISTORY = 12
    MAX_STATIONS = 500

    def __init__(self):
        self.lock = threading.Lock()
        self.cache: dict[str, tuple[float, dict]] = {}
        self.inflight: dict[str, threading.Event] = {}
        self.history: collections.OrderedDict[str, collections.deque] = collections.OrderedDict()

    def get(self, sid: str, idx: int) -> dict:
        st = STATIONS.get(sid)
        if st is None:
            raise Refused("unknown station")
        if st["bbc"]:
            key, fn = f"bbc:{st['bbc']}", (lambda: read_bbc(st["bbc"]))
        else:
            if not 0 <= idx < len(st["streams"]):
                raise Refused("unknown stream")
            stream = st["streams"][idx]
            if stream.get("hls"):
                return {"hls": True, "history": self.recent(sid)}
            key, fn = stream["url"], (lambda: read_icy(stream["url"]))
        while True:
            with self.lock:
                hit = self.cache.get(key)
                if hit and time.time() - hit[0] < self.TTL:
                    return self.answer(sid, hit[1])
                ev = self.inflight.get(key)
                if ev is None:
                    ev = self.inflight[key] = threading.Event()
                    break
            ev.wait(10)
        try:
            try:
                now = fn()
            except (Refused, urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
                now = {"error": str(getattr(e, "reason", e))[:200]}
            with self.lock:
                self.cache[key] = (time.time(), now)
                if len(self.cache) > 2 * self.MAX_STATIONS:
                    for k in sorted(self.cache, key=lambda k: self.cache[k][0])[: self.MAX_STATIONS]:
                        del self.cache[k]
                if now.get("title") and "recent" not in now:
                    self.remember(sid, now)
            return self.answer(sid, now)
        finally:
            with self.lock:
                self.inflight.pop(key, None)
            ev.set()

    def answer(self, sid: str, now: dict) -> dict:
        # The BBC's own track list beats what this server happened to see.
        out = {k: v for k, v in now.items() if k != "recent"}
        out["history"] = now["recent"] if "recent" in now else self.recent(sid)
        return out

    def remember(self, sid: str, now: dict) -> None:
        h = self.history.get(sid)
        if h is None:
            h = self.history[sid] = collections.deque(maxlen=self.HISTORY)
            while len(self.history) > self.MAX_STATIONS:
                self.history.popitem(last=False)
        self.history.move_to_end(sid)
        item = {"at": int(time.time()), **{k: now[k] for k in ("artist", "title", "art") if now.get(k)}}
        if not h or (h[-1].get("artist"), h[-1].get("title")) != (item.get("artist"), item.get("title")):
            h.append(item)

    def recent(self, sid: str) -> list:
        h = self.history.get(sid)
        return list(reversed(h)) if h else []


NOW = NowPlaying()


# ---------------------------------------------------------------- handler

class Handler(SimpleHTTPRequestHandler):
    server_version = "SignalRadio/1.0"
    # Fixed types: on Windows, mimetypes reads the registry, which can map
    # .js to text/plain and break the page.
    extensions_map = {
        "": "application/octet-stream", ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_request(self, code="-", size="-"):
        # Segment fetches and now-playing polls are constant noise; keep only
        # failures, which log the upstream reason.
        if self.path.startswith(("/proxy", "/api/nowplaying")) and str(getattr(code, "value", code)).startswith(("2", "3")):
            return
        super().log_request(code, size)

    def log_error(self, fmt, *args):
        target = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("u", [""])[0]
        super().log_error(fmt + (" [%s]" % target[:200] if target else ""), *args)

    def end_headers(self):
        if self.path.startswith(("/proxy", "/api/")):
            self.send_header("Access-Control-Allow-Origin", "*")
        if self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path, _, query = self.path.partition("?")
        try:
            if path == "/api/health":
                return self.send_json({"proxy": True, "nowplaying": True, "cast": os.environ.get("CAST_APP_ID", "")})
            if path == "/healthz":
                ok = (DATA / "stations.json").exists()
                return self.send_json({"ready": ok}) if ok else self.send_error(503, "station data not built yet")
            if path.startswith("/data/") and path[len("/data/"):] in DATA_FILES:
                return self.send_data(path[len("/data/"):])
            if path == "/api/nowplaying":
                q = urllib.parse.parse_qs(query)
                idx = q.get("s", ["0"])[0]
                return self.send_json(NOW.get(q.get("id", [""])[0], int(idx) if idx.isdigit() else 0))
            if path == "/proxy":
                return self.relay(urllib.parse.parse_qs(query).get("u", [""])[0])
        except Refused as e:
            return self.send_error(403, str(e))
        except urllib.error.HTTPError as e:
            return self.send_error(e.code if 400 <= e.code < 600 else 502, f"upstream: {e.reason}")
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            return self.send_error(502, f"upstream: {getattr(e, 'reason', e)}")
        return super().do_GET()

    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if self.path.startswith("/api/nowplaying"):
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_data(self, name: str):
        """The data files, gzipped when the browser takes it: the build writes
        a .gz copy of each, and the US station list shrinks from ~3 MB to ~0.8."""
        gz = DATA / (name + ".gz")
        use_gz = "gzip" in self.headers.get("Accept-Encoding", "") and gz.exists()
        try:
            body = (gz if use_gz else DATA / name).read_bytes()
        except OSError:
            return self.send_error(404, f"{name} not built yet")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def relay(self, url: str):
        with upstream(url, self.headers.get("Range", "")) as r:
            ctype = r.headers.get("Content-Type", "application/octet-stream")
            final = r.geturl()
            head = r.read(4096)
            if is_playlist(head):
                text = (head + r.read()).decode("utf-8", "replace")
                body = rewrite_playlist(text, final).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(r.status)
            self.send_header("Content-Type", ctype)
            for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
                if r.headers.get(h):
                    self.send_header(h, r.headers[h])
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            # A live stream never ends: this copies until the listener leaves.
            try:
                self.wfile.write(head)
                while chunk := r.read1(CHUNK) if hasattr(r, "read1") else r.read(CHUNK):
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def refresher(hours: float) -> None:
    """Rebuild the station data now and then every `hours`, in a child process
    so the parser's memory is returned after each run."""
    while True:
        started = time.time()
        # The build logs to stderr; with --log that's the log file.
        r = subprocess.run([sys.executable, str(BUILD), "--out", str(DATA)], stdout=sys.stderr, stderr=sys.stderr)
        if r.returncode != 0:
            print(f"station refresh failed (exit {r.returncode}); retrying in 10 minutes", flush=True)
            time.sleep(600)
            continue
        time.sleep(max(60.0, hours * 3600 - (time.time() - started)))


def main():
    global DATA
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data", help="directory holding stations.json and guide.json (default web/data)")
    ap.add_argument("--refresh", type=float, default=0, help="rebuild the station data every N hours (0 = never)")
    ap.add_argument("--countries", help="countries for the rebuild, e.g. us,ca,gb (default: $COUNTRIES or us)")
    ap.add_argument("--log", help="append output to this file instead of the console (kept under ~5 MB)")
    a = ap.parse_args()
    if a.log:
        # Needed under pythonw.exe (a Windows background task), which has no
        # console: without it, sys.stderr is None and logging a request fails.
        log = Path(a.log)
        log.parent.mkdir(parents=True, exist_ok=True)
        if log.exists() and log.stat().st_size > 5_000_000:
            log.replace(log.with_name(log.name + ".1"))
        sys.stdout = sys.stderr = open(log, "a", encoding="utf-8", errors="replace", buffering=1)
    if a.countries:
        os.environ["COUNTRIES"] = a.countries
    if a.data:
        DATA = Path(a.data)
        DATA.mkdir(parents=True, exist_ok=True)
    if a.refresh > 0:
        threading.Thread(target=refresher, args=(a.refresh,), daemon=True).start()
    elif not (DATA / "stations.json").exists():
        print(f"{DATA}/stations.json is missing. Run: python3 scripts/build.py", flush=True)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"Signal Radio on http://{a.host if a.host != '0.0.0.0' else 'localhost'}:{a.port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
