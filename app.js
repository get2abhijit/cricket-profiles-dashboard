/* Cricket Player Profiles dashboard (v2.4) - plain JS, no dependencies. */
(function () {
  "use strict";

  const DATA_DIR = "data/";
  const ACCESS_URL = "data/access.json";
  const SUMMARY_URL = "data/summary.json";
  const KEY_STORE = "cpp-access-key";
  const PAGE = 50;
  const REPO = (document.querySelector('meta[name="repo"]') || {}).content || "";
  const BATCH_KEY = "cpp-corrections-v1";
  const ERA_KEY = "cpp-era-v1";
  const SPLIT = "2021-01-01";   // the dataset's fixed era split (public aggregates use it)
  const STATUS = [
    { key: "complete", label: "Complete", color: "var(--good)", icon: "✓" },
    { key: "partial", label: "Partial", color: "var(--warning)", icon: "!" },
    { key: "missing", label: "Missing", color: "var(--critical)", icon: "✕" },
  ];
  const BOWL_CODES = [
    ["RF", "Right-arm fast"], ["RFM", "Right-arm fast-medium"], ["RMF", "Right-arm medium-fast"], ["RM", "Right-arm medium"], ["RSM", "Right-arm slow-medium"],
    ["LF", "Left-arm fast"], ["LFM", "Left-arm fast-medium"], ["LMF", "Left-arm medium-fast"], ["LM", "Left-arm medium"], ["LSM", "Left-arm slow-medium"],
    ["OB", "Off-break"], ["LB", "Leg-break"], ["LBG", "Leg-break googly"], ["SLA", "Slow left-arm orthodox"], ["LWS", "Left-arm wrist-spin"],
  ];
  const SPIN = new Set(["OB", "LOB", "LB", "LBG", "SLA", "LWS"]);
  const ROLES = ["Batter", "Opening batter", "Top-order batter", "Middle-order batter", "Wicketkeeper batter", "Batting allrounder", "Allrounder", "Bowling allrounder", "Bowler"];

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en"));
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

  const S = { all: [], byId: {}, meta: {}, filtered: [], page: 0, sort: ["t20i", -1], fix: [], xpage: 0, batch: {}, era: { mode: "all", cut: SPLIT } };

  /* ---------- era: all players, or either side of a cut-off date ---------- */
  function loadEra() {
    try { const e = JSON.parse(localStorage.getItem(ERA_KEY) || "null"); if (e && e.mode) S.era = { mode: e.mode, cut: e.cut || SPLIT }; } catch (e) { /* not available */ }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(S.era.cut)) S.era.cut = SPLIT;
  }
  function saveEra() { try { localStorage.setItem(ERA_KEY, JSON.stringify(S.era)); } catch (e) { /* not available */ } }
  const lastPlayed = (p) => (p.activity && p.activity.latest_match) || (p.era === "historical" ? "0000" : "9999");
  const isActive = (p) => lastPlayed(p) >= S.era.cut;
  const inEra = (p) => S.era.mode === "all" || (S.era.mode === "active") === isActive(p);
  const pool = () => S.all.filter(inEra);
  const cutLabel = () => new Date(S.era.cut + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const monthLabel = (d) => (d ? new Date(d.slice(0, 7) + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "—");

  /** Public visitors only have aggregates for the fixed split. */
  function publicView() {
    const sm = S.summary;
    if (S.era.mode === "all") return sm;
    return (sm.eras || {})[S.era.mode === "active" ? "current" : "historical"] || sm;
  }

  function initEra() {
    const bar = $("#erabar");
    bar.hidden = false;
    const cut = $("#era-cut");
    cut.max = new Date().toISOString().slice(0, 10);
    cut.disabled = !S.level;  // public aggregates exist only for the fixed split
    cut.title = S.level ? "Players whose latest T20I is on/after this date count as active" : "Sign in to choose your own cut-off date";
    if (!S.level) S.era.cut = SPLIT;
    cut.value = S.era.cut;
    if (bar.dataset.bound) { paintEraBar(); return; }
    bar.dataset.bound = "1";
    $$(".seg button", bar).forEach((b) => b.addEventListener("click", () => { S.era.mode = b.dataset.era; eraChanged(); }));
    cut.addEventListener("change", () => { if (/^\d{4}-\d{2}-\d{2}$/.test(cut.value)) { S.era.cut = cut.value; eraChanged(); } });
    $("#era-reset").addEventListener("click", () => { S.era.cut = SPLIT; cut.value = SPLIT; eraChanged(); });
    paintEraBar();
  }

  function paintEraBar() {
    $$(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.era === S.era.mode)));
    $("#era-reset").hidden = S.era.cut === SPLIT || !S.level;
    $("#era-cut").value = S.era.cut;
    let total, active;
    if (S.level) { total = S.all.length; active = S.all.filter(isActive).length; }
    else { const t = S.summary.totals || {}; total = t.players; active = t.current_players ?? (t.players - (t.historical_players || 0)); }
    $("#era-note").innerHTML = `<b>${fmt(total)}</b> players · <b>${fmt(active)}</b> active since ${cutLabel()} · <b>${fmt(total - active)}</b> earlier`;
  }

  function eraChanged() {
    saveEra();
    paintEraBar();
    if (!S.level) { showPublic(); return; }
    renderTiles(); renderTeams(); renderCodes(); renderYears();
    applyFilters(); renderFix();
  }

  /* ---------- storage (best effort) ---------- */
  function loadBatch() { try { S.batch = JSON.parse(localStorage.getItem(BATCH_KEY) || "{}") || {}; } catch (e) { S.batch = {}; } }
  function saveBatch() { try { localStorage.setItem(BATCH_KEY, JSON.stringify(S.batch)); } catch (e) { /* not available */ } }

  /* ---------- current values in edit vocabulary ---------- */
  function cur(p) {
    const r = p.role || {};
    let role = { batter: "Batter", bowler: "Bowler", allrounder: "Allrounder", "batting-allrounder": "Batting allrounder", "bowling-allrounder": "Bowling allrounder", "wicketkeeper-batter": "Wicketkeeper batter" }[r.primary] || "";
    if (role === "Batter" && r.batting_position) role = { opener: "Opening batter", "top-order": "Top-order batter", "middle-order": "Middle-order batter" }[r.batting_position] || role;
    return {
      bat: p.batting.code || "",
      bowl: p.bowling.code || (p.bowling.status === "does-not-bowl" ? "NONE" : ""),
      role,
      wk: r.is_wicketkeeper === true ? "yes" : r.is_wicketkeeper === false ? "no" : "",
    };
  }

  /* ---------- access ----------
     summary.json is public (aggregates). Player data is encrypted; an account
     (username + key) unwraps the data key for its level:
       view      reduced dataset, no downloads
       download  complete dataset + downloads
       admin     download + Fix data                                           */
  const can = (what) => ({ view: [], download: ["download"], admin: ["download", "fix"] }[S.level] || []).includes(what);
  function storedLogin() { try { return JSON.parse(localStorage.getItem(KEY_STORE) || "null"); } catch (e) { return null; } }
  function rememberLogin(v) { try { v ? localStorage.setItem(KEY_STORE, JSON.stringify(v)) : localStorage.removeItem(KEY_STORE); } catch (e) { /* not available */ } }
  const unb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  const enc = (t) => new TextEncoder().encode(t);
  class AccessError extends Error {}

  async function signIn(userRaw, keyRaw) {
    const user = userRaw.trim().toLowerCase();
    let key = keyRaw;
    const compact = key.replace(/[\s-]/g, "");
    if (user !== "admin" && /^[A-Za-z0-9]{20}$/.test(compact)) key = compact.toUpperCase();   // issued keys: case and dashes do not matter
    if (!S.access) {
      const r = await fetch(ACCESS_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error(`access file: HTTP ${r.status}`);
      S.access = await r.json();
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc(`cpp-user:${user}`)));
    const id = Array.from(digest.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
    const entry = S.access.users[id];
    if (!entry) throw new AccessError();
    let grant;
    try {
      const base = await crypto.subtle.importKey("raw", enc(key), "PBKDF2", false, ["deriveKey"]);
      const kek = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: unb64(entry.salt), iterations: S.access.iterations, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const wrap = unb64(entry.wrap);
      grant = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrap.slice(0, 12), additionalData: enc("CPP-ACCESS") }, kek, wrap.slice(12))));
    } catch (e) { throw new AccessError(); }
    const tier = grant.keys.full ? "full" : "view";
    const r = await fetch(`${DATA_DIR}${tier}.enc`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`data file: HTTP ${r.status}`);
    const blob = new Uint8Array(await r.arrayBuffer());
    const dek = await crypto.subtle.importKey("raw", unb64(grant.keys[tier]), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(4, 16), additionalData: blob.slice(0, 4) }, dek, blob.slice(16));
    const data = JSON.parse(await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
    S.user = user; S.level = grant.level;
    S.meta = data.meta || {}; S.byId = data.players; S.all = Object.values(data.players);
  }

  function showPublic() {
    $("#loading").hidden = true;
    const t = S.summary.totals || {};
    const when = S.summary.generated_at ? new Date(S.summary.generated_at).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "";
    $("#generated").textContent = when ? `data updated ${when}` : "";
    $("#foot-data").textContent = when ? `Dataset ${when}` : "";
    $("#lock-contact").href = ($('meta[name="contact"]') || {}).content || "#";
    if (!S.summary.protected) {
      $("#lock-form").hidden = true;
      $("#lock-summary").textContent = "Player-level data is not published at the moment.";
    }
    $("#lock").hidden = false;
    $(".controls").hidden = true;
    $("#tab-overview").hidden = false;
    if ($("#erabar").hidden) initEra();
    const v = publicView(), vt = v.totals || t;
    const tiles = [
      ["Players", fmt(vt.players), `${fmt(vt.teams)} teams · ${eraWords()}`, "--t-blue"],
      ["Complete profiles", `${pct(vt.complete, vt.players)}%`, `${fmt(vt.complete)} players`, "--t-green", pct(vt.complete, vt.players)],
      ["Batting hand", `${pct(vt.batting_hand, vt.players)}%`, `${fmt(vt.batting_hand)} known`, "--t-aqua", pct(vt.batting_hand, vt.players)],
      ["Bowling style", `${pct(vt.bowling_style, vt.players)}%`, `${fmt(vt.non_bowlers)} more are non-bowlers`, "--t-violet", pct(vt.bowling_style + vt.non_bowlers, vt.players)],
    ];
    paintTiles(tiles);
    renderStatusLegend();
    renderTeams();
    renderCodes();
    renderYears();
  }

  const eraWords = () => ({ all: "every era", active: `active since ${cutLabel()}`, before: `last played before ${cutLabel()}` }[S.era.mode]);

  async function init() {
    loadBatch();
    loadEra();
    $("#lock-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = $("#lock-user").value, key = $("#lock-key").value;
      if (!user.trim() || !key) { $("#lock-error").textContent = "Enter your username and key."; return; }
      $("#lock-go").disabled = true; $("#lock-go").textContent = "Signing in…"; $("#lock-error").textContent = "";
      try {
        await signIn(user, key);
        if ($("#lock-remember").checked) rememberLogin({ user, key });
        start();
      } catch (err) {
        $("#lock-error").textContent = err instanceof AccessError ? "Username or key is not correct." : `Could not open the dataset (${err.message}).`;
      }
      $("#lock-go").disabled = false; $("#lock-go").textContent = "Sign in";
    });
    $("#lock-btn").addEventListener("click", () => { rememberLogin(null); location.hash = ""; location.reload(); });
    try {
      const r = await fetch(SUMMARY_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S.summary = await r.json();
    } catch (err) {
      $("#loading").textContent = `Could not load the dashboard (${err.message}).`;
      return;
    }
    const ver0 = `v${S.summary.app_version || $('meta[name="app-version"]').content}`;
    $("#version").textContent = ver0; $("#foot-version").textContent = ver0;
    const saved = storedLogin();
    if (saved && saved.user && S.summary.protected) {
      try { await signIn(saved.user, saved.key); start(); return; } catch (err) { rememberLogin(null); }
    }
    showPublic();
  }

  function start() {
    $("#lock").hidden = true;
    $(".controls").hidden = false;
    $(".tabs").hidden = false;
    $("#loading").hidden = true;
    document.body.dataset.level = S.level;
    $('[data-tab="fix"]').hidden = !can("fix");
    $('[data-tab="data"]').hidden = !can("download");
    $("#f-csv").hidden = !can("download");
    $("#lock-btn").textContent = `Sign out · ${S.user} (${S.level})`;
    $("#team-hint").textContent = "Click a team to see its players";
    const ver = `v${S.meta.app_version || $('meta[name="app-version"]').content}`;
    $("#version").textContent = ver;
    $("#foot-version").textContent = ver;
    const when = new Date(S.meta.generated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    $("#generated").textContent = `data updated ${when}`;
    $("#foot-data").textContent = `Dataset ${when} · schema ${S.meta.schema_version}`;
    initEra();
    // drop batch items already applied by the workflow
    Object.values(S.batch).forEach((it) => { const p = S.byId[it.id]; if (it.sent && p && p.provenance.verification === "user") delete S.batch[it.id]; });
    saveBatch();

    renderTiles();
    renderStatusLegend();
    renderTeams();
    renderCodes();
    renderYears();
    initPlayers();
    initFix();
    initData();
    renderTray();
    initTabs();
  }

  /* ---------- tabs ---------- */
  function initTabs() {
    const show = (name) => {
      $("#detail").hidden = true;
      $$(".tabs button[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
      $$(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
      if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    };
    $$(".tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));

    const start = (location.hash || "#overview").slice(1);
    const allowed = ["overview", "players"].concat(can("fix") ? ["fix"] : [], can("download") ? ["data"] : []);
    show(allowed.includes(start) ? start : "overview");
    S.show = show;
  }

  /* ---------- overview ---------- */

  const fixable = (p) => needsFix(p) && (p.activity.in_scope !== false || p.era === "historical");

  function needsFix(p) {
    const bowlKnown = p.bowling.kind || ["does-not-bowl", "not-listed"].includes(p.bowling.status);
    return !(p.batting.hand && bowlKnown);
  }

  function renderTiles() {
    const c = pool(), n = c.length;
    const complete = c.filter((p) => p.status === "complete").length;
    const bat = c.filter((p) => p.batting.hand).length;
    const bowl = c.filter((p) => p.bowling.code).length;
    const nobowl = c.filter((p) => ["does-not-bowl", "not-listed"].includes(p.bowling.status)).length;
    const user = c.filter((p) => p.provenance.verification === "user").length;
    const verified = c.filter((p) => p.provenance.verified).length;
    const pending = c.filter((p) => p.provenance.verification === "pending").length;
    const tofix = c.filter(fixable).length;
    const tiles = [
      ["Players", fmt(n), `${new Set(c.flatMap((p) => p.teams)).size} teams · ${eraWords()}`, "--t-blue"],
      ["Complete", `${pct(complete, n)}%`, `${fmt(complete)} players`, "--t-green", pct(complete, n)],
      ["Batting hand", `${pct(bat, n)}%`, `${fmt(bat)} known`, "--t-aqua", pct(bat, n)],
      ["Bowling style", `${pct(bowl, n)}%`, `${fmt(nobowl)} more list no bowling`, "--t-violet", pct(bowl + nobowl, n)],
      ["Curated", fmt(verified + user), can("fix") ? `${fmt(user)} by you · ${fmt(pending)} pending check` : "hand-checked profiles", "--t-yellow"],
      ["To fix", fmt(tofix), "players missing data", "--t-orange"],
    ];
    paintTiles(can("fix") ? tiles : tiles.slice(0, 5));
    $("#fix-count").textContent = tofix || "";
  }

  function paintTiles(tiles) {
    $("#tiles").innerHTML = tiles.map(([l, v, note, c2, bar]) =>
      `<div class="tile" style="--tile:var(${c2})"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${note}</div>${bar != null ? `<div class="bar"><span style="width:${bar}%"></span></div>` : ""}</div>`).join("");
  }

  function renderStatusLegend() {
    $("#status-legend").innerHTML = STATUS.map((s) => `<span><i style="background:${s.color}"></i>${s.icon} ${s.label}</span>`).join("");
  }

  function teamRows() {
    if (!S.level) return (publicView().teams || []).map((r) => ({ ...r }));
    const m = {};
    pool().forEach((p) => p.teams.forEach((t) => {
      const r = (m[t] = m[t] || { team: t, players: 0, complete: 0, partial: 0, missing: 0 });
      r.players++; r[p.status]++;
    }));
    return Object.values(m);
  }

  function renderTeams() {
    const q = ($("#team-search").value || "").toLowerCase();
    const sort = $("#team-sort").value;
    const rows = teamRows().filter((r) => r.team.toLowerCase().includes(q));
    rows.sort({
      players: (a, b) => b.players - a.players,
      gaps: (a, b) => (b.partial + b.missing) - (a.partial + a.missing),
      pct: (a, b) => a.complete / a.players - b.complete / b.players,
      name: (a, b) => a.team.localeCompare(b.team),
    }[sort]);
    const max = Math.max(1, ...rows.map((r) => r.players));
    $("#team-chart").innerHTML = rows.map((r, i) => {
      const segs = STATUS.filter((s) => r[s.key] > 0).map((s) => `<span style="width:${(r[s.key] / max) * 100}%;background:${s.color}"></span>`).join("");
      return `<div class="team-row" data-i="${i}"><div class="name">${esc(r.team)}</div><div class="stack">${segs}</div><div class="val">${pct(r.complete, r.players)}%</div></div>`;
    }).join("") || `<p class="muted">No teams match.</p>`;
    $$(".team-row").forEach((el) => {
      const r = rows[el.dataset.i];
      el.addEventListener("mousemove", (e) => tip(e, `<b>${esc(r.team)}</b>${STATUS.map((s) => row(`${s.icon} ${s.label}`, r[s.key])).join("")}${row("Players", r.players)}`));
      el.addEventListener("mouseleave", hideTip);
      if (!S.level) { el.style.cursor = "default"; return; }
      el.addEventListener("click", () => { $("#f-team").value = r.team; applyFilters(); S.show("players"); });
    });
  }

  function renderCodes() {
    const order = ["RF", "RFM", "RMF", "RM", "RSM", "RS", "LF", "LFM", "LMF", "LM", "LSM", "LS", "OB", "LOB", "LB", "LBG", "SLA", "LWS"];
    const counts = {}; const labels = {};
    if (!S.level) (publicView().bowling_codes || []).forEach((r) => { counts[r.code] = r.players; labels[r.code] = r.label; });
    else pool().forEach((p) => { const c = p.bowling.code; if (c) { counts[c] = (counts[c] || 0) + 1; labels[c] = p.bowling.label; } });
    const items = order.filter((c) => counts[c]).map((c) => ({ code: c, n: counts[c], label: labels[c] }));
    const W = 420, rowH = 22, padL = 44, padR = 50, H = items.length * rowH + 6;
    const max = Math.max(1, ...items.map((i) => i.n));
    const bars = items.map((it, i) => {
      const y = i * rowH + 3, w = Math.max(4, ((W - padL - padR) * it.n) / max);
      const color = SPIN.has(it.code) ? "var(--spin)" : "var(--pace)";
      return `<g class="bar" data-i="${i}" style="cursor:pointer">
        <rect x="0" y="${y - 2}" width="${W}" height="${rowH}" fill="transparent"/>
        <text x="${padL - 8}" y="${y + 12}" text-anchor="end">${it.code}</text>
        <path d="M${padL},${y + 3} h${w - 4} a4,4 0 0 1 4,4 v6 a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${color}"/>
        <text x="${padL + w + 6}" y="${y + 12}">${fmt(it.n)}</text></g>`;
    }).join("");
    $("#code-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Players per bowling style">
      <line x1="${padL}" x2="${padL}" y1="0" y2="${H}" stroke="var(--axis)"/>${bars}</svg>`;
    $$("#code-chart .bar").forEach((g) => {
      const it = items[g.dataset.i];
      g.addEventListener("mousemove", (e) => tip(e, `<b>${it.code} · ${esc(it.label)}</b>${row("Players", it.n)}`));
      g.addEventListener("mouseleave", hideTip);
      if (!S.level) { g.style.cursor = "default"; return; }
      g.addEventListener("click", () => { $("#f-bowl").value = it.code; applyFilters(); S.show("players"); });
    });
    $("#code-table").innerHTML = `<table><tr><th>Code</th><th>Style</th><th>Players</th></tr>${items.map((i) => `<tr><td>${i.code}</td><td>${esc(i.label)}</td><td>${fmt(i.n)}</td></tr>`).join("")}</table>`;
  }

  /* ---------- players by year of latest T20I ---------- */
  function yearRows() {
    if (!S.level) return (S.summary.by_last_year || []).map((r) => ({ ...r }));
    const m = {};
    S.all.forEach((p) => {
      const y = (p.activity.latest_match || "").slice(0, 4);
      if (!y) return;
      const r = (m[y] = m[y] || { year: y, players: 0, complete: 0, active: 0 });
      r.players++; if (p.status === "complete") r.complete++; if (isActive(p)) r.active++;
    });
    return Object.values(m).sort((a, b) => a.year.localeCompare(b.year));
  }

  function renderYears() {
    const rows = yearRows();
    const host = $("#year-chart");
    if (!rows.length) { host.innerHTML = '<p class="muted">No activity dates in this dataset.</p>'; return; }
    rows.forEach((r) => { if (r.active == null) r.active = r.year >= S.era.cut.slice(0, 4) ? r.players : 0; });
    const W = 960, H = 230, padL = 40, padR = 10, padT = 18, padB = 26;
    const max = Math.max(1, ...rows.map((r) => r.players));
    const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 1 : 0.5);
    const ticks = []; for (let v = 0; v <= max; v += step) ticks.push(v);
    const slot = (W - padL - padR) / rows.length, bw = Math.max(6, Math.min(34, slot - 6));
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const dim = (r) => S.era.mode !== "all" && !(S.era.mode === "active" ? r.active : r.players - r.active);
    const bar = (x, top, bottom, color, round) => {
      const h = bottom - top; if (h <= 0) return "";
      const rr = round ? Math.min(4, h) : 0;
      return `<path d="M${x},${bottom} v${-(h - rr)} a${rr},${rr} 0 0 1 ${rr},${-rr} h${bw - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} z" fill="${color}"/>`;
    };
    const cutIdx = rows.findIndex((r) => r.year >= S.era.cut.slice(0, 4));
    const frac = (() => { const d = new Date(S.era.cut + "T00:00:00"); const start = new Date(d.getFullYear(), 0, 1); return (d - start) / 31536e6; })();
    const cutX = cutIdx < 0 ? W - padR : padL + slot * (cutIdx + (rows[cutIdx].year === S.era.cut.slice(0, 4) ? frac : 0));
    const bars = rows.map((r, i) => {
      const x = padL + i * slot + (slot - bw) / 2, base = y(0);
      const before = r.players - r.active;
      // earlier players sit at the baseline, active players stack above them (2px surface gap)
      const yb = y(before), ya = y(r.players);
      const seg1 = bar(x, yb, base, "var(--earlier)", r.active === 0);
      const seg2 = r.active ? bar(x, ya, before ? yb - 2 : base, "var(--active)", true) : "";
      const lab = rows.length <= 26 || i % 2 === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${rows.length > 14 ? "’" + r.year.slice(2) : r.year}</text>` : "";
      return `<g class="ybar${dim(r) ? " dim" : ""}" data-i="${i}"><rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>${seg1}${seg2}${lab}</g>`;
    }).join("");
    const grid = ticks.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("");
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Players by year of latest T20I">${grid}${bars}
      <line x1="${cutX}" x2="${cutX}" y1="${padT - 12}" y2="${H - padB}" class="cutline"/>
      <text x="${cutX + 5}" y="${padT - 3}" class="cutlabel">cut-off ${cutLabel()}</text></svg>`;
    $$("#year-chart .ybar").forEach((g) => {
      const r = rows[g.dataset.i];
      g.addEventListener("mousemove", (e) => tip(e, `<b>Last T20I in ${r.year}</b>${row("Players", r.players)}${row("Active since cut-off", r.active)}${row("Earlier", r.players - r.active)}${row("Complete profiles", r.complete)}${S.level ? '<div class="tip-hint">Click to move the cut-off to 1 Jan ' + r.year + "</div>" : ""}`));
      g.addEventListener("mouseleave", hideTip);
      if (!S.level) return;
      g.style.cursor = "pointer";
      g.addEventListener("click", () => { S.era.cut = `${r.year}-01-01`; eraChanged(); });
    });
    $("#year-table").innerHTML = `<table><tr><th>Year</th><th>Players</th><th>Active since cut-off</th><th>Complete</th></tr>${rows.map((r) => `<tr><td>${r.year}</td><td>${fmt(r.players)}</td><td>${fmt(r.active)}</td><td>${fmt(r.complete)}</td></tr>`).join("")}</table>`;
    $("#year-hint").textContent = S.level ? "Click a year to move the cut-off there · bars left of the line last played before it" : "Players left of the line last played a T20I before 2021";
  }

  /* ---------- tooltip ---------- */
  const row = (k, v) => `<div class="row"><span>${esc(k)}</span><span>${fmt(v)}</span></div>`;
  function tip(e, html) {
    const t = $("#tooltip"); t.innerHTML = html; t.hidden = false;
    const r = t.getBoundingClientRect();
    t.style.left = Math.min(innerWidth - r.width - 8, e.clientX + 14) + "px";
    t.style.top = Math.min(innerHeight - r.height - 8, e.clientY + 14) + "px";
  }
  function hideTip() { $("#tooltip").hidden = true; }

  /* ---------- cells ---------- */
  function statusCell(s) {
    const st = STATUS.find((x) => x.key === s);
    return `<span class="status"><i style="background:${st.color}">${st.icon}</i>${st.label}</span>`;
  }
  function batCell(p) { return p.batting.code ? `<span class="code bat">${p.batting.code}</span>` : '<span class="muted">—</span>'; }
  function bowlCell(p) {
    const b = p.bowling;
    if (b.code) return `<span class="code ${SPIN.has(b.code) ? "spin" : "pace"}">${b.code}</span> ${esc(b.label)}` +
      (b.also || []).map((c) => ` <span class="code ${SPIN.has(c) ? "spin" : "pace"}" title="also bowls">+${c}</span>`).join("");
    if (b.status === "not-listed") return '<span class="muted">none listed</span>';
    if (b.status === "does-not-bowl") return '<span class="muted">does not bowl</span>';
    if (b.arm) return `${b.arm === "R" ? "Right" : "Left"}-arm, style unknown`;
    return '<span class="muted">—</span>';
  }
  function curCell(p) {
    const v = p.provenance.verification;
    if (v === "user") return '<span class="cur user">✓ corrected by you</span>';
    if (v === "conflict") return '<span class="cur conflict">⚠ source conflict</span>';
    if (v === "pending") return '<span class="cur pending">◷ pending check</span>';
    if (p.provenance.verified) return '<span class="cur verified">✓ verified</span>';
    return `<span class="cur">${esc(p.provenance.bowling || p.provenance.batting || "—")}</span>`;
  }

  /* ---------- players ---------- */
  function initPlayers() {
    const teams = [...new Set(S.all.flatMap((p) => p.teams))].sort();
    const opts = teams.map((t) => `<option>${esc(t)}</option>`).join("");
    $("#f-team").insertAdjacentHTML("beforeend", opts);
    $("#x-team").insertAdjacentHTML("beforeend", opts);
    $("#f-bowl").insertAdjacentHTML("beforeend",
      `<option value="pace">All pace</option><option value="spin">All spin</option><option value="nobowl">No bowling listed</option><option value="unknown">Unknown</option>` +
      BOWL_CODES.map(([c, l]) => `<option value="${c}">${c} · ${l}</option>`).join(""));
    ["#f-q", "#f-team", "#f-status", "#f-bowl", "#f-cur"].forEach((s) => $(s).addEventListener("input", applyFilters));
    $("#team-search").addEventListener("input", renderTeams);
    $("#team-sort").addEventListener("input", renderTeams);
    $("#prev").addEventListener("click", () => { S.page--; renderTable(); });
    $("#next").addEventListener("click", () => { S.page++; renderTable(); });
    $("#f-csv").addEventListener("click", downloadCsv);
    $$("#players-table th[data-sort]").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.sort;
      S.sort = [k, S.sort[0] === k ? -S.sort[1] : k === "t20i" ? -1 : 1];
      applyFilters();
    }));
    applyFilters();
  }

  const sortKey = {
    name: (p) => (p.name || "").toLowerCase(), teams: (p) => p.teams.join(","), bat: (p) => p.batting.code || "~",
    bowl: (p) => p.bowling.code || "~", role: (p) => p.role.primary || "~", t20i: (p) => p.activity.t20i_matches || 0, last: (p) => lastPlayed(p),
    status: (p) => ["complete", "partial", "missing"].indexOf(p.status),
  };

  function matches(p) {
    const q = $("#f-q").value.trim().toLowerCase(), team = $("#f-team").value, st = $("#f-status").value;
    const bowl = $("#f-bowl").value, curf = $("#f-cur").value;
    if (!inEra(p)) return false;
    if (q && !`${p.name} ${p.registry_name} ${p.id} ${Object.values(p.ids).join(" ")}`.toLowerCase().includes(q)) return false;
    if (team && !p.teams.includes(team)) return false;
    if (st && p.status !== st) return false;
    if (bowl) {
      if (bowl === "pace" || bowl === "spin") { if (p.bowling.kind !== bowl) return false; }
      else if (bowl === "nobowl") { if (!["not-listed", "does-not-bowl"].includes(p.bowling.status)) return false; }
      else if (bowl === "unknown") { if (p.bowling.status !== "unknown") return false; }
      else if (p.bowling.code !== bowl) return false;
    }
    if (curf === "verified" ? !p.provenance.verified : curf && p.provenance.verification !== curf) return false;
    return true;
  }

  function applyFilters() {
    const [k, dir] = S.sort;
    S.filtered = S.all.filter(matches).sort((a, b) => {
      const x = sortKey[k](a), y = sortKey[k](b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || (a.name || "").localeCompare(b.name || "");
    });
    S.page = 0;
    renderTable();
    renderChips();
  }

  function renderChips() {
    const chips = [];
    const add = (sel, text) => chips.push({ sel, text });
    if ($("#f-q").value.trim()) add("#f-q", `“${$("#f-q").value.trim()}”`);
    ["#f-team", "#f-status", "#f-bowl", "#f-cur"].forEach((sel) => { const el = $(sel); if (el.value) add(sel, el.options[el.selectedIndex].text); });
    const era = S.era.mode === "all" ? "" : S.era.mode === "active" ? `Active since ${cutLabel()}` : `Before ${cutLabel()}`;
    $("#chips").innerHTML = (era ? `<span class="chip era">${esc(era)}</span>` : "") +
      chips.map((c, i) => `<button class="chip" data-i="${i}" title="Remove filter">${esc(c.text)} <span aria-hidden="true">✕</span></button>`).join("") +
      (chips.length > 1 ? '<button class="chip clear" id="chips-clear">Clear all</button>' : "");
    $$("#chips .chip[data-i]").forEach((b) => b.addEventListener("click", () => { $(chips[b.dataset.i].sel).value = ""; applyFilters(); }));
    const clr = $("#chips-clear");
    if (clr) clr.addEventListener("click", () => { chips.forEach((c) => ($(c.sel).value = "")); applyFilters(); });
  }

  function renderTable() {
    const n = S.filtered.length, pages = Math.max(1, Math.ceil(n / PAGE));
    S.page = Math.max(0, Math.min(S.page, pages - 1));
    $("#players-table tbody").innerHTML = S.filtered.slice(S.page * PAGE, (S.page + 1) * PAGE).map((p) =>
      `<tr data-id="${p.id}"><td class="pname">${esc(p.name)}${S.era.mode === "all" && !isActive(p) ? ' <span class="tag">earlier</span>' : ""}</td><td>${esc(p.teams.join(", "))}</td><td>${batCell(p)}</td><td>${bowlCell(p)}</td>
       <td>${esc(cur(p).role)}${p.role.is_wicketkeeper && p.role.primary !== "wicketkeeper-batter" ? " · wk" : ""}</td>
       <td class="num">${fmt(p.activity.t20i_matches)}</td><td class="when">${monthLabel(p.activity.latest_match)}</td><td>${statusCell(p.status)}</td><td>${curCell(p)}</td></tr>`).join("");
    $("#result-count").textContent = `${fmt(n)} player${n === 1 ? "" : "s"}${n > PAGE ? ` · showing ${fmt(S.page * PAGE + 1)}–${fmt(Math.min(n, (S.page + 1) * PAGE))}` : ""}`;
    $("#page").textContent = `Page ${S.page + 1} of ${pages}`;
    $("#prev").disabled = S.page === 0;
    $("#next").disabled = S.page >= pages - 1;
    $$("#players-table tbody tr").forEach((tr) => tr.addEventListener("click", () => showDetail(tr.dataset.id)));
  }

  // Quote every cell; prefix cells a spreadsheet would run as a formula.
  const csvCell = (v) => { let t = String(v ?? ""); if (/^[=+\-@]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  function saveFile(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  }
  function fullCsv() {
    const idKeys = ["cricinfo", "cricbuzz", "cricketarchive", "opta", "nvplay", "pulse", "bcci"];
    const cols = ["id", "name", "registry_name", "teams", "era", "batting_code", "bowling_status", "bowling_code", "bowling_kind", "bowling_pace", "bowling_spin", "bowling_also", "bowling_label",
      "role", "batting_position", "is_wicketkeeper", "status", "t20i_matches", "first_match", "latest_match", "prov_batting", "prov_bowling", "verification", ...idKeys.map((k) => `${k}_id`), "profile_url"];
    const rows = S.all.map((p) => [p.id, p.name, p.registry_name, p.teams.join("|"), p.era, p.batting.code, p.bowling.status, p.bowling.code, p.bowling.kind, p.bowling.pace, p.bowling.spin, (p.bowling.also || []).join("|"), p.bowling.label,
      p.role.primary, p.role.batting_position, p.role.is_wicketkeeper, p.status, p.activity.t20i_matches, p.activity.first_match, p.activity.latest_match, p.provenance.batting, p.provenance.bowling, p.provenance.verification,
      ...idKeys.map((k) => p.ids[k]), p.profile_url].map(csvCell).join(","));
    return "\ufeff" + [cols.join(",")].concat(rows).join("\n");
  }

  function downloadCsv() {
    const cols = ["id", "name", "teams", "era", "batting", "bowling_code", "bowling_label", "bowling_status", "role", "is_wicketkeeper", "t20i_matches", "latest_match", "status", "cricinfo_id"];
    const q = csvCell;
    const lines = [cols.join(",")].concat(S.filtered.map((p) => [p.id, p.name, p.teams.join("|"), p.era, p.batting.code, p.bowling.code, p.bowling.label, p.bowling.status, p.role.primary, p.role.is_wicketkeeper, p.activity.t20i_matches, p.activity.latest_match, p.status, p.ids.cricinfo].map(q).join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "players_filtered.csv";
    a.click();
  }

  /* ---------- edit controls ---------- */
  const optList = (items, value, blank) => `<option value="">${blank}</option>` + items.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join("");
  const selBat = (v) => `<select data-k="bat">${optList([["RHB", "RHB"], ["LHB", "LHB"]], v, "—")}</select>`;
  const selBowl = (v) => `<select data-k="bowl">${optList([["NONE", "Does not bowl"], ...BOWL_CODES.map(([c, l]) => [c, `${c} · ${l}`])], v, "—")}</select>`;
  const selRole = (v) => `<select data-k="role">${optList(ROLES.map((r) => [r, r]), v, "—")}</select>`;
  const selWk = (v) => `<select data-k="wk">${optList([["yes", "Yes"], ["no", "No"]], v, "—")}</select>`;

  /** Stage changes for player p from a container holding [data-k] controls. */
  function stageFrom(p, container, forceAll) {
    const c = cur(p);
    const item = { ...(S.batch[p.id] || {}), id: p.id, label: p.name, team: p.teams[0] || "" };
    delete item.sent;
    $$("[data-k]", container).forEach((el) => {
      const k = el.dataset.k, v = (el.value || "").trim();
      if (!v || (["bat", "bowl", "role", "wk"].includes(k) && v === c[k] && !forceAll)) { delete item[k]; return; }
      item[k] = v;
    });
    const keys = Object.keys(item).filter((k) => !["id", "label", "team"].includes(k));
    if (keys.length) S.batch[p.id] = item; else delete S.batch[p.id];
    saveBatch();
    renderTray();
    return keys.length;
  }

  /* ---------- fix tab ---------- */
  function initFix() {
    ["#x-mode", "#x-team"].forEach((s) => $(s).addEventListener("input", () => { S.xpage = 0; renderFix(); }));
    $("#x-prev").addEventListener("click", () => { S.xpage--; renderFix(); });
    $("#x-next").addEventListener("click", () => { S.xpage++; renderFix(); });
    renderFix();
  }

  function renderFix() {
    const mode = $("#x-mode").value, team = $("#x-team").value;
    S.fix = pool().filter((p) => {
      if (team && !p.teams.includes(team)) return false;
      if (mode === "pending") return p.provenance.verification === "pending";
      if (mode === "conflict") return p.provenance.verification === "conflict";
      return fixable(p);
    }).sort((a, b) => (b.activity.t20i_matches || 0) - (a.activity.t20i_matches || 0) || (a.name || "").localeCompare(b.name || ""));
    const n = S.fix.length, pages = Math.max(1, Math.ceil(n / PAGE));
    S.xpage = Math.max(0, Math.min(S.xpage, pages - 1));
    $("#x-count").textContent = n ? `${fmt(n)} players · most capped first` : "Nothing to fix here 🎉";
    $("#fix-table tbody").innerHTML = S.fix.slice(S.xpage * PAGE, (S.xpage + 1) * PAGE).map((p) => {
      const c = cur(p), staged = S.batch[p.id] || {};
      const v = (k) => staged[k] || c[k];
      const links = [
        p.profile_url ? `<a href="${esc(p.profile_url)}" target="_blank" rel="noopener">profile</a>` : "",
        p.ids.cricbuzz ? `<a href="https://www.cricbuzz.com/profiles/${esc(p.ids.cricbuzz)}/player" target="_blank" rel="noopener">cricbuzz</a>` : "",
        `<a href="https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.teams[0] || ""} cricketer batting style`)}" target="_blank" rel="noopener">search</a>`,
      ].filter(Boolean).join(" · ");
      const confirm = mode !== "missing" ? `<button class="btn small confirm" title="Current values are correct">✓ Confirm</button>` : "";
      return `<tr data-id="${p.id}" class="${S.batch[p.id] ? "staged" : ""}"><td><a href="#" class="open">${esc(p.name)}</a></td><td>${esc(p.teams.join(", "))}</td>
        <td class="num">${fmt(p.activity.t20i_matches)}</td><td class="when">${monthLabel(p.activity.latest_match)}</td><td>${selBat(v("bat"))}</td><td>${selBowl(v("bowl"))}</td><td>${selRole(v("role"))}</td><td>${selWk(v("wk"))}</td>
        <td>${links}</td><td>${confirm}</td></tr>`;
    }).join("");
    $("#x-page").textContent = `Page ${S.xpage + 1} of ${pages}`;
    $("#x-prev").disabled = S.xpage === 0;
    $("#x-next").disabled = S.xpage >= pages - 1;
    $$("#fix-table tbody tr").forEach((tr) => {
      const p = S.byId[tr.dataset.id];
      $$("select", tr).forEach((sel) => sel.addEventListener("change", () => tr.classList.toggle("staged", stageFrom(p, tr) > 0)));
      const btn = $(".confirm", tr);
      if (btn) btn.addEventListener("click", () => tr.classList.toggle("staged", stageFrom(p, tr, true) > 0));
      $(".open", tr).addEventListener("click", (e) => { e.preventDefault(); showDetail(p.id); });
    });
  }

  /* ---------- detail panel ---------- */
  function showDetail(id) {
    const p = S.byId[id];
    if (!p) return;
    const c = cur(p), staged = S.batch[id] || {};
    const v = (k) => staged[k] || c[k];
    const ids = Object.entries(p.ids).filter(([, x]) => typeof x === "string").map(([k, x]) => `${k}: ${esc(x)}`).join("<br>");
    const el = $("#detail");
    el.innerHTML = `<div class="head"><button class="btn small close" aria-label="Close">✕</button>
        <h2>${esc(p.name)}</h2><p>${esc(p.teams.join(", "))} · ${isActive(p) ? `active since ${cutLabel()}` : `last played before ${cutLabel()}`}${can("download") ? ` · <code>${p.id}</code>` : ""}</p></div>
      <div class="body">
        <dl>
          <dt>Batting</dt><dd>${batCell(p)} <span class="muted">${esc(p.provenance.batting || "")}</span></dd>
          <dt>Bowling</dt><dd>${bowlCell(p)} <span class="muted">${esc(p.provenance.bowling || "")}</span></dd>
          <dt>Role</dt><dd>${esc(c.role || "—")}${p.role.is_wicketkeeper ? " · wicketkeeper" : ""}</dd>
          <dt>Completeness</dt><dd>${statusCell(p.status)}</dd>
          <dt>Curation</dt><dd>${curCell(p)}</dd>
          <dt>T20Is</dt><dd>${fmt(p.activity.t20i_matches)}${p.activity.first_match ? ` · first ${esc(p.activity.first_match)}` : ""}${p.activity.latest_match ? ` · last ${esc(p.activity.latest_match)}` : ""}</dd>
          ${can("download") ? `<dt>Source text</dt><dd>${esc([p.raw.batting_style, p.raw.bowling_style, p.raw.role].filter(Boolean).join(" · ") || "—")}</dd>
          <dt>Profile</dt><dd>${p.profile_url ? `<a href="${esc(p.profile_url)}" target="_blank" rel="noopener">open ↗</a>` : "—"}</dd>
          <dt>IDs</dt><dd>${ids || "—"}</dd>` : ""}
          ${p.notes ? `<dt>Notes</dt><dd>${esc(p.notes)}</dd>` : ""}
        </dl>
${can("fix") ? `        <h3>Edit</h3>
        <div class="edit-form" id="edit-form">
          <label>Batting ${selBat(v("bat"))}</label>
          <label>Bowling ${selBowl(v("bowl"))}</label>
          <label>Role ${selRole(v("role"))}</label>
          <label>Wicketkeeper ${selWk(v("wk"))}</label>
          <label>Cricinfo ID <input data-k="cricinfo" inputmode="numeric" value="${esc(staged.cricinfo || "")}" placeholder="${esc(p.ids.cricinfo || "")}" /></label>
          <label>Display name <input data-k="name" value="${esc(staged.name || "")}" placeholder="${esc(p.name)}" /></label>
          <label class="wide">Note <input data-k="note" value="${esc(staged.note || "")}" placeholder="optional, e.g. where you checked" /></label>
          <div class="wide"><button class="btn primary" id="add-batch">${S.batch[id] ? "Update batch" : "Add to batch"}</button>
            <button class="btn" id="confirm-batch" title="Current values are correct">✓ Values are correct</button></div>
        </div>
` : ""}
      </div>`;
    el.hidden = false;
    $(".close", el).addEventListener("click", () => (el.hidden = true));
    if (!can("fix")) return;
    $("#add-batch").addEventListener("click", (e) => { const n = stageFrom(p, $("#edit-form")); e.target.textContent = n ? "Added ✓" : "No changes"; renderFix(); });
    $("#confirm-batch").addEventListener("click", (e) => { const n = stageFrom(p, $("#edit-form"), true); e.target.textContent = n ? "Added ✓" : "Nothing to confirm"; renderFix(); });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#detail").hidden = true; });

  /* ---------- batch tray ---------- */
  const describe = (it) => ["bat", "bowl", "role", "wk", "cricinfo", "name", "note"].filter((k) => it[k]).map((k) => `${k} ${it[k]}`).join(", ");

  function payloadItem(it) {
    const o = { id: it.id };
    if (it.bat) o.bat = it.bat;
    if (it.bowl) o.bowl = it.bowl;
    if (it.role) o.role = it.role;
    if (it.wk) o.wk = it.wk === "yes";
    if (it.cricinfo) o.cricinfo = it.cricinfo;
    if (it.name) o.name = it.name;
    if (it.note) o.note = it.note;
    return o;
  }

  function issueUrl(items) {
    const table = items.map((it) => `| ${it.label} (${it.team}) | ${describe(it)} |`).join("\n");
    const json = JSON.stringify({ corrections: items.map(payloadItem) }, null, 0).replace(/\},\{/g, "},\n{");
    const body = `${items.length} correction(s) from the dashboard. Press **Create** to apply them.\n\n| Player | Change |\n|---|---|\n${table}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
    const q = new URLSearchParams({ title: `Player corrections (${items.length})`, labels: "player-corrections", body });
    return `https://github.com/${REPO}/issues/new?${q}`;
  }

  function renderTray() {
    const items = Object.values(S.batch);
    const pending = items.filter((i) => !i.sent);
    $("#tray").hidden = items.length === 0;
    $("#tray-count").textContent = pending.length
      ? `${pending.length} correction${pending.length > 1 ? "s" : ""} ready${items.length > pending.length ? ` · ${items.length - pending.length} sent` : ""}`
      : `${items.length} sent, waiting to be applied`;
    $("#tray-submit").disabled = pending.length === 0;
    const list = $("#tray-list");
    list.innerHTML = items.map((it) => `<div class="tray-item${it.sent ? " sent" : ""}" data-id="${it.id}"><strong>${esc(it.label)}</strong><span class="what">${esc(describe(it))}${it.sent ? " · sent" : ""}</span><button class="btn small rm">Remove</button></div>`).join("")
      + `<div class="tray-note">Saved in this browser until submitted. <a href="#" id="tray-clear">Clear all</a></div>`;
    $$(".tray-item .rm", list).forEach((b) => b.addEventListener("click", () => { delete S.batch[b.closest(".tray-item").dataset.id]; saveBatch(); renderTray(); renderFix(); }));
    const clear = $("#tray-clear", list);
    if (clear) clear.addEventListener("click", (e) => { e.preventDefault(); S.batch = {}; saveBatch(); renderTray(); renderFix(); });
  }

  $("#tray-toggle").addEventListener("click", () => { const l = $("#tray-list"); l.hidden = !l.hidden; $("#tray-toggle").textContent = l.hidden ? "Review" : "Hide"; });
  $("#tray-submit").addEventListener("click", () => {
    let items = Object.values(S.batch).filter((i) => !i.sent);
    while (items.length > 1 && issueUrl(items).length > 7500) items = items.slice(0, items.length - 1);
    window.open(issueUrl(items), "_blank", "noopener");
    items.forEach((i) => (S.batch[i.id].sent = true));
    saveBatch();
    renderTray();
    const left = Object.values(S.batch).filter((i) => !i.sent).length;
    if (left) $("#tray-count").textContent += ` · press Submit again for the remaining ${left}`;
  });

  /* ---------- data tab ---------- */
  function initData() {
    const base = new URL(".", location.href).href;
    $$(".base").forEach((s) => (s.textContent = base));
    $("#dl-json").addEventListener("click", () => saveFile("players.json", JSON.stringify({ meta: S.meta, players: S.byId }), "application/json"));
    $("#dl-csv").addEventListener("click", () => saveFile("players.csv", fullCsv(), "text/csv"));
  }

  init();
})();
