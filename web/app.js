/* Signal Radio — station guide + audio player for the Radio Browser directory. */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const els = {
    app: $("#app"), meta: $("#meta"), clock: $("#clock"), built: $("#built"),
    deck: $("#deck"), audio: $("#audio"), art: $("#art"), tallyText: $("#tallyText"), track: $("#track"), artist: $("#artist"),
    deckStation: $("#deckStation"), deckNote: $("#deckNote"), deckActions: $("#deckActions"), playBtn: $("#playBtn"), volume: $("#volume"),
    nowLogo: $("#nowLogo"), nowNum: $("#nowNum"), nowName: $("#nowName"), nowSrc: $("#nowSrc"), favBtn: $("#favBtn"),
    nowEyebrow: $("#nowEyebrow"), nowTitle: $("#nowTitle"), nowTime: $("#nowTime"), nowBar: $("#nowBar"), nowDesc: $("#nowDesc"),
    nextList: $("#nextList"), history: $("#history"), streams: $("#streams"),
    q: $("#q"), country: $("#country"), countryWrap: $("#countryWrap"), region: $("#region"), regionWrap: $("#regionWrap"),
    lang: $("#lang"), langWrap: $("#langWrap"), tGuide: $("#tGuide"), tFav: $("#tFav"), jumpNow: $("#jumpNow"), cats: $("#cats"),
    guide: $("#guide"), canvas: $("#canvas"), ticks: $("#ticks"), corner: $("#corner"), rows: $("#rows"), nowline: $("#nowline"), empty: $("#empty"),
    toast: $("#toast"), themeBtn: $("#themeBtn"), castBtn: $("#castBtn"),
  };
  const artFallback = els.art.innerHTML;
  const tvMode = document.documentElement.classList.contains("tv");

  // ------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem("signal-radio." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("signal-radio." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // ------------------------------------------------------------ formatting
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  const fmtClock = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const tm = (min) => fmtTime.format(new Date(min * 60000));
  const nowMin = () => Date.now() / 60000;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (name) => name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "FM";
  const sameDay = (a, b) => new Date(a * 60000).toDateString() === new Date(b * 60000).toDateString();
  const durText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}` : `${m} min`);
  const title = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const quality = (s) => [s.codec, s.br ? `${s.br}k` : "", s.hls ? "HLS" : ""].filter(Boolean).join(" ");

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { els.toast.hidden = true; }, 2200);
  }

  async function copy(text, note = "") {
    try { await navigator.clipboard.writeText(text); toast("Stream URL copied" + note); }
    catch { window.prompt?.("Copy the stream URL", text); }
  }

  // ------------------------------------------------------------ state
  const S = {
    stations: [], byId: new Map(), list: [], countries: new Map(), langNames: new Map(),
    T0: 0, T1: 0, PX: 5, CH_W: 232, ROW_H: 64,
    sel: null, selProg: null, playing: null, np: null, id3: null,
    favs: new Set(store.get("favs", [])),
    f: Object.assign({ q: "", country: "", region: "", lang: "", cat: "", guide: false, fav: false }, store.get("filters", {})),
    rendered: [], renderKey: "",
  };
  S.f.q = "";

  // TV mode sizes the guide in rem (see app.css), so convert to pixels.
  function readLayout() {
    const cs = getComputedStyle(document.documentElement);
    const rem = parseFloat(cs.fontSize) || 16;
    const px = (name, d) => {
      const v = cs.getPropertyValue(name).trim();
      return (parseFloat(v) || d) * (v.endsWith("rem") ? rem : 1);
    };
    S.CH_W = px("--chan-w", 232);
    S.ROW_H = px("--row-h", 64);
    S.PX = tvMode ? rem * 0.375 : window.innerWidth < 560 ? 4 : 5;
  }

  // ------------------------------------------------------------ data
  async function fetchData() {
    const [sRes, gRes] = await Promise.all([fetch("data/stations.json", { cache: "no-cache" }), fetch("data/guide.json", { cache: "no-cache" }).catch(() => null)]);
    if (!sRes.ok) throw new Error("data/stations.json is missing. Run scripts/build.py first.");
    const sData = await sRes.json();
    const gData = gRes && gRes.ok ? await gRes.json() : { guide: {}, from: 0, to: 0 };
    return { sData, gData };
  }

  function load({ sData, gData }) {
    S.built = sData.built;
    S.byId = new Map();
    S.countries = new Map((sData.countries || []).map((c) => [c.id, c]));
    S.langNames = new Map((sData.languages || []).map((l) => [l.id, l.name]));
    const multi = S.countries.size > 1;
    const now = nowMin();
    S.T0 = Math.floor((gData.from || now - 180) / 30) * 30;
    S.T1 = Math.ceil(Math.max(gData.to || 0, now + 24 * 60) / 30) * 30;
    S.T0 = Math.max(S.T0, Math.floor((now - 6 * 60) / 30) * 30);

    S.stations = sData.stations.map((c, i) => {
      const progs = (gData.guide[c.id] || []).filter((p) => p[1] > S.T0 && p[0] < S.T1);
      const where = [c.region, multi ? c.cc.toUpperCase() : ""].filter(Boolean).join(", ");
      const ch = {
        ...c, num: i + 1, progs, cats: c.tags, where,
        hay: [c.name, c.region, ...c.tags, ...c.langs, ...progs.map((p) => p[2])].join(" \u0001 ").toLowerCase(),
      };
      S.byId.set(c.id, ch);
      return ch;
    });

    const withG = S.stations.filter((c) => c.progs.length).length;
    els.meta.textContent = `${S.stations.length.toLocaleString()} stations · ${withG.toLocaleString()} with schedules` +
      (S.proxy ? " · stream proxy on" : "");
    const built = new Date(sData.built);
    els.built.textContent = `updated ${fmtDay.format(built)}, ${fmtTime.format(built)}`;
  }

  // ------------------------------------------------------------ filters
  // Country, region and language only show when the data has a choice to
  // make. The region and language lists follow the chosen country.
  function buildFilters() {
    if (!S.countries.has(S.f.country)) S.f.country = "";
    els.countryWrap.hidden = S.countries.size < 2;
    els.country.innerHTML = `<option value="">All countries</option>` +
      [...S.countries.values()].map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${c.count})</option>`).join("");
    els.country.value = S.f.country;

    const inCountry = S.stations.filter((c) => !S.f.country || c.cc === S.f.country);
    const count = (key) => {
      const m = new Map();
      inCountry.forEach((c) => [].concat(key(c)).forEach((v) => v && m.set(v, (m.get(v) || 0) + 1)));
      return [...m].sort((a, b) => b[1] - a[1]);
    };

    const regions = count((c) => c.region).filter(([, n]) => n >= 2).sort((a, b) => a[0].localeCompare(b[0]));
    if (S.f.region && !regions.some(([r]) => r === S.f.region)) S.f.region = "";
    els.regionWrap.hidden = regions.length < 2;
    els.region.innerHTML = `<option value="">All regions</option>` +
      regions.map(([r, n]) => `<option value="${esc(r)}">${esc(r)} (${n})</option>`).join("");
    els.region.value = S.f.region;

    const langs = count((c) => c.langs).filter(([, n]) => n >= 2);
    if (S.f.lang && !langs.some(([l]) => l === S.f.lang)) S.f.lang = "";
    els.langWrap.hidden = langs.length < 2;
    els.lang.innerHTML = `<option value="">All languages</option>` +
      langs.map(([l, n]) => `<option value="${esc(l)}">${esc(S.langNames.get(l) || title(l))} (${n})</option>`).join("");
    els.lang.value = S.f.lang;

    const cats = count((c) => c.tags).filter(([, n]) => n >= 5).slice(0, 40);
    if (S.f.cat && !cats.some(([k]) => k === S.f.cat)) S.f.cat = "";
    els.cats.innerHTML = [`<button type="button" class="chip" data-cat="">All</button>`,
      ...cats.map(([k, n]) => `<button type="button" class="chip" data-cat="${esc(k)}">${esc(title(k))}<b>${n}</b></button>`)].join("");
    syncFilterUI();
  }

  function syncFilterUI() {
    els.tGuide.setAttribute("aria-pressed", S.f.guide);
    els.tFav.setAttribute("aria-pressed", S.f.fav);
    els.cats.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", b.dataset.cat === S.f.cat));
  }

  function applyFilters(keepScroll) {
    const q = S.f.q.trim().toLowerCase();
    S.list = S.stations.filter((c) =>
      (!S.f.country || c.cc === S.f.country) &&
      (!S.f.region || c.region === S.f.region) &&
      (!S.f.lang || c.langs.includes(S.f.lang)) &&
      (!S.f.cat || c.tags.includes(S.f.cat)) &&
      (!S.f.guide || c.progs.length) &&
      (!S.f.fav || S.favs.has(c.id)) &&
      (!q || c.hay.includes(q)));
    const { q: _q, ...persist } = S.f;
    store.set("filters", persist);
    syncFilterUI();
    layout();
    if (!keepScroll) els.guide.scrollTop = 0;
    render(true);

    els.empty.hidden = S.list.length > 0;
    if (!S.list.length) {
      els.empty.innerHTML = S.f.fav && !S.favs.size
        ? `<strong>No favorites yet</strong><span>Tune a station and press the star, or press F.</span>`
        : `<strong>No stations match</strong><span>Try a different search or fewer filters.</span>`;
    }
  }

  // ------------------------------------------------------------ grid
  const xOf = (min) => (min - S.T0) * S.PX;

  function layout() {
    const w = (S.T1 - S.T0) * S.PX;
    els.canvas.style.width = `${S.CH_W + w}px`;
    els.ticks.style.width = `${w}px`;
    els.rows.style.height = `${S.list.length * S.ROW_H}px`;
    els.corner.textContent = `${S.list.length.toLocaleString()} stations`;

    let html = "";
    for (let t = S.T0; t < S.T1; t += 30) {
      const d = new Date(t * 60000);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const label = midnight ? fmtDay.format(d) : tm(t);
      html += `<div class="tick${d.getMinutes() ? " half" : ""}${midnight ? " day" : ""}" style="left:${xOf(t)}px;width:${30 * S.PX}px">${esc(label)}</div>`;
    }
    els.ticks.innerHTML = html;
    placeNowLine();
  }

  function placeNowLine() {
    els.nowline.style.left = `${S.CH_W + xOf(nowMin()) - 1}px`;
  }

  const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;

  function logoHtml(c, lazy) {
    return c.logo
      ? `<img class="logo-img" src="${esc(c.logo)}" alt=""${lazy ? ` loading="lazy" decoding="async"` : ""} referrerpolicy="no-referrer" data-i="${esc(initials(c.name))}">`
      : esc(initials(c.name));
  }

  function chanCell(c) {
    const star = S.favs.has(c.id) ? `<span class="star" aria-label="Favorite">★</span> ` : "";
    const sub = [c.where, c.tags[0] ? title(c.tags[0]) : ""].filter(Boolean).join(" · ") || quality(c.streams[0]);
    return `<div class="chan"><button type="button" class="chan-tune" data-ch="${esc(c.id)}" title="${esc(c.name)}">
      <span class="chan-num">${c.num}</span><span class="logo">${logoHtml(c, true)}</span>
      <span class="chan-text"><span class="chan-name">${esc(c.name)}</span><span class="chan-sub">${star}${esc(sub)}</span></span>
    </button><button type="button" class="row-copy" data-copy="${esc(c.id)}" title="Copy stream URL" aria-label="Copy stream URL for ${esc(c.name)}">${COPY_ICON}</button></div>`;
  }

  function render(force) {
    const g = els.guide;
    const n = S.list.length;
    const top = Math.max(0, g.scrollTop - els.rows.offsetTop);
    const first = Math.max(0, Math.floor(top / S.ROW_H) - 4);
    const last = Math.min(n, Math.ceil((top + g.clientHeight) / S.ROW_H) + 4);
    const span = Math.max(g.clientWidth, 400);
    const bucket = Math.floor(g.scrollLeft / (span / 2));
    const key = `${first}:${last}:${bucket}`;
    if (!force && key === S.renderKey) { shiftTitles(); return; }
    S.renderKey = key;

    const tA = S.T0 + (bucket * (span / 2) - span) / S.PX;
    const tB = S.T0 + (bucket * (span / 2) + 2.5 * span) / S.PX;
    const now = nowMin();
    const totalW = (S.T1 - S.T0) * S.PX;
    let html = "";
    for (let i = first; i < last; i++) {
      const c = S.list[i];
      let cells = "";
      if (c.progs.length) {
        c.progs.forEach((p, j) => {
          if (p[1] < tA || p[0] > tB) return;
          const x = Math.max(0, xOf(p[0]));
          const w = Math.min(totalW, xOf(p[1])) - x - 3;
          if (w < 4) return;
          const cls = (p[1] <= now ? " past" : p[0] <= now ? " live" : "") +
            (S.selProg && S.selProg.ch === c.id && S.selProg.i === j ? " sel" : "") + (w < 70 ? " narrow" : "");
          const meta = `${tm(p[0])} – ${tm(p[1])}${p[3] ? " · " + p[3] : ""}`;
          cells += `<div class="prog${cls}" style="left:${x}px;width:${w}px" data-ch="${esc(c.id)}" data-i="${j}" data-x="${x}" data-w="${w}" title="${esc(p[2] + " — " + meta)}">
            <div class="in"><span class="t">${esc(p[2] || "Untitled")}</span><span class="m">${esc(meta)}</span></div></div>`;
        });
      } else {
        const label = c.tags.length ? c.tags.slice(0, 4).map(title).join(", ") : "Live stream";
        const live = S.playing && S.playing.ch === c.id && S.np && S.np.title ? ` · ♪ ${[S.np.artist, S.np.title].filter(Boolean).join(" – ")}` : "";
        cells = `<div class="prog none" style="left:0;width:${totalW - 3}px" data-ch="${esc(c.id)}" data-x="0" data-w="${totalW - 3}">
          <div class="in"><span class="t">No schedule · ${esc(label)}</span><span class="m">${esc(quality(c.streams[0]))} · ${c.streams.length} stream${c.streams.length > 1 ? "s" : ""}${esc(live)}</span></div></div>`;
      }
      const whole = S.sel === c.id && !(S.selProg && S.selProg.ch === c.id) ? " whole" : "";
      html += `<div class="row${S.sel === c.id ? " sel" : ""}${whole}" style="top:${i * S.ROW_H}px;width:${S.CH_W + totalW}px">${chanCell(c)}<div class="progs" style="width:${totalW}px">${cells}</div></div>`;
    }
    els.rows.innerHTML = html;
    S.rendered = [...els.rows.querySelectorAll(".prog")].map((el) => ({ el, x: +el.dataset.x, w: +el.dataset.w }));
    shiftTitles();
  }

  // Keep programme titles readable when a block starts left of the viewport.
  function shiftTitles() {
    const sl = els.guide.scrollLeft;
    for (const r of S.rendered) {
      const s = Math.max(0, Math.min(sl - r.x, r.w - 64));
      r.el.style.setProperty("--shift", `${s}px`);
    }
  }

  let raf = 0;
  els.guide.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(false); });
  }, { passive: true });

  function scrollToNow(smooth) {
    const left = xOf(nowMin() - 30);
    els.guide.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "auto" });
  }

  function scrollToStation(id) {
    const i = S.list.findIndex((c) => c.id === id);
    if (i < 0) return;
    const g = els.guide, y = els.rows.offsetTop + i * S.ROW_H;
    const head = els.rows.offsetTop;
    if (y < g.scrollTop + head) g.scrollTop = y - head;
    else if (y + S.ROW_H > g.scrollTop + g.clientHeight) g.scrollTop = y + S.ROW_H - g.clientHeight;
  }

  // ------------------------------------------------------------ now panel
  function currentIndex(c, at = nowMin()) {
    return c.progs.findIndex((p) => p[0] <= at && p[1] > at);
  }

  function showPanel() {
    const c = S.byId.get(S.sel);
    if (!c) return;
    els.nowLogo.innerHTML = logoHtml(c);
    els.nowNum.textContent = `No. ${c.num}`;
    els.nowName.textContent = c.name;
    els.nowName.title = c.name;
    els.nowSrc.textContent = [c.where, c.langs.map((l) => S.langNames.get(l) || title(l)).join(", "), c.tags.slice(0, 3).map(title).join(", ")].filter(Boolean).join(" · ");
    els.favBtn.disabled = false;
    const fav = S.favs.has(c.id);
    els.favBtn.setAttribute("aria-pressed", fav);
    els.favBtn.setAttribute("aria-label", fav ? "Remove from favorites" : "Add to favorites");
    els.favBtn.title = (fav ? "Remove from favorites" : "Add to favorites") + " (F)";

    const now = nowMin();
    const cur = currentIndex(c, now);
    const pi = S.selProg && S.selProg.ch === c.id ? S.selProg.i : cur;
    const p = c.progs[pi];
    els.nowEyebrow.className = "eyebrow";
    if (p) {
      const live = p[0] <= now && p[1] > now;
      if (live) { els.nowEyebrow.textContent = "On now"; els.nowEyebrow.classList.add("live"); }
      else if (p[0] > now) els.nowEyebrow.textContent = sameDay(p[0], now) ? `Later today` : `Coming up · ${fmtDay.format(new Date(p[0] * 60000))}`;
      else els.nowEyebrow.textContent = "Earlier";
      els.nowTitle.textContent = p[2] || "Untitled";
      els.nowTime.textContent = [`${tm(p[0])} – ${tm(p[1])}`, durText(Math.round(p[1] - p[0])), p[5]].filter(Boolean).join(" · ");
      els.nowDesc.textContent = [p[3], p[4]].filter(Boolean).join(" — ") || "No description in the schedule.";
      els.nowBar.hidden = !live;
      if (live) els.nowBar.firstElementChild.style.width = `${((now - p[0]) / (p[1] - p[0])) * 100}%`;
    } else {
      els.nowEyebrow.textContent = "Live";
      els.nowTitle.textContent = c.progs.length ? "Nothing scheduled right now" : "No schedule for this station";
      els.nowTime.textContent = "";
      els.nowBar.hidden = true;
      els.nowDesc.textContent = c.progs.length
        ? "The schedule has a gap here. The station is probably still on air."
        : "No public schedule covers this station. The player shows the song it's playing when the stream says.";
    }

    const start = cur >= 0 ? cur + 1 : c.progs.findIndex((q) => q[0] > now);
    const next = start >= 0 ? c.progs.slice(start, start + 3) : [];
    els.nextList.innerHTML = next.length
      ? `<div class="eyebrow">Up next</div>` + next.map((q) => `<div class="next-item"><time>${esc(tm(q[0]))}</time><span title="${esc(q[2])}">${esc(q[2])}</span></div>`).join("")
      : "";
    renderHistory();
    renderStreams(c);
  }

  function renderHistory() {
    const h = S.playing && S.playing.ch === S.sel && S.np ? (S.np.history || []) : [];
    // The first entry is what's on now; the deck already shows it.
    const past = h.slice(S.np && S.np.title ? 1 : 0, 6);
    const when = (x) => (x.at ? fmtTime.format(new Date(x.at * 1000)) : (x.label || "").replace(/ Minutes? Ago$/i, " min ago"));
    els.history.innerHTML = past.length
      ? `<div class="eyebrow">Recently played</div>` + past.map((x) => `<div class="next-item"><time>${esc(when(x))}</time>` +
        `<span title="${esc([x.artist, x.title].filter(Boolean).join(" – "))}"><b>${esc(x.title)}</b>${x.artist ? ` <i>${esc(x.artist)}</i>` : ""}</span></div>`).join("")
      : "";
  }

  function renderStreams(c) {
    const active = S.playing && S.playing.ch === c.id ? S.playing.idx : -1;
    els.streams.innerHTML = c.streams.map((s, i) => {
      const bad = S.bad.has(s.url) ? " bad" : "";
      const q = quality(s);
      return `<button type="button" class="stream-btn${bad}" data-s="${i}" aria-current="${i === active}" title="${esc(s.url)}">Stream ${i + 1}${q ? " · " + esc(q) : ""}</button>`;
    }).join("") + `<button type="button" class="stream-btn copy-btn" data-copy="${esc(c.id)}">Copy URL</button>` +
      (c.site ? `<a class="stream-btn copy-btn" href="${esc(c.site)}" target="_blank" rel="noopener">Website</a>` : "");
  }

  // ------------------------------------------------------------ deck
  // What's playing: the song from the stream (or the BBC), else the scheduled
  // programme, else just the station.
  function renderDeck() {
    const c = S.byId.get(S.playing ? S.playing.ch : S.sel);
    if (!c) return;
    const np = S.playing && S.playing.ch === c.id ? { ...(S.np || {}), ...(S.id3 || {}) } : {};
    const p = c.progs[currentIndex(c)];
    let track, artist, note = "";
    if (np.title) { track = np.title; artist = np.artist || ""; note = p ? `On ${p[2]}` : ""; }
    else if (p) { track = p[2]; artist = p[3] || p[4] || ""; }
    else { track = c.name; artist = c.tags.slice(0, 4).map(title).join(", "); }
    if (!np.title && S.playing && S.np && (S.np.none || S.np.error) && !p) note = "This stream doesn't say what's playing.";
    els.track.textContent = track;
    els.track.title = track;
    els.artist.textContent = artist;
    els.deckStation.textContent = `No. ${c.num} · ${c.name}` + (S.playing && S.playing.ch === c.id ? ` · ${quality(c.streams[S.playing.idx]) || "live"}` : "");
    if (!els.deck.classList.contains("error")) els.deckNote.textContent = note;
    const art = np.art || "";
    const want = art || c.logo || "";
    if (els.art.dataset.src !== want) {
      els.art.dataset.src = want;
      els.art.innerHTML = want ? `<img src="${esc(want)}" alt="" referrerpolicy="no-referrer"${art ? "" : ` class="logo-fit"`}>` : artFallback;
    }
    els.playBtn.disabled = false;
    if ("mediaSession" in navigator && S.playing) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track, artist: artist || c.name, album: c.name,
        artwork: want ? [{ src: new URL(want, location.href).href, sizes: "512x512" }] : [],
      });
    }
  }

  function deckState(state, text, actions = "") {
    els.deck.classList.remove("loading", "error", "playing", "casting");
    if (state) els.deck.classList.add(state);
    els.tallyText.textContent = { loading: "Tuning", error: "No signal", casting: "Casting", playing: "On air" }[state] || "Ready";
    els.deckNote.innerHTML = text;
    els.deckActions.innerHTML = actions;
    els.playBtn.setAttribute("aria-label", state === "playing" || state === "loading" ? "Pause" : "Play");
  }

  // ------------------------------------------------------------ player
  S.bad = new Set();
  let hls = null, token = 0, watchdog = 0;

  function stop() {
    token++;
    clearTimeout(watchdog);
    if (hls) { hls.destroy(); hls = null; }
    els.audio.removeAttribute("src");
    els.audio.load();
  }

  const isHls = (s) => s.hls || /\.m3u8(\?|$)/i.test(s.url);

  // Ways to reach a stream, tried in order. A plain-HTTP stream on an HTTPS
  // page first tries the same address over HTTPS (when it has no port, many
  // hosts answer both), then the local proxy (scripts/serve.py), which also
  // catches servers the browser can't talk to and HLS without CORS.
  function routes(s) {
    const mixed = location.protocol === "https:" && s.url.startsWith("http:");
    const viaProxy = { url: `proxy?${new URLSearchParams({ u: s.url })}`, via: "proxy" };
    const out = [];
    if (!mixed) out.push({ url: s.url, via: "direct" });
    else if (!new URL(s.url).port) out.push({ url: s.url.replace(/^http:/, "https:"), via: "direct" });
    if (S.proxy) out.push(viaProxy);
    return out;
  }

  function copyStation(id) {
    const c = S.byId.get(id);
    if (!c) return;
    const idx = S.playing && S.playing.ch === c.id ? S.playing.idx : 0;
    copy(c.streams[idx].url);
  }

  function tune(id, idx = 0, opts = {}) {
    const c = S.byId.get(id);
    if (!c) return;
    select(id, { keepProg: opts.keepProg });
    store.set("last", id);
    stop();
    if (S.playing && S.playing.ch !== id) { S.np = null; S.id3 = null; }
    if (Cast.session()) return Cast.load(c, idx, opts);
    const my = token;

    // Find the next stream we can attempt.
    let i = idx;
    while (i < c.streams.length && !routes(c.streams[i]).length) { S.bad.add(c.streams[i].url); i++; }
    if (i >= c.streams.length) {
      return fail(c, S.proxy ? "every stream failed to load" : "its streams use plain HTTP, which this HTTPS page can't load");
    }

    const s = c.streams[i];
    const rs = routes(s);
    const attempt = Math.min(opts.attempt || 0, rs.length - 1);
    const route = rs[attempt];
    if (!S.playing || S.playing.ch !== id || S.playing.idx !== i) { S.np = null; S.id3 = null; }
    S.playing = { ch: id, idx: i };
    renderStreams(c);
    renderDeck();
    deckState("loading", `Tuning${c.streams.length > 1 ? ` stream ${i + 1} of ${c.streams.length}` : ""}${route.via === "proxy" ? " through the local proxy" : ""}…`);
    pollNow(true);

    const next = (why) => {
      if (my !== token) return;
      if (attempt + 1 < rs.length) return tune(id, i, { ...opts, keepProg: true, attempt: attempt + 1 });
      S.bad.add(s.url);
      if (opts.single || i + 1 >= c.streams.length) return fail(c, why);
      tune(id, i + 1, { keepProg: true });
    };
    // A direct attempt that will fall back gets less time than the last one.
    watchdog = setTimeout(() => next("the stream didn't start within 15 seconds"), attempt + 1 < rs.length ? 8000 : 15000);

    const a = els.audio;
    a.onplaying = () => { if (my === token) { clearTimeout(watchdog); deckState("playing", ""); renderDeck(); } };
    a.onpause = () => { if (my === token && !a.ended && els.deck.classList.contains("playing")) deckState("", "Paused."); };
    a.onerror = () => next("the browser couldn't play the stream");

    if (isHls(s) && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2, backBufferLength: 30 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (my === token) a.play().catch(() => playPrompt(c)); });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal || my !== token) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        const code = d.response && d.response.code;
        next(code === 403 ? "the server refused the request (often geo-blocking)"
          : code === 404 ? "the stream is offline (404)"
          : d.type === Hls.ErrorTypes.NETWORK_ERROR ? "the server blocked browser playback or is offline"
          : "the stream format isn't supported");
      });
      hls.loadSource(route.url);
      hls.attachMedia(a);
    } else {
      a.src = route.url;
      a.play().catch((e) => { if (e && e.name === "NotAllowedError") playPrompt(c); });
    }
  }

  function togglePlay() {
    if (Cast.session()) { Cast.toggle(); return; }
    const a = els.audio;
    if (els.deck.classList.contains("playing") || els.deck.classList.contains("loading")) {
      // Live radio: pausing stops the stream; play tunes in again at "now".
      stop();
      deckState("", "Stopped.");
      return;
    }
    if (S.sel) tune(S.playing ? S.playing.ch : S.sel, S.playing ? S.playing.idx : 0, { keepProg: true });
    else if (a.src) a.play().catch(() => {});
  }

  function playPrompt(c) {
    deckState("", `Press ${tvMode ? "OK" : "play"} to listen to <b>${esc(c.name)}</b>.`);
    renderDeck();
  }

  function fail(c, why) {
    clearTimeout(watchdog);
    if (hls) { hls.destroy(); hls = null; }
    S.playing = null;
    renderStreams(c);
    const s = c.streams[0];
    deckState("error",
      `<b>${esc(c.name)}</b> won't play here: ${esc(why)}. ` +
      (S.proxy ? "Some streams only work in an app like VLC." : "Running <code>scripts/serve.py</code> plays more stations, or try VLC."),
      `<button type="button" data-act="retry">Try again</button><button type="button" data-copy="${esc(c.id)}">Copy stream URL</button>` +
      (s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Open stream</a>` : ""));
  }

  // ------------------------------------------------------------ now playing
  // The server reads the stream's song titles (browsers can't) every 20 s at
  // most; the page asks every 15 s while something plays and the tab is open.
  // HLS streams carry theirs as ID3 tags, which hls.js hands to the page.
  let npTimer = 0;
  async function pollNow(soon) {
    clearTimeout(npTimer);
    if (!S.playing || !S.nowplaying) return;
    const { ch, idx } = S.playing;
    if (!soon) {
      try {
        const r = await fetch(`api/nowplaying?${new URLSearchParams({ id: ch, s: idx })}`, { cache: "no-store" });
        if (r.ok && S.playing && S.playing.ch === ch) {
          S.np = await r.json();
          renderDeck();
          if (S.sel === ch) renderHistory();
          render(true);
        }
      } catch { /* try again next time */ }
    }
    npTimer = setTimeout(() => { if (!document.hidden) pollNow(false); else pollNow(true); }, soon ? 1500 : 15000);
  }

  els.audio.textTracks.addEventListener("addtrack", (e) => {
    const t = e.track;
    if (t.kind !== "metadata") return;
    t.mode = "hidden";
    t.addEventListener("cuechange", () => {
      const id3 = {};
      for (const cue of t.activeCues || []) {
        const v = cue.value || {};
        if (v.key === "TIT2" && v.data) id3.title = String(v.data);
        if (v.key === "TPE1" && v.data) id3.artist = String(v.data);
      }
      if (id3.title) { S.id3 = id3; renderDeck(); }
    });
  });

  // ------------------------------------------------------------ cast
  // Google Cast (Chromecast, Nest speakers and displays, Google TV) through
  // the Default Media Receiver. The receiver page is HTTPS, so a plain-HTTP
  // stream goes through this server's proxy, which the speaker must be able
  // to resolve and reach; so does HLS, for CORS.
  const Cast = {
    ctx: null,
    session() { return this.ctx && this.ctx.getCurrentSession(); },

    init() {
      if (tvMode || !S.proxy || !/Chrome|CriOS|Edg/.test(navigator.userAgent)) return;
      window.__onGCastApiAvailable = (ok) => { if (ok) this.ready(); };
      const sc = document.createElement("script");
      sc.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      sc.async = true;
      document.head.appendChild(sc);
    },

    ready() {
      const cf = cast.framework;
      this.ctx = cf.CastContext.getInstance();
      this.ctx.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      // The button stays visible with no devices found: a page can't make
      // Chrome rescan, but opening its Cast picker does, so a click is the
      // "search again".
      const sync = () => {
        const st = this.ctx.getCastState();
        const none = st === cf.CastState.NO_DEVICES_AVAILABLE;
        const on = st === cf.CastState.CONNECTED;
        els.castBtn.hidden = false;
        els.castBtn.classList.toggle("searching", none);
        els.castBtn.setAttribute("aria-pressed", on);
        els.castBtn.title = on ? `Casting to ${this.device()}. Click to stop.`
          : none ? "No speakers found yet. Click to search again." : "Cast to a speaker";
        els.castBtn.setAttribute("aria-label", els.castBtn.title);
      };
      this.ctx.addEventListener(cf.CastContextEventType.CAST_STATE_CHANGED, sync);
      this.ctx.addEventListener(cf.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
        const SS = cf.SessionState;
        if ((e.sessionState === SS.SESSION_STARTED || e.sessionState === SS.SESSION_RESUMED) && S.sel) {
          if (e.sessionState === SS.SESSION_STARTED || !this.session().getMediaSession()) tune(S.sel, S.playing && S.playing.ch === S.sel ? S.playing.idx : 0, { keepProg: true });
          else this.showCasting(S.byId.get(S.sel));
        }
        if (e.sessionState === SS.SESSION_ENDED && S.sel) {
          toast("Stopped casting");
          playPrompt(S.byId.get(S.sel));
        }
      });
      sync();
    },

    device() {
      const s = this.session();
      return (s && s.getCastDevice().friendlyName) || "your speaker";
    },

    toggle() {
      if (!this.ctx) return;
      if (this.session()) this.ctx.endCurrentSession(true);
      else this.ctx.requestSession().catch((code) => {
        if (code !== chrome.cast.ErrorCode.CANCEL && this.ctx.getCastState() === cast.framework.CastState.NO_DEVICES_AVAILABLE)
          toast("No speakers found. Check it's on and on the same network");
      });
    },

    source(s, viaProxy) {
      const hlsStream = isHls(s);
      const direct = !viaProxy && s.url.startsWith("https:") && !hlsStream;
      const url = direct ? s.url : new URL(`proxy?${new URLSearchParams({ u: s.url })}`, location.href).href;
      const type = hlsStream ? "application/x-mpegurl"
        : { MP3: "audio/mpeg", AAC: "audio/aac", "AAC+": "audio/aac", OGG: "audio/ogg", OPUS: "audio/ogg", FLAC: "audio/flac" }[s.codec] || "audio/mpeg";
      return { url, type, via: direct ? "direct" : "proxy" };
    },

    async load(c, idx = 0, opts = {}) {
      const my = token;
      const s = c.streams[idx];
      if (!s) return this.fail(c, "none of its streams would load");
      S.playing = { ch: c.id, idx };
      renderStreams(c);
      renderDeck();
      this.showCasting(c, true);
      pollNow(true);
      const { url, type, via } = this.source(s, opts.viaProxy);
      const info = new chrome.cast.media.MediaInfo(url, type);
      info.streamType = chrome.cast.media.StreamType.LIVE;
      if (type === "application/x-mpegurl" && chrome.cast.media.HlsSegmentFormat) info.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.AAC;
      const md = new chrome.cast.media.MusicTrackMediaMetadata();
      const p = c.progs[currentIndex(c)];
      md.title = p ? p[2] : c.name;
      md.artist = c.name;
      if (c.logo) md.images = [new chrome.cast.Image(c.logo)];
      info.metadata = md;
      const req = new chrome.cast.media.LoadRequest(info);
      req.autoplay = true;
      try {
        await this.session().loadMedia(req);
        if (my === token) this.showCasting(c);
      } catch (err) {
        if (my !== token) return;
        // A direct link the speaker refused gets one more try through the proxy.
        if (via === "direct" && !opts.viaProxy) return this.load(c, idx, { ...opts, viaProxy: true });
        S.bad.add(s.url);
        if (!opts.single && idx + 1 < c.streams.length) return this.load(c, idx + 1, { ...opts, viaProxy: false });
        this.fail(c, `${this.device()} couldn't play it${err && err.code ? ` (${err.code})` : ""}`);
      }
    },

    showCasting(c, loading) {
      if (!c) return;
      deckState("casting", `${loading ? "Sending" : "Casting"} to <b>${esc(this.device())}</b>${loading ? "…" : ""}`,
        `<button type="button" data-act="stopcast">Stop casting</button>`);
    },

    fail(c, why) {
      S.playing = null;
      renderStreams(c);
      deckState("error", `<b>${esc(c.name)}</b> won't cast: ${esc(why)}.`,
        `<button type="button" data-act="retry">Try again</button><button type="button" data-act="stopcast">Stop casting</button>`);
    },
  };

  // ------------------------------------------------------------ selection
  function select(id, opts = {}) {
    S.sel = id;
    if (!opts.keepProg) S.selProg = null;
    render(true);
    showPanel();
    if (!S.playing) renderDeck();
  }

  function surf(delta) {
    if (!S.list.length) return;
    let i = S.list.findIndex((c) => c.id === S.sel);
    i = i < 0 ? 0 : (i + delta + S.list.length) % S.list.length;
    const id = S.list[i].id;
    scrollToStation(id);
    tune(id);
  }

  function toggleFav() {
    if (!S.sel) return;
    const c = S.byId.get(S.sel);
    if (S.favs.has(S.sel)) { S.favs.delete(S.sel); toast(`Removed ${c.name} from favorites`); }
    else { S.favs.add(S.sel); toast(`Added ${c.name} to favorites`); }
    store.set("favs", [...S.favs]);
    if (S.f.fav) applyFilters(true); else render(true);
    showPanel();
  }

  // ------------------------------------------------------------ events
  els.rows.addEventListener("click", (e) => {
    const cp = e.target.closest(".row-copy");
    if (cp) { copyStation(cp.dataset.copy); return; }
    const chan = e.target.closest(".chan-tune");
    if (chan) { tune(chan.dataset.ch); return; }
    const prog = e.target.closest(".prog");
    if (!prog) return;
    const id = prog.dataset.ch;
    const i = prog.dataset.i;
    S.selProg = i == null ? null : { ch: id, i: +i };
    if (S.playing && S.playing.ch === id) select(id, { keepProg: true });
    else tune(id, 0, { keepProg: true });
  });

  els.streams.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.copy) { copyStation(b.dataset.copy); return; }
    S.bad.delete(S.byId.get(S.sel).streams[+b.dataset.s].url);
    tune(S.sel, +b.dataset.s, { keepProg: true, single: true });
  });

  els.deckActions.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.copy) { copyStation(b.dataset.copy); return; }
    if (b.dataset.act === "stopcast") { Cast.toggle(); return; }
    if (b.dataset.act === "retry") { S.byId.get(S.sel).streams.forEach((s) => S.bad.delete(s.url)); tune(S.sel, 0, { keepProg: true }); }
  });
  els.playBtn.addEventListener("click", togglePlay);

  const vol = store.get("volume", 1);
  els.audio.volume = els.volume.value = vol;
  els.volume.addEventListener("input", () => { els.audio.volume = +els.volume.value; store.set("volume", +els.volume.value); });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", togglePlay);
    navigator.mediaSession.setActionHandler("pause", togglePlay);
    navigator.mediaSession.setActionHandler("stop", togglePlay);
    navigator.mediaSession.setActionHandler("nexttrack", () => surf(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => surf(-1));
  }

  // Replace broken logos with initials, and broken cover art with the logo.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG") return;
    if (img.classList.contains("logo-img")) img.replaceWith(document.createTextNode(img.dataset.i || "FM"));
    else if (img.parentElement === els.art) { els.art.innerHTML = artFallback; }
  }, true);

  let qTimer = 0;
  els.q.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.f.q = els.q.value; applyFilters(); }, 120);
  });
  els.country.addEventListener("change", () => { S.f.country = els.country.value; buildFilters(); applyFilters(); });
  els.region.addEventListener("change", () => { S.f.region = els.region.value; applyFilters(); });
  els.lang.addEventListener("change", () => { S.f.lang = els.lang.value; applyFilters(); });
  els.cats.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    S.f.cat = b.dataset.cat;
    applyFilters();
  });
  els.tGuide.addEventListener("click", () => { S.f.guide = !S.f.guide; applyFilters(); });
  els.tFav.addEventListener("click", () => { S.f.fav = !S.f.fav; applyFilters(); });
  els.jumpNow.addEventListener("click", () => { scrollToNow(true); if (S.sel) scrollToStation(S.sel); });
  els.favBtn.addEventListener("click", toggleFav);
  els.castBtn.addEventListener("click", () => Cast.toggle());

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== "range";
    if (e.key === "Escape" && typing) { document.activeElement.blur(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); els.q.focus(); els.q.select(); }
    else if (e.key === "]") surf(1);
    else if (e.key === "[") surf(-1);
    else if (e.key === "f" || e.key === "F") toggleFav();
    else if (e.key === "n" || e.key === "N") scrollToNow(true);
    else if (e.key === " " && !/BUTTON|A/.test(document.activeElement.tagName) && S.sel) { e.preventDefault(); togglePlay(); }
  });

  els.guide.addEventListener("keydown", (e) => {
    if (tvMode) return; // TV.key handles the remote
    if (e.target.closest(".chan button") && (e.key === "Enter" || e.key === " ")) return; // native button
    const map = { ArrowDown: 1, ArrowUp: -1 };
    if (map[e.key]) {
      e.preventDefault();
      let i = S.list.findIndex((c) => c.id === S.sel);
      i = Math.max(0, Math.min(S.list.length - 1, (i < 0 ? -1 : i) + map[e.key]));
      if (!S.list[i]) return;
      S.sel = S.list[i].id; S.selProg = null;
      scrollToStation(S.sel); render(true); showPanel();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      els.guide.scrollBy({ left: (e.key === "ArrowRight" ? 1 : -1) * 30 * S.PX, behavior: "smooth" });
    } else if (e.key === "Enter" && S.sel) {
      tune(S.sel);
    }
  });

  // Theme toggle: system by default, explicit choice persisted.
  const savedTheme = store.get("theme", "");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  els.themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  });

  let lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerWidth - lastW) < 2) { render(true); return; }
    lastW = window.innerWidth;
    const mid = S.T0 + (els.guide.scrollLeft) / S.PX;
    readLayout(); layout();
    els.guide.scrollLeft = (mid - S.T0) * S.PX;
    render(true);
  });

  function tick() {
    els.clock.textContent = fmtClock.format(new Date());
    placeNowLine();
  }

  // ------------------------------------------------------------ TV mode
  // For a TV and its remote (html.tv, set in index.html for ?tv=1 or a TV
  // browser). In the guide, Up/Down change station, Left/Right walk the
  // schedule and OK tunes; OK on the station playing fills the screen with
  // it, and Back comes out again. The rest of the page is reached by moving
  // off the guide's top edge: focus goes to the nearest control that way.
  // An app wrapping the page calls window.signalBack() for its Back button;
  // false means the page had nothing to go back from, so leave the app.
  const FOCUSABLE = 'button:not(:disabled), select, input:not([type="range"]), a[href]:not(.brand)';
  const BACK = new Set(["Escape", "GoBack", "BrowserBack", "Backspace"]);

  const TV = {
    cur: 0, // the time the guide cursor is on, in minutes
    digits: "", digitTimer: 0,

    start() {
      window.signalBack = () => this.back();
      window.addEventListener("keydown", (e) => this.key(e), true);
      els.jumpNow.addEventListener("click", () => { this.cur = nowMin(); });
      if (!S.sel) els.artist.textContent = "Pick a station with ▲ ▼ and press OK.";
      this.cur = nowMin();
      this.focusGuide();
    },

    isFull() { return document.documentElement.classList.contains("full"); },
    full(on) {
      document.documentElement.classList.toggle("full", on);
      if (on) document.activeElement.blur();
      else this.focusGuide();
    },

    winStart() { return S.T0 + els.guide.scrollLeft / S.PX; },
    winEnd() { return this.winStart() + (els.guide.clientWidth - S.CH_W) / S.PX; },

    focusGuide() {
      els.guide.focus({ preventScroll: true });
      if (!S.list.length) return;
      const c = S.list.find((x) => x.id === S.sel) ||
        S.list[Math.min(S.list.length - 1, Math.floor(els.guide.scrollTop / S.ROW_H))];
      this.land(c);
    },

    // Put the cursor on a station, on the programme at this.cur (kept within
    // the time in view), or on the whole row when nothing is scheduled then.
    land(c) {
      this.cur = Math.min(Math.max(this.cur, this.winStart()), this.winEnd() - 1);
      const i = c.progs.findIndex((p) => p[0] <= this.cur && p[1] > this.cur);
      S.selProg = i >= 0 ? { ch: c.id, i } : null;
      scrollToStation(c.id);
      select(c.id, { keepProg: true });
    },

    // After a search or filter the selected station may be out of the list.
    listed() { return S.list.some((c) => c.id === S.sel); },

    move(dy) {
      if (!this.listed()) { this.focusGuide(); return; }
      const i = S.list.findIndex((c) => c.id === S.sel) + dy;
      if (i < 0) this.leave("up");
      else if (i < S.list.length) this.land(S.list[i]);
    },

    step(dx) {
      if (!this.listed()) { this.focusGuide(); return; }
      const c = S.byId.get(S.sel);
      const g = els.guide;
      const at = S.selProg && S.selProg.ch === c.id ? S.selProg.i : -1;
      const j = at >= 0 ? at + dx
        : dx > 0 ? c.progs.findIndex((p) => p[0] >= this.cur)
        : c.progs.findLastIndex((p) => p[1] <= this.cur);
      const p = c.progs[j];
      if (!p) {
        // Nothing scheduled that way: move through time half an hour at a time.
        g.scrollLeft += dx * 30 * S.PX;
        this.cur += dx * 30;
        this.land(c);
        return;
      }
      const view = g.clientWidth - S.CH_W, pad = 15 * S.PX;
      const x0 = xOf(p[0]), x1 = xOf(p[1]);
      if (x0 < g.scrollLeft) g.scrollLeft = x0 - pad;
      else if (x1 > g.scrollLeft + view) g.scrollLeft = Math.min(x0 - pad, x1 - view + pad);
      this.cur = Math.max(p[0], this.winStart());
      S.selProg = { ch: c.id, i: j };
      select(c.id, { keepProg: true });
    },

    ok() {
      if (!this.listed()) { this.focusGuide(); return; }
      const c = S.byId.get(S.sel);
      if (S.playing && S.playing.ch === c.id) this.full(true);
      else tune(c.id, 0, { keepProg: true });
    },

    surf(d) {
      surf(d);
      if (!this.isFull() && S.sel) this.land(S.byId.get(S.sel));
    },

    back() {
      if (this.isFull()) { this.full(false); return true; }
      const a = document.activeElement;
      if (a && a !== els.guide && a !== document.body) { this.focusGuide(); return true; }
      // Wandered off through the guide: back to what's playing, now.
      if (S.playing && S.sel !== S.playing.ch && S.list.some((c) => c.id === S.playing.ch)) {
        this.cur = nowMin();
        scrollToNow(false);
        this.land(S.byId.get(S.playing.ch));
        return true;
      }
      return false;
    },

    // Number keys: type a station number, it's selected after a short pause.
    digit(d) {
      this.digits = (this.digits + d).slice(-4);
      toast(`No. ${this.digits}`);
      clearTimeout(this.digitTimer);
      this.digitTimer = setTimeout(() => {
        const n = +this.digits;
        this.digits = "";
        const c = S.list.find((x) => x.num === n);
        if (!c) { toast(`No. ${n} isn't in this list`); return; }
        if (this.isFull()) tune(c.id);
        else { els.guide.focus({ preventScroll: true }); this.land(c); }
      }, 1300);
    },

    leave(dir) {
      this.go(dir, els.rows.querySelector(".prog.sel") || els.rows.querySelector(".row.sel .chan") || els.guide);
    },

    // Focus the nearest control from `from` in direction `dir`, the guide
    // counting as one. Controls scrolled out of view in a scrolling box (the
    // filters, the genres, the station panel) count only from inside it.
    go(dir, from) {
      const r0 = from.getBoundingClientRect();
      const horiz = dir === "left" || dir === "right";
      const box = (el) => el.closest(".controls, .cats, .now, .deck");
      const inView = (el, r) => {
        const b = box(el), c = b ? b.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        return r.left >= c.left - 2 && r.right <= c.right + 2 && r.top >= c.top - 2 && r.bottom <= c.bottom + 2;
      };
      const cands = [];
      for (const el of [...document.querySelectorAll(FOCUSABLE), els.guide]) {
        if (el === from || el.closest("#rows")) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (el !== els.guide && !inView(el, r) && !(box(el) && box(el) === box(from))) continue;
        const gap = { up: r0.top - r.bottom, down: r.top - r0.bottom, left: r0.left - r.right, right: r.left - r0.right }[dir];
        if (gap < -4) continue;
        const cross = horiz ? Math.max(0, r.top - r0.bottom, r0.top - r.bottom) : Math.max(0, r.left - r0.right, r0.left - r.right);
        const off = horiz ? Math.abs(r.top + r.bottom - r0.top - r0.bottom) : Math.abs(r.left + r.right - r0.left - r0.right);
        cands.push({ el, gap: Math.max(0, gap), score: horiz ? Math.max(0, gap) + cross * 2 + off * 0.05 : cross * 2 + off * 0.05 });
      }
      // Up and down go to the nearest row of controls first, then the
      // closest control in it, so the panel's lone star isn't skipped.
      const nearest = Math.min(...cands.map((c) => c.gap));
      const row = horiz ? cands : cands.filter((c) => c.gap <= nearest + Math.max(16, r0.height));
      const best = row.sort((a, b) => a.score - b.score)[0]?.el;
      if (!best) return;
      if (best === els.guide) { this.focusGuide(); return; }
      best.focus({ preventScroll: true });
      best.scrollIntoView({ block: "nearest", inline: "nearest" });
    },

    key(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key, a = document.activeElement;
      const typing = a && a.tagName === "INPUT";
      const done = () => { e.preventDefault(); e.stopPropagation(); };
      const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[k];
      const on = () => els.deck.classList.contains("playing") || els.deck.classList.contains("loading");

      if (BACK.has(k) && !(typing && k === "Backspace")) { if (this.back()) done(); return; }
      if (k === "ChannelUp" || k === "MediaTrackNext") { done(); this.surf(1); return; }
      if (k === "ChannelDown" || k === "MediaTrackPrevious") { done(); this.surf(-1); return; }
      if (k === "MediaPlayPause" || (k === "MediaPlay" && !on()) || ((k === "MediaPause" || k === "MediaStop") && on())) { done(); togglePlay(); return; }
      if (/^[0-9]$/.test(k) && !typing) { done(); this.digit(k); return; }
      if (k === "Guide") { done(); if (this.isFull()) this.full(false); else this.focusGuide(); return; }

      if (this.isFull()) {
        // Like a radio's tuning buttons: up is the next station.
        if (k === "ArrowUp") { done(); this.surf(1); }
        else if (k === "ArrowDown") { done(); this.surf(-1); }
        else if (k === "Enter" || k === " ") { done(); togglePlay(); }
        else if (dir) done();
        return;
      }
      if (!a || a === els.guide || a === document.body) {
        if (dir === "up" || dir === "down") { done(); this.move(dir === "up" ? -1 : 1); }
        else if (dir) { done(); this.step(dir === "left" ? -1 : 1); }
        else if (k === "Enter") { done(); this.ok(); }
        return;
      }
      // On a control: the arrows move between controls.
      // In the search box Left and Right move the caret until it reaches an end.
      if (typing && dir === "left" && a.selectionEnd > 0) return;
      if (typing && dir === "right" && a.selectionStart < a.value.length) return;
      if (typing && k === "Enter") { done(); this.focusGuide(); return; }
      if (a.tagName === "SELECT" && k === "Enter") { done(); try { a.showPicker(); } catch { /* opens itself */ } return; }
      if (dir) { done(); this.go(dir, a); }
    },
  };

  // ------------------------------------------------------------ boot
  async function boot() {
    readLayout();
    tick();
    setInterval(tick, 15000);
    try {
      const h = await fetch("api/health", { cache: "no-store" });
      const j = h.ok ? await h.json() : {};
      S.proxy = j.proxy === true;
      S.nowplaying = j.nowplaying === true;
    } catch { S.proxy = S.nowplaying = false; }
    Cast.init();
    try {
      load(await fetchData());
    } catch (err) {
      els.meta.textContent = "Couldn't load station data";
      els.empty.hidden = false;
      els.empty.innerHTML = `<strong>No station data</strong><span>${esc(err.message)}</span>`;
      return;
    }
    buildFilters();
    applyFilters();
    scrollToNow(false);

    const last = store.get("last", "");
    if (S.byId.has(last)) {
      S.sel = last;
      scrollToStation(last);
      render(true);
      showPanel();
      playPrompt(S.byId.get(last));
    }
    if (tvMode) TV.start();
    // Refresh live/past styling, the progress bar and the deck every 30 seconds.
    setInterval(() => { render(true); if (S.sel) showPanel(); renderDeck(); }, 30000);
    // Pick up new data (the server rebuilds it hourly) without a reload.
    setInterval(refresh, 10 * 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); if (S.playing) pollNow(false); } });
  }

  // Swap in newer data in place: keeps filters, selection, the station at the
  // top of the guide, the time in view and whatever is playing.
  async function refresh() {
    if (refresh.busy || Date.now() - (refresh.at || 0) < 60000) return;
    refresh.busy = true;
    try {
      const data = await fetchData();
      refresh.at = Date.now();
      if (data.sData.built === S.built) return;
      const g = els.guide;
      const topRow = Math.floor(Math.max(0, g.scrollTop) / S.ROW_H);
      const topId = S.list[topRow] && S.list[topRow].id;
      const leftMin = S.T0 + g.scrollLeft / S.PX;
      S.selProg = null;
      load(data);
      buildFilters();
      applyFilters(true);
      g.scrollLeft = (leftMin - S.T0) * S.PX;
      const i = S.list.findIndex((c) => c.id === topId);
      if (i >= 0) g.scrollTop = i * S.ROW_H;
      render(true);
      if (S.sel && S.byId.has(S.sel)) showPanel();
    } catch { /* keep showing what we have; try again next time */ }
    finally { refresh.busy = false; }
  }

  boot();
})();
