#!/usr/bin/env python3
"""Build the station and schedule data for the web app.

Pulls every working station for the chosen countries (US by default;
--countries us,ca,gb) from the Radio Browser community directory, folds the
duplicate entries of one station into a station with several streams, then
attaches programme schedules where a public source has them: the BBC's own
schedule API for BBC radio, and epgshare01.online's XMLTV feeds for Audacy
stations in the US and the commercial and public stations in its UK and
Canadian feeds. Writes two files into web/data/:

  stations.json  station list with streams, logo, tags, country, region,
                 languages and which schedule it matched
  guide.json     programmes per station for a rolling window around now

Standard library only, so it runs anywhere Python 3.9+ does.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import gzip
import io
import json
import os
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Radio Browser runs a few mirrors; this lists the live ones. The fallback is
# used only when the list itself can't be fetched.
RB_SERVERS = "https://all.api.radio-browser.info/json/servers"
RB_FALLBACK = ["de1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info"]

# Countries to build, by ISO 3166 code. "uk" is accepted for "gb", since
# that's what the iptv-org playlists (and Signal TV) call it.
DEFAULT_COUNTRIES = "us"
ALIASES = {"uk": "gb"}

EPGSHARE = "https://epgshare01.online/epgshare01/epg_ripper_"
BBC_RMS = "https://rms.api.bbc.co.uk/v2/"

# XMLTV feeds per country: key -> (url, radio only). UK1 and CA2 are mostly
# TV, and TV and radio share names ("Gold", "CBC Calgary") and, in Canada,
# call signs (CFPL is a TV and a radio station), so in those only the channels
# that look like radio (RADIO_HINT) can be matched. AUDACY1 is all radio.
COUNTRY_FEEDS = {
    "us": {"audacy": (EPGSHARE + "AUDACY1.xml.gz", True)},
    "gb": {"uk1": (EPGSHARE + "UK1.xml.gz", False)},
    "ca": {"ca2": (EPGSHARE + "CA2.xml.gz", False)},
}
RADIO_HINT = re.compile(
    r"radio|\bfm\b|\d\s?fm\b|\b(?:5[3-9]\d|[6-9]\d\d|1[0-6]\d\d)\b(?!\s*(?:hd|\+))|heart|capital|smooth|classic fm|lbc|"
    r"talksport|absolute|kiss|magic|greatest hits|hits radio|\bnow (?:\d0s|rock)|scala|jazz|bfbs|wrn|stingray|kerrang",
    re.I)
# BBC radio schedules (and its "now playing" tracks) come from the API behind
# BBC Sounds, for stations in these countries.
BBC_COUNTRIES = {"gb"}

WINDOW_BEFORE_H = 3
WINDOW_AFTER_H = 30
DESC_MAX = 320
# BBC schedule days for today and later are fetched again after this long;
# earlier days don't change.
BBC_REFETCH_S = 3 * 3600

# Names the project, as Radio Browser asks, so the operators can see who is fetching.
UA = "signal-radio/1.0 (+https://github.com/alanheinen/radio-guide)"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def replace(tmp: Path, dst: Path) -> None:
    """Rename tmp over dst. Windows refuses while the server has dst open for
    a request, so retry for a few seconds there."""
    for attempt in range(50):
        try:
            tmp.replace(dst)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 49:
                raise
            time.sleep(0.1)


def fetch(url: str, timeout: int = 90, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404 or attempt == 2:
                raise
            log(f"  retry {url}: {e}")
        except Exception as e:  # noqa: BLE001 - retry any network error
            if attempt == 2:
                raise
            log(f"  retry {url}: {e}")
        time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


# Bitrate, codec and quality words that tell one stream of a station from
# another ("Radio Paradise (320k aac)"), dropped when telling stations apart.
QUALITY = re.compile(r"\b(aac\+?|aacplus|he-?aac|mp3|ogg|opus|flac|hls|\d+\s*k(?:bps)?|kbps|hq|lq|high|low|"
                     r"quality|mono|stereo|32|48|64|96|128|192|256|320)\b")


def norm(name: str) -> str:
    """Normalise a station name for loose matching across sources."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", s)
    s = s.replace("&", " and ").replace("+", " plus ")
    s = QUALITY.sub(" ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def clean_name(name: str) -> str:
    """Display name: whitespace collapsed, bitrate notes like "(128k)" dropped."""
    s = re.sub(r"\s+", " ", name).strip(" -|:")
    s = re.sub(r"\s*[\[(]\s*\d+\s*k(?:bps)?(?:\s+\w+)?\s*[\])]", "", s, flags=re.I)
    return s or name.strip()


def host_of(url: str) -> str:
    h = (urllib.parse.urlsplit(url).hostname or "") if url else ""
    return h[4:] if h.startswith("www.") else h


# ---------------------------------------------------------------- radio browser

def rb_servers() -> list[str]:
    try:
        names = list(dict.fromkeys(s["name"] for s in json.loads(fetch(RB_SERVERS, 20))))
    except Exception as e:  # noqa: BLE001
        log(f"  could not list Radio Browser servers ({e}); using built-in list")
        names = []
    random.shuffle(names)
    return names + [n for n in RB_FALLBACK if n not in names]


def rb_stations(servers: list[str], cc: str) -> list[dict]:
    """Every station Radio Browser's last check found working, for one country."""
    q = urllib.parse.urlencode({"countrycode": cc.upper(), "hidebroken": "true", "limit": 100000})
    err = None
    for host in servers:
        try:
            return json.loads(fetch(f"https://{host}/json/stations/search?{q}", 120))
        except Exception as e:  # noqa: BLE001 - try the next mirror
            err = e
            log(f"  {host}: {e}")
    raise RuntimeError(f"no Radio Browser server answered for {cc}: {err}")


LANG_ALIASES = {
    "american english": "english", "british english": "english", "engilsh": "english", "en": "english",
    "englisch": "english", "eng": "english", "espanol": "spanish", "español": "spanish", "castellano": "spanish",
    "es": "spanish", "francais": "french", "français": "french", "fr": "french", "deutsch": "german",
}


def languages(s: str) -> list[str]:
    out = []
    for part in re.split(r"[,;/]", s or ""):
        p = LANG_ALIASES.get(part.strip().lower(), part.strip().lower())
        if p and len(p) < 30 and p not in out:
            out.append(p)
    return out


def tags(s: str) -> list[str]:
    out = []
    for part in (s or "").split(","):
        p = re.sub(r"\s+", " ", part).strip().lower()
        if p and len(p) < 32 and p not in out:
            out.append(p)
    return out


BBC_SID = re.compile(r"\b(bbc_[a-z0-9_]+?)(?:[./?&-]|$)")


def stream_rank(s: dict):
    """Secure first, then a sensible bitrate (FLAC and 320k last among the
    rest, since they cost a phone far more for little gain)."""
    br = s.get("br") or 0
    return (not s["url"].startswith("https"), s.get("codec") == "FLAC", -min(br, 192), br)


# ---------------------------------------------------------------- xmltv

def xmltime(s: str) -> int:
    """XMLTV timestamp -> unix seconds."""
    s = s.strip()
    dt = datetime.strptime(s[:14], "%Y%m%d%H%M%S")
    off = s[14:].strip()
    secs = int(dt.replace(tzinfo=timezone.utc).timestamp())
    if off:
        sign = 1 if off[0] == "+" else -1
        secs -= sign * (int(off[1:3]) * 3600 + int(off[3:5]) * 60)
    return secs


def short(desc: str) -> str:
    desc = (desc or "").strip()
    return desc[:DESC_MAX].rsplit(" ", 1)[0] + "…" if len(desc) > DESC_MAX else desc


def prog(start: int, stop: int, title: str, sub: str = "", desc: str = "", cat: str = "") -> list:
    """One programme as the page reads it: [start, stop (minutes), title, subtitle, description, category]."""
    if sub == title:
        sub = ""
    p = [start // 60, stop // 60, title]
    extra = [sub, short(desc), cat]
    while extra and not extra[-1]:
        extra.pop()
    return p + extra


def parse_xmltv(src, lo: int, hi: int):
    """Return ({id: [display names]}, {id: [programmes]}) inside [lo, hi]."""
    names: dict[str, list[str]] = {}
    progs: dict[str, list] = {}
    for _, el in ET.iterparse(src, events=("end",)):
        if el.tag == "channel":
            names[el.get("id")] = [d.text or "" for d in el.findall("display-name")]
            el.clear()
        elif el.tag == "programme":
            try:
                start, stop = xmltime(el.get("start")), xmltime(el.get("stop"))
            except (TypeError, ValueError):
                el.clear()
                continue
            if stop >= lo and start <= hi:
                progs.setdefault(el.get("channel"), []).append(prog(
                    start, stop, (el.findtext("title") or "").strip(), (el.findtext("sub-title") or "").strip(),
                    el.findtext("desc") or "", (el.findtext("category") or "").strip()))
            el.clear()
    for v in progs.values():
        v.sort(key=lambda p: p[0])
    return names, progs


def load_feed(key: str, url: str, cache_dir: Path, lo: int, hi: int):
    """Download a feed only when it has changed since the copy kept from the
    last build (they change about daily; the Canadian one is ~7 MB), then
    parse the kept copy."""
    path = cache_dir / f"{key}.xml.gz"
    meta = cache_dir / f"{key}.lastmod"
    h = {"User-Agent": UA}
    if path.exists() and meta.exists():
        h["If-Modified-Since"] = meta.read_text().strip()
    how = "cached"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=180) as r:
            tmp = path.with_name(f".{path.name}.tmp")
            with open(tmp, "wb") as f:
                while chunk := r.read(1 << 16):
                    f.write(chunk)
            replace(tmp, path)
            meta.write_text(r.headers.get("Last-Modified") or "")
            how = "downloaded"
    except urllib.error.HTTPError as e:
        if e.code != 304:
            if not path.exists():
                raise
            log(f"  {key}: {e}; using the kept copy")
    except Exception as e:  # noqa: BLE001
        if not path.exists():
            raise
        log(f"  {key}: {e}; using the kept copy")
    with gzip.open(path) as f:
        names, progs = parse_xmltv(f, lo, hi)
    return names, progs, how


# Call signs, for matching "KMOX NewsRadio 1120" to the feed's "104.1 FM KMOX".
# Four letters only, in capitals in both names, so ordinary words don't count.
# Not after a hyphen ("K-WAVE"), and not words that brands use ("The WAVE").
CALL = {"us": re.compile(r"(?<![\w-])([KW][A-Z]{3})(?:-(?:FM|AM))?\b"),
        "ca": re.compile(r"(?<![\w-])(C[A-Z]{3})(?:-(?:FM|AM))?\b")}
CALL_WORDS = {"WAVE", "WILD", "WOLF", "KISS", "KOOL", "WARM", "WIND", "WORD", "WORK", "WEST", "KIDS", "KING",
              "WHAT", "WELL", "WIRE", "WOOD", "WISE", "WILL", "WITH", "WHEN", "WHOM", "CLUB", "CITY", "COOL",
              "CAFE", "CALM", "CARE", "CHIL", "COMO"}


AUDACY_URL = re.compile(r"/audacy-([a-z]{4})(?:am|fm)")


def call_signs(cc: str, name: str, urls: tuple = ()) -> set[str]:
    """Call signs in a name, and in Audacy stream URLs (".../audacy-kroqfmaac-imc")."""
    rx = CALL.get(cc)
    out = set(rx.findall(name)) - CALL_WORDS if rx else set()
    return out | {m.group(1).upper() for u in urls for m in [AUDACY_URL.search(u)] if m}


# ---------------------------------------------------------------- bbc

class BBC:
    """BBC radio networks, services and schedules from the API behind BBC
    Sounds. Not a documented public API, so everything here is optional: if
    it fails, BBC stations play without schedules."""

    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self.services: dict[str, dict] = {}  # service id -> {network, title, logo}
        self.by_name: dict[str, str] = {}    # norm(name) -> default service id
        try:
            self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cache = {}

    def load(self) -> None:
        d = json.loads(fetch(BBC_RMS + "networks?limit=100", 30))
        for n in d.get("data", []):
            # The network list carries no logo; BBC Sounds' own artwork is keyed by network.
            logo = f"https://sounds.files.bbci.co.uk/3.12.0/networks/{n['id']}/blocks-colour_600x600.png"
            for s in n.get("services") or []:
                self.services[s["id"]] = {"network": n["id"], "title": n.get("long_title") or n.get("short_title") or s["id"], "logo": logo}
            default = n.get("default_service_id")
            if default:
                for t in (n.get("long_title"), "BBC " + (n.get("short_title") or "")):
                    if t and norm(t):
                        self.by_name.setdefault(norm(t), default)

    def schedule(self, sid: str, lo: int, hi: int) -> list:
        """Programmes for one service in [lo, hi], a day at a time."""
        out: dict[int, list] = {}
        now = time.time()
        day = datetime.fromtimestamp(lo, timezone.utc).date() - timedelta(days=1)
        last = datetime.fromtimestamp(hi, timezone.utc).date()
        today = datetime.now(timezone.utc).date()
        while day <= last:
            key = f"{sid}/{day.isoformat()}"
            hit = self.cache.get(key)
            if not hit or (day >= today and now - hit["at"] > BBC_REFETCH_S):
                try:
                    d = json.loads(fetch(f"{BBC_RMS}experience/inline/schedules/{sid}/{day.isoformat()}", 30))
                    items = []
                    for mod in d.get("data", []):
                        for b in mod.get("data") or []:
                            if b.get("type") != "broadcast_summary":
                                continue
                            start = int(datetime.fromisoformat(b["start"].replace("Z", "+00:00")).timestamp())
                            stop = int(datetime.fromisoformat(b["end"].replace("Z", "+00:00")).timestamp())
                            t = b.get("titles") or {}
                            syn = b.get("synopses") or {}
                            # The secondary title is often just the date ("16/10/2026").
                            sub = "" if re.fullmatch(r"[\d/.:\s-]+(?:GMT|BST)?", t.get("secondary") or "") else t.get("secondary") or ""
                            items.append(prog(start, stop, t.get("primary") or "", sub,
                                              syn.get("short") or syn.get("medium") or ""))
                    hit = self.cache[key] = {"at": now, "items": items}
                except Exception as e:  # noqa: BLE001
                    log(f"  bbc {key}: {e}")
                    hit = hit or {"items": []}
            for p in hit["items"]:
                if p[1] * 60 >= lo and p[0] * 60 <= hi:
                    out[p[0]] = p
            day += timedelta(days=1)
        return [out[k] for k in sorted(out)]

    def save(self, keep_after: int) -> None:
        cutoff = datetime.fromtimestamp(keep_after, timezone.utc).date() - timedelta(days=2)
        self.cache = {k: v for k, v in self.cache.items() if k.rpartition("/")[2] >= cutoff.isoformat()}
        tmp = self.cache_path.with_name(f".{self.cache_path.name}.tmp")
        tmp.write_text(json.dumps(self.cache, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        replace(tmp, self.cache_path)


# ---------------------------------------------------------------- build

def main() -> int:
    # A Windows console's code page can't print every station name.
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "web" / "data"))
    ap.add_argument("--no-schedules", action="store_true", help="skip programme data")
    ap.add_argument("--countries", default=os.environ.get("COUNTRIES") or DEFAULT_COUNTRIES,
                    help="comma-separated ISO country codes, e.g. us,ca,gb (default: $COUNTRIES or us)")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    countries = list(dict.fromkeys(ALIASES.get(c, c) for c in (c.strip().lower() for c in args.countries.split(",")) if c))
    bad = [c for c in countries if not re.fullmatch(r"[a-z]{2}", c)]
    if bad or not countries:
        ap.error(f"--countries takes two-letter country codes like us,ca,gb (got {args.countries!r})")

    now = int(time.time())
    lo, hi = now - WINDOW_BEFORE_H * 3600, now + WINDOW_AFTER_H * 3600

    log(f"stations for {', '.join(countries)}…")
    servers = rb_servers()
    raw: list[dict] = []
    country_names: dict[str, str] = {}
    for cc in countries:
        got = rb_stations(servers, cc)
        log(f"  {cc}: {len(got)} working entries")
        for s in got:
            country_names.setdefault(cc, s.get("country") or cc.upper())
        raw += [{**s, "_cc": cc} for s in got]

    bbc = BBC(out / "bbc-cache.json")
    if not args.no_schedules and BBC_COUNTRIES & set(countries):
        try:
            bbc.load()
            log(f"  bbc: {len(bbc.services)} services")
        except Exception as e:  # noqa: BLE001
            log(f"  bbc: networks unavailable ({e}); BBC stations get no schedules")

    log("grouping…")
    # One station per BBC service, or per name and homepage, within a country:
    # Radio Browser lists most stations several times, one entry per stream.
    stations: dict[str, dict] = {}
    for s in sorted(raw, key=lambda s: -(s.get("clickcount") or 0)):
        url = (s.get("url_resolved") or s.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        cc = s["_cc"]
        m = BBC_SID.search(url)
        sid = m.group(1) if m and m.group(1) in bbc.services else ""
        n = norm(s.get("name") or "")
        if not sid and n in bbc.by_name and "bbc" in n:
            sid = bbc.by_name[n]
        key = f"bbc:{sid}" if sid else f"{cc}:{n}:{host_of(s.get('homepage') or '')}"
        if not sid and not n:
            continue
        st = stations.get(key)
        if st is None:
            info = bbc.services.get(sid, {})
            st = stations[key] = {
                # Stable across rebuilds (favorites and "last station" are
                # stored by id), unlike the uuid of whichever entry is most
                # popular this hour.
                "id": key,
                "name": info.get("title") or clean_name(s.get("name") or ""),
                "logo": info.get("logo") or "",
                "cc": cc,
                "region": (s.get("state") or "").strip(),
                "langs": [],
                "tags": [],
                "site": (s.get("homepage") or "").strip(),
                "pop": 0,
                "streams": [],
                "epg": None,
            }
            if sid:
                st["bbc"] = sid
        st["pop"] += (s.get("clickcount") or 0) + (s.get("votes") or 0) // 10
        if not st["logo"] and (s.get("favicon") or "").startswith(("http://", "https://")):
            st["logo"] = s["favicon"].strip()
        if not st["region"] and s.get("state"):
            st["region"] = s["state"].strip()
        for l in languages(s.get("language") or ""):
            if l not in st["langs"]:
                st["langs"].append(l)
        for t in tags(s.get("tags") or ""):
            if t not in st["tags"] and len(st["tags"]) < 12:
                st["tags"].append(t)
        if any(x["url"] == url for x in st["streams"]) or len(st["streams"]) >= 8:
            continue
        stream = {"url": url}
        codec = (s.get("codec") or "").upper()
        if codec and codec != "UNKNOWN":
            stream["codec"] = codec
        if s.get("bitrate"):
            stream["br"] = s["bitrate"]
        if s.get("hls"):
            stream["hls"] = 1
        st["streams"].append(stream)
    log(f"  {len(raw)} entries -> {len(stations)} stations")

    guide: dict[str, list] = {}
    if not args.no_schedules:
        log("schedules…")
        bbc_sids = sorted({st["bbc"] for st in stations.values() if st.get("bbc")})
        if bbc_sids:
            with cf.ThreadPoolExecutor(6) as ex:
                sched = dict(zip(bbc_sids, ex.map(lambda sid: bbc.schedule(sid, lo, hi), bbc_sids)))
            for st in stations.values():
                if sched.get(st.get("bbc")):
                    st["epg"] = f"bbc:{st['bbc']}"
                    guide[st["id"]] = sched[st["bbc"]]
            bbc.save(lo)
            log(f"  bbc: {sum(1 for v in sched.values() if v)} of {len(bbc_sids)} services with schedules")

        cache_dir = out / "feeds"
        cache_dir.mkdir(exist_ok=True)
        feeds = [(cc, key, url, radio) for cc in countries for key, (url, radio) in COUNTRY_FEEDS.get(cc, {}).items()]

        def load(item):
            cc, key, url, _ = item
            try:
                return item, load_feed(key, url, cache_dir, lo, hi)
            except Exception as e:  # noqa: BLE001
                log(f"  {key}: failed ({e})")
                return item, ({}, {}, "failed")

        with cf.ThreadPoolExecutor(3) as ex:
            loaded = list(ex.map(load, feeds))
        for (cc, key, _, radio), (names, progs, how) in loaded:
            # Exact names first, then call signs that only one feed channel has.
            by_name: dict[str, str] = {}
            by_call: dict[str, set] = {}
            for cid, dns in names.items():
                if not progs.get(cid) or not (radio or any(RADIO_HINT.search(t) for t in [cid, *dns])):
                    continue
                for dn in dns:
                    if len(norm(dn)) > 3:
                        by_name.setdefault(norm(dn), cid)
                    for c in call_signs(cc, dn):
                        by_call.setdefault(c, set()).add(cid)
            hits = 0
            for st in stations.values():
                if st["cc"] != cc or st["epg"]:
                    continue
                cid = by_name.get(norm(st["name"]))
                if not cid:
                    urls = tuple(x["url"] for x in st["streams"])
                    found = {i for c in call_signs(cc, st["name"], urls) for i in by_call.get(c, ()) if len(by_call[c]) == 1}
                    cid = found.pop() if len(found) == 1 else None
                if cid:
                    st["epg"] = f"{key}:{cid}"
                    guide[st["id"]] = progs[cid]
                    hits += 1
            log(f"  {key}: {len(progs)} channels with programmes ({how}), {hits} stations matched")
        # Feeds no longer built (a country taken out of COUNTRIES).
        wanted = {f"{key}.{ext}" for _, key, _, _ in feeds for ext in ("xml.gz", "lastmod")}
        for f in cache_dir.iterdir():
            if f.name not in wanted:
                f.unlink(missing_ok=True)

    station_list = []
    for st in stations.values():
        st["streams"].sort(key=stream_rank)
        station_list.append(st)
    station_list.sort(key=lambda st: -st["pop"])

    in_country: dict[str, int] = {}
    in_lang: dict[str, int] = {}
    for st in station_list:
        in_country[st["cc"]] = in_country.get(st["cc"], 0) + 1
        for l in st["langs"]:
            in_lang[l] = in_lang.get(l, 0) + 1

    built = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def write(name: str, obj) -> None:
        # Write then rename, so a server reading the directory never sees half
        # a file. A gzipped copy goes alongside for the server to send as is.
        body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        for fname, data in ((name, body), (name + ".gz", gzip.compress(body, 6))):
            tmp = out / f".{fname}.tmp"
            tmp.write_bytes(data)
            replace(tmp, out / fname)

    write("stations.json", {
        "built": built,
        "countries": [{"id": cc, "name": country_names.get(cc, cc.upper()), "count": in_country[cc]}
                      for cc in countries if cc in in_country],
        "languages": [{"id": l, "name": l.title(), "count": n} for l, n in sorted(in_lang.items(), key=lambda kv: -kv[1])],
        "stations": station_list,
    })
    write("guide.json", {"built": built, "from": lo // 60, "to": hi // 60, "guide": guide})

    log(f"done: {len(station_list)} stations, {len(guide)} with schedules -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
