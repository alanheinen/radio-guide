# Signal Radio

A self-hosted radio guide and player for the stations in the
[Radio Browser](https://www.radio-browser.info/) community directory, with
programme schedules where public ones exist and the song playing now for the
rest. The sibling of [Signal TV](https://github.com/alanheinen/iptv-epg).

## Why

Radio Browser lists tens of thousands of internet radio stations, from the BBC
and public radio to one-person Icecast streams. A directory doesn't tell you
what's on, though, many streams won't play on an HTTPS page, and the same
station is often listed five times, once per bitrate.

Signal Radio turns that list into something closer to a radio guide:

- **A guide grid.** The same scrolling timeline as Signal TV, with a live "now"
  line. BBC stations get the BBC's own schedules; UK commercial stations (Heart,
  Capital, Classic FM, LBC, Virgin, talkSPORT…), some Canadian ones and the few
  Audacy stations Radio Browser lists get XMLTV listings.
- **What's playing now.** The server reads the song title most Icecast and
  Shoutcast streams carry (browsers can't), shows cover art when the stream
  sends it, and keeps a short "recently played" list. BBC stations show the
  BBC's own track data.
- **A player that copes.** One station, several streams: it falls back
  through them when one fails, and a small built-in proxy plays plain-HTTP
  streams on an HTTPS page and old Shoutcast servers browsers refuse.
- **Nothing to configure.** Pick the countries; the data rebuilds itself every
  hour.

It doesn't host or re-broadcast anything. Every stream comes from the
station's own public link, played from your own machine.

## Features

- Every station Radio Browser's last check found working, for the countries
  you choose, with duplicate entries folded into one station with several
  streams (US: ~7,400 entries become ~6,500 stations)
- Schedules from the [BBC](https://www.bbc.co.uk/sounds) (all 60-odd networks
  and local stations) and [epgshare01](https://epgshare01.online/) (UK1, CA2
  and AUDACY1 feeds), 3 hours back to about 30 hours ahead
- Now playing from the stream's ICY metadata, HLS ID3 tags, or the BBC
- Search across station names, genres and show titles; filters for country,
  region, language and genre; "has schedule" and favorites
- Plays MP3, AAC, Ogg/Opus and HLS ([hls.js](https://github.com/video-dev/hls.js)),
  with stream fallback and a copy button on every row for VLC or mpv
- Media keys and lock-screen controls (next/previous station), volume memory
- Casting to Chromecast and Nest speakers from Chrome or Edge
- Light and dark themes, keyboard control, and a layout that works on phones
- A TV layout driven by the remote, with a full-screen now-playing view
- Standard-library Python only: no packages to install, ~50 MiB idle

## Quick start

With Docker:

```bash
git clone https://github.com/alanheinen/radio-guide.git
cd radio-guide
docker compose up -d
```

Then open <http://localhost:8080>. The first build takes a few seconds.

Or with nothing but Python 3.9+:

```bash
python3 scripts/serve.py --data data --refresh 1
```

## Install

Every method runs the same server, `scripts/serve.py`, which serves the page,
runs the stream proxy and now-playing lookups, and rebuilds the station data
at startup and every hour. Each listens on the machine it runs on only, until
you change one setting.

> **Keep it off the internet.** Serve it on your own network at most. Exposed
> publicly, the stream proxy is an open relay for anyone's traffic. See
> [SECURITY.md](SECURITY.md).

| Method | Needs | Open it to your network with |
| --- | --- | --- |
| Docker | Docker with Compose | `ports: "8080:8080"` in `docker-compose.yml` |
| Kubernetes | a cluster and `kubectl` | an Ingress, or a Service type of your choice |
| Linux | Python 3.9+ and systemd | `HOST=0.0.0.0` in `/etc/signal-radio.env` |

Allow 256 MiB of memory: about 50 MiB idle, peaking near 80 MiB for the US
during the hourly rebuild (140 MiB for `us,ca,gb`).

### Docker

```bash
docker compose up -d                              # start
docker compose pull && docker compose up -d       # update
docker compose down                               # stop
```

[`docker-compose.yml`](docker-compose.yml) runs the published image,
`ghcr.io/alanheinen/radio-guide:latest`, read-only, as UID 1000, with no
capabilities. Set `COUNTRIES` there. Each build on `main` is also tagged
`sha-<commit>`; pin one of those, or its digest, if you don't want updates to
arrive on their own.

### Kubernetes

```bash
kubectl apply -k deploy/kubernetes
kubectl -n signal-radio port-forward svc/signal-radio 8080:80     # http://localhost:8080
```

[`deploy/kubernetes`](deploy/kubernetes) is a Kustomize base: a namespace with
Pod Security "restricted", a one-replica Deployment (non-root, read-only root
filesystem, readiness held until the stations are built) and a Service. Set
`COUNTRIES` in `deployment.yaml`, pin the image in `kustomization.yaml`, and
fill in [`ingress.yaml`](deploy/kubernetes/ingress.yaml) to reach it from your
network. Casting needs the page on HTTPS.

Keep it to one replica: the "recently played" lists live in the pod.

### Linux (systemd)

```bash
git clone https://github.com/alanheinen/radio-guide.git
sudo radio-guide/deploy/linux/install.sh                 # install or update
sudo radio-guide/deploy/linux/install.sh --uninstall     # remove
```

The app goes to `/opt/signal-radio`, runs as a throwaway system user in a
tight sandbox, and keeps its data in `/var/lib/signal-radio`. Settings live in
`/etc/signal-radio.env` (`COUNTRIES`, `HOST`, `PORT`); logs are in
`journalctl -u signal-radio`.

### From a checkout

```bash
python3 scripts/build.py --countries us     # writes web/data/ (a few seconds)
python3 scripts/serve.py                    # http://127.0.0.1:8080
```

## Configuration

| Setting | Default | What it does |
| --- | --- | --- |
| `COUNTRIES` / `--countries` | `us` | ISO country codes to build, comma-separated. `uk` works for `gb`. |
| `--host` | `127.0.0.1` | Address to listen on. `0.0.0.0` for your whole network. |
| `--port` | `8080` | Port to listen on. |
| `--data` | `web/data` | Where the station data and feed cache are kept. |
| `--refresh` | `0` (never) | Rebuild every N hours. Every install method uses `1`. |
| `--log` | console | Append output to a file, rotated at about 5 MB. |

### Countries

Any country Radio Browser has works. How many stations get schedules depends
on the sources behind it:

| Country | Schedule sources | Stations | With schedules |
| --- | --- | --- | --- |
| `us` | epgshare01 AUDACY1 | ~6,500 | a handful (most Audacy stations aren't in Radio Browser) |
| `ca` | epgshare01 CA2 | ~1,400 | ~7 |
| `gb` | BBC, epgshare01 UK1 | ~1,900 | ~85 |

Everywhere else, stations play with now-playing titles but no schedules.

## Using it

- **Listen:** click a station or a programme. If a stream fails, the player
  moves on to the station's next stream and says why when none play.
- **Find something:** search matches station names, genres, regions and show
  titles across the whole guide.
- **Favorites:** the star in the panel, or `F`.
- **Copy a stream:** hover a row and use the copy button.
- **Cast:** in Chrome or Edge, the cast button sends the station to a
  Chromecast or Nest speaker.

| Key | Action |
| --- | --- |
| `Space` | Play / stop |
| `[` / `]` | Previous / next station |
| `↑` / `↓` | Move through the station list |
| `←` / `→` | Scroll the guide by half an hour |
| `Enter` | Tune the selected station |
| `/` | Search |
| `F` | Toggle favorite |
| `N` | Jump to now |

### On a TV

Open the page with `?tv=1` (for example `http://radio.example.lan/?tv=1`) and it
switches to a layout for a TV and its remote; `?tv=0` switches back. The
choice is remembered, and TV browsers (Android TV, Google TV, Fire TV, Tizen,
webOS) get it without asking.

- **The guide:** `↑` `↓` change station, `←` `→` move through the schedule a
  programme at a time, and OK tunes. OK on the station already playing fills
  the screen with it.
- **Full screen:** `↑` `↓` or the remote's channel buttons change station,
  OK plays or stops, and Back returns to the guide.
- **Everything else:** move up off the top of the guide to reach the
  favorite star, the genres and the filters; Back returns to the guide.
- **Remote keys:** play/pause, channel up/down, next/previous and the number
  keys (type a station number) work everywhere. Back from the guide goes to
  the station playing; from there, it leaves.

An app that wraps the page in a web view can call `window.signalBack()` from
its Back button: it returns `false` when the page has nothing to go back
from, which is the app's cue to exit.

## How it works

```
Radio Browser ───────┐
BBC schedules ───────┼──► build.py ──► stations.json ──┐
XMLTV feeds ─────────┘     (hourly)    guide.json      ├──► serve.py ──► browser
                                                       │    (page, data,
          stream hosts, BBC ◄── proxy, now playing ◄───┘     proxy, now playing)
```

`scripts/build.py` downloads the working stations for each country and folds
Radio Browser's duplicates into stations: by BBC service (the id is in every
BBC stream URL), otherwise by name, with bitrate and codec words removed, and
homepage. It then matches stations to schedules, strictly, because a wrong
schedule is worse than none:

1. BBC stations, by service id
2. exact names in the XMLTV feeds; in the UK and Canadian feeds, which are
   mostly TV, only channels that look like radio, since TV and radio share
   names ("Gold") and, in Canada, call signs
3. four-letter call signs that only one feed channel has

`scripts/serve.py` serves the page and data, proxies the streams that need
it, and answers now-playing questions. It reads a stream's ICY metadata by
opening it with `Icy-MetaData: 1` and reading up to the first metadata block
(typically 8 to 32 KB of audio, thrown away). Answers are cached for 20
seconds, so any number of listeners on one station cost one lookup, and only
streams in the station list can be asked about.

## Limits

- Streams are third-party and change constantly. Radio Browser's checks are
  daily, so some stations listed as working won't be.
- Most stations have no schedule: no public source covers US commercial or
  public radio (NPR stations publish theirs only on their own sites).
- The BBC data comes from the API behind BBC Sounds, which isn't documented
  for public use and can change without notice. BBC streams may be
  geo-restricted outside the UK.
- "Recently played" only covers time when someone was listening through this
  server, except for the BBC, which keeps its own.

## Credits

- [Radio Browser](https://www.radio-browser.info/) for the station directory
- the [BBC](https://www.bbc.co.uk/sounds) and [epgshare01](https://epgshare01.online/)
  for schedules
- [hls.js](https://github.com/video-dev/hls.js) for HLS playback

## License

[MIT](LICENSE). The station data, schedules and streams belong to their
respective owners and are subject to their own terms.
