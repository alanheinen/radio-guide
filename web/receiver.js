/* Signal Radio — Cast receiver (Nest Hub, Chromecast, Google TV, speakers).
   The sender casts a station id, not a stream. The receiver looks the
   station up in this server's data and plays it (HTTPS audio directly, HLS
   and plain HTTP through the proxy), moving on to the station's next stream
   if one fails. Next and previous (the Hub's buttons, the phone's controls,
   "Hey Google, next") surf the sender's station list; the title shows the
   song playing, from /api/nowplaying, or the programme; and a Hub shows the
   sender's favorites to tap. */
(() => {
  "use strict";

  const ctx = cast.framework.CastReceiverContext.getInstance();
  const player = ctx.getPlayerManager();
  const M = cast.framework.messages;
  const UI = cast.framework.ui;
  const S = { byId: new Map(), order: [], list: null, favs: [], guide: {}, np: null };

  const nowMin = () => Date.now() / 60000;
  const onNow = (c) => (S.guide[c.id] || []).find((p) => p[0] <= nowMin() && p[1] > nowMin());
  const TYPES = { MP3: "audio/mpeg", AAC: "audio/aac", "AAC+": "audio/aac", OGG: "audio/ogg", OPUS: "audio/ogg", FLAC: "audio/flac" };
  const isHls = (s) => s.hls || /\.m3u8(\?|$)/i.test(s.url);

  async function loadStations() {
    const d = await (await fetch("data/stations.json", { cache: "no-cache" })).json();
    d.stations.forEach((c, i) => { c.num = i + 1; S.byId.set(c.id, c); });
    S.order = d.stations.map((c) => c.id);
  }

  async function loadGuide() {
    try { S.guide = (await (await fetch("data/guide.json", { cache: "no-cache" })).json()).guide || {}; }
    catch { /* no schedules */ }
  }

  // HTTPS audio plays directly (an audio element needs no CORS); HLS needs
  // CORS for MSE and plain HTTP is blocked, so those go through the proxy.
  function stream(s) {
    const direct = s.url.startsWith("https:") && !isHls(s);
    return {
      url: direct ? s.url : new URL(`proxy?${new URLSearchParams({ u: s.url })}`, location.href).href,
      type: isHls(s) ? "application/x-mpegurl" : TYPES[s.codec] || "audio/mpeg",
    };
  }

  // The song from the stream when there is one, else the programme, else the station.
  function metadata(c) {
    const md = new M.MusicTrackMediaMetadata();
    const np = S.np && S.np.id === c.id ? S.np : {};
    const p = onNow(c);
    md.title = np.title || (p && p[2]) || c.name;
    md.artist = np.title ? np.artist || c.name : c.name;
    md.albumName = np.title && p ? p[2] : c.tags.slice(0, 3).join(", ");
    const art = np.art || c.logo;
    if (art) md.images = [new M.Image(art)];
    return md;
  }

  function fill(m, c, i = 0) {
    const { url, type } = stream(c.streams[i]);
    m.contentId = c.id;
    m.contentUrl = url;
    m.contentType = type;
    m.streamType = M.StreamType.LIVE;
    m.customData = { stream: i };
    m.metadata = metadata(c);
    return m;
  }

  // A cast media item names a station by contentId, or by entity when it
  // comes from the Hub's favorites. Anything else (a plain URL) plays as is.
  function resolve(m) {
    if (!m) return false;
    const c = S.byId.get(m.entity) || S.byId.get(m.contentId);
    if (!c) return Boolean(m.contentUrl || /^https?:/.test(m.contentId || ""));
    const i = (m.customData && m.customData.stream) || 0;
    fill(m, c, Math.min(i, c.streams.length - 1));
    return true;
  }

  const item = (c) => {
    const it = new M.QueueItem();
    it.media = fill(new M.MediaInformation(), c);
    return it;
  };

  const current = () => {
    const m = player.getMediaInformation();
    return m && S.byId.get(m.contentId);
  };

  function neighbour(c, d) {
    const list = S.list && S.list.includes(c.id) ? S.list : S.order;
    const i = list.indexOf(c.id);
    return S.byId.get(list[(i + d + list.length) % list.length]);
  }

  // An endless queue: next and previous ask for one more station each way.
  class Surf extends cast.framework.QueueBase {
    initialize(req) {
      resolve(req.media);
      const q = new M.QueueData();
      const it = new M.QueueItem();
      it.media = req.media;
      q.items = [it];
      q.startIndex = 0;
      return q;
    }

    nextItems() {
      const c = current();
      return c ? [item(neighbour(c, 1))] : [];
    }

    prevItems() {
      const c = current();
      return c ? [item(neighbour(c, -1))] : [];
    }
  }

  player.setMessageInterceptor(M.MessageType.LOAD, async (req) => {
    await ready;
    const extra = req.customData || {};
    if (Array.isArray(extra.list)) S.list = extra.list.filter((id) => S.byId.has(id));
    if (Array.isArray(extra.favs)) { S.favs = extra.favs.filter((id) => S.byId.has(id)); browse(); }
    if (!resolve(req.media)) {
      const err = new M.ErrorData(M.ErrorType.LOAD_FAILED);
      err.reason = M.ErrorReason.INVALID_PARAMS;
      return err;
    }
    return req;
  });

  // A stream that fails moves on to the station's next one.
  player.addEventListener(cast.framework.events.EventType.ERROR, () => {
    const m = player.getMediaInformation();
    const c = m && S.byId.get(m.contentId);
    const i = ((m && m.customData && m.customData.stream) || 0) + 1;
    if (!c || i >= c.streams.length) return;
    const req = new M.LoadRequestData();
    req.media = fill(new M.MediaInformation(), c, i);
    req.autoplay = true;
    player.load(req);
  });

  player.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, () => {
    player.addSupportedMediaCommands(M.Command.QUEUE_NEXT | M.Command.QUEUE_PREV, true);
    S.np = null;
    poll();
  });

  // What's playing: the server reads the stream's titles (or the BBC's),
  // cached for 20 seconds, so asking every 15 costs little.
  let pollTimer = 0;
  async function poll() {
    clearTimeout(pollTimer);
    const m = player.getMediaInformation();
    const c = m && S.byId.get(m.contentId);
    if (!c) return;
    try {
      const s = (m.customData && m.customData.stream) || 0;
      const r = await fetch(`api/nowplaying?${new URLSearchParams({ id: c.id, s })}`, { cache: "no-store" });
      if (r.ok) S.np = { ...(await r.json()), id: c.id };
    } catch { /* keep what we had */ }
    const md = metadata(c);
    if (!m.metadata || m.metadata.title !== md.title || m.metadata.artist !== md.artist) {
      m.metadata = md;
      player.setMediaInformation(m, true);
    }
    pollTimer = setTimeout(poll, 15000);
  }

  // On a Hub: previous and next station buttons, and favorites to tap.
  let controls = null;
  try {
    controls = UI.Controls.getInstance();
    controls.clearDefaultSlotAssignments();
    controls.assignButton(UI.ControlsSlot.SLOT_PRIMARY_1, UI.ControlsButton.QUEUE_PREV);
    controls.assignButton(UI.ControlsSlot.SLOT_PRIMARY_2, UI.ControlsButton.QUEUE_NEXT);
  } catch { controls = null; /* no touch screen */ }

  function browse() {
    if (!controls) return;
    const ids = S.favs.length ? S.favs : (S.list || S.order).slice(0, 30);
    const bc = new UI.BrowseContent();
    bc.title = S.favs.length ? "Favorites" : "Stations";
    bc.targetAspectRatio = UI.BrowseImageAspectRatio.SQUARE_1_TO_1;
    bc.items = ids.slice(0, 30).map((id) => {
      const c = S.byId.get(id), p = onNow(c);
      const sub = p ? p[2] : [c.region, c.tags[0]].filter(Boolean).join(" · ") || `No. ${c.num}`;
      const b = new UI.BrowseItem(c.id, c.name, sub, c.logo ? new M.Image(c.logo) : undefined);
      b.imageType = UI.BrowseImageType.RADIO_STATION;
      return b;
    });
    controls.setBrowseContent(bc);
  }

  const ready = loadStations();
  ready.then(browse);
  loadGuide();
  setInterval(loadGuide, 30 * 60000);

  const opts = new cast.framework.CastReceiverOptions();
  opts.queue = new Surf();
  opts.useShakaForHls = true;
  opts.supportedCommands = M.Command.ALL_BASIC_MEDIA | M.Command.QUEUE_NEXT | M.Command.QUEUE_PREV;
  opts.uiConfig = Object.assign(UI.UiConfig ? new UI.UiConfig() : {}, { touchScreenOptimizedApp: true });
  ctx.start(opts);
})();
