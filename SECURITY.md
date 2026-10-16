# Security

## Deploying safely

Signal Radio is meant for your own machine or home network. Never expose it
to the internet.

Its stream proxy fetches whatever URL it's asked to. On a public address,
that makes it an open relay: anyone could send traffic through your
connection, and that traffic would come from your IP address. There's no
authentication, by design, since it's meant for a trusted network.

What's already in place:

- **Local by default.** Every install method listens on the local machine
  only until you change one setting.
- **No LAN targets.** The proxy and the now-playing lookups refuse URLs that
  resolve to private, loopback, link-local, reserved or multicast addresses,
  including after redirects. They can't be pointed at your router, your other
  devices or the host itself.
- **Now playing is not a fetcher.** `/api/nowplaying` takes a station id and
  only opens streams in the built station list. Lookups are cached for 20
  seconds per stream, so repeated requests don't multiply upstream traffic.
- **Minimal privileges:**
  - The container image runs as an unprivileged user with a read-only root
    filesystem.
  - The Kubernetes manifests meet Pod Security "restricted".
  - The systemd unit runs as a throwaway user in a tight sandbox.
- **No credentials.** Signal Radio holds none and has no accounts or admin
  interface.

To reach it from outside your home, use a VPN to your network (WireGuard,
Tailscale) rather than opening a port.

## What it connects to

- **The build:** Radio Browser (`all.api.radio-browser.info` and its mirrors),
  the BBC (`rms.api.bbc.co.uk`) and `epgshare01.online`. It identifies itself
  with a User-Agent naming this project.
- **The proxy and now playing:** whatever stream hosts you listen to, and
  `rms.api.bbc.co.uk` for BBC tracks.
- **The page:** loads hls.js from `cdnjs.cloudflare.com`, fonts from Google
  Fonts, logos and cover art from wherever the stations point, and Google's
  Cast library (`gstatic.com`) in Chrome and Edge.

Signal Radio sends no analytics or telemetry. The server keeps the last few
song titles per station in memory for "recently played"; it doesn't record
who listened. Your favorites and last station stay in your browser's storage.

## Reporting a vulnerability

Please report security problems privately, through
[GitHub's private vulnerability reporting](https://github.com/alanheinen/radio-guide/security/advisories/new),
not in a public issue. Include what you found and how to reproduce it.
