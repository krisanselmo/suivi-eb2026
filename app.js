/* Crew page — wiring only. The model lives in sim.js, the data in data.js.
 *
 * Everything derives from four pieces of state: the slider params, which shunts are on,
 * the start time, and an optional live re-fit. One render() rebuilds the whole page from
 * them, which is cheap enough here (2133 course points) and removes any chance of the
 * table and the profile disagreeing.
 */

const D = window.EB_DATA;
const S = window.EBSim;

const KNOBS = [
  { key: "vam", label: "VAM montée", min: 300, max: 1200, step: 10, unit: "m/h", nd: 0,
    hint: "vitesse verticale en montée, une fois en marche" },
  { key: "vamDown", label: "VAM descente", min: 400, max: 3000, step: 20, unit: "m/h", nd: 0,
    hint: "vitesse de perte d\u2019altitude en descente raide" },
  { key: "steepDownPct", label: "Seuil descente raide", min: 10, max: 40, step: 1, unit: "%", nd: 0,
    hint: "pente \u00e0 partir de laquelle c\u2019est la VAM descente qui gouverne, plus l\u2019allure" },
  { key: "flatMinKm", label: "Allure à plat", min: 4, max: 12, step: 0.1, unit: "min/km", nd: 2,
    hint: "allure sur le plat, \u00e0 froid, avant la d\u00e9rive" },
  { key: "hikePct", label: "Seuil de marche", min: 5, max: 25, step: 0.5, unit: "%", nd: 1,
    hint: "pente au-del\u00e0 de laquelle on arr\u00eate de courir" },
  { key: "upPenalty", label: "Coût de la montée courue", min: 0, max: 10, step: 0.1, unit: "%/1%", nd: 1,
    hint: "vitesse perdue par point de pente, tant qu\u2019on court" },
  { key: "downGain", label: "Relance en descente", min: 0, max: 60, step: 1, unit: "% à −10 %", nd: 0,
    hint: "vitesse gagn\u00e9e en descente courue" },
  { key: "driftPct", label: "Dérive de fatigue", min: 0, max: 40, step: 0.5, unit: "%/10 h", nd: 1,
    hint: "vitesse perdue par tranche de 10 h" },
  { key: "techPct", label: "Coût technicité", min: 0, max: 30, step: 0.5, unit: "%/niveau", nd: 1,
    hint: "vitesse perdue par niveau de difficult\u00e9 du terrain" },
  { key: "stopMin", label: "Arrêt par ravito", min: 0, max: 20, step: 0.5, unit: "min", nd: 1,
    hint: "temps pass\u00e9 \u00e0 chaque ravitaillement" },
];

const DAYS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

const byId = (id) => (D.shunts || []).find((s) => s.id === id);
const NAME = (p) => p.display || p.name;
/** French decimal comma — this page is read by family, not by a terminal. */
const fr = (v, nd) => v.toFixed(nd === undefined ? 1 : nd).replace(".", ",");

const state = {
  params: Object.assign({}, D.profile.params),
  shunts: {},
  start: D.race.start_hour * 3600,
  scale: 1,
  obs: [],       // observed passages: [{ name, elapsed }], kept sorted by course km
  posSec: null,  // elapsed second the map marker shows; null = not set yet
  preset: "me",  // which scenario button is lit
};

// Light-theme chart palette, kept next to the CSS variables it mirrors.
const C = {
  ink: "#14181c", body: "#3d444b", muted: "#6b7379", faint: "#98a0a7",
  line: "#e3e5e8", night: "#e9ebed", accent: "#1f6b47", fill: "#eceef0",
};

/* ---------- persistence ----------
 *
 * Everything the reader set is kept on their device, so closing the page at 2am and
 * reopening it at the next aid station does not lose the re-fit. Writes are debounced: the
 * position slider fires on every pixel and localStorage is synchronous.
 */

const LS_KEY = "eb2026-crew";
let saveTimer = null;

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        params: state.params, shunts: state.shunts, start: state.start,
        scale: state.scale, obs: state.obs, posSec: state.posSec, preset: state.preset,
      }));
    } catch (e) { /* private browsing, quota — the page still works, just forgets */ }
  }, 250);
}

/** Read stored state back, validating every field: a stale or hand-edited blob must not
 *  be able to produce NaN times. Returns what was accepted. */
function restore() {
  let raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch (e) { return {}; }
  if (!raw) return {};
  let v;
  try { v = JSON.parse(raw); } catch (e) { return {}; }
  if (!v || typeof v !== "object") return {};
  const got = {};

  if (v.params && typeof v.params === "object") {
    const out = Object.assign({}, D.profile.params);
    for (const k of KNOBS) {
      const n = Number(v.params[k.key]);
      if (Number.isFinite(n) && n >= k.min && n <= k.max) out[k.key] = n;
    }
    state.params = out;
    got.params = true;
  }
  if (v.shunts && typeof v.shunts === "object") {
    for (const sh of (D.shunts || [])) {
      // a shunt whose geometry is still missing can never be on, whatever was stored
      if (sh.bypass && v.shunts[sh.id] === true) state.shunts[sh.id] = true;
    }
    got.shunts = true;
  }
  if (Number.isFinite(v.start) && v.start >= 0 && v.start < 86400) {
    state.start = v.start;
    got.start = true;
  }
  if (Number.isFinite(v.scale) && v.scale > 0.2 && v.scale < 4) {
    state.scale = v.scale;
    got.scale = true;
  }
  if (Number.isFinite(v.posSec) && v.posSec >= 0) {
    state.posSec = v.posSec;
    got.posSec = true;
  }
  if (typeof v.preset === "string" || v.preset === null) got.preset = v.preset;

  // Observed passages: keep only those whose point still exists, dedupe by name, sort by km.
  const stored = Array.isArray(v.obs) ? v.obs
    // one stored `fit` from the single-point version migrates to a one-item list
    : (v.fit && typeof v.fit === "object" ? [v.fit] : []);
  const seen = new Set();
  const obs = [];
  for (const o of stored) {
    if (!o || typeof o.name !== "string" || !Number.isFinite(o.elapsed)) continue;
    if (o.elapsed < 0 || o.elapsed > 3 * 86400) continue;
    const poi = D.pois.find((x) => x.name === o.name);
    if (!poi || seen.has(o.name)) continue;
    seen.add(o.name);
    obs.push({ name: o.name, elapsed: o.elapsed, km: poi.course_km });
  }
  obs.sort((a, b) => a.km - b.km);
  if (obs.length) got.obs = obs.map((o) => ({ name: o.name, elapsed: o.elapsed }));
  return got;
}

function resetAll() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* nothing to clear */ }
  state.params = Object.assign({}, D.profile.params);
  state.shunts = {};
  state.start = D.race.start_hour * 3600;
  state.scale = 1;
  state.obs = [];
  state.posSec = null;
  state.preset = "me";
  document.getElementById("startTime").value = clockOf(0).hhmm;
  document.querySelectorAll("#shunts input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  const out = document.getElementById("fitOut");
  out.className = "fitout";
  out.textContent = "";
  const sel = document.getElementById("fitPoi");
  document.getElementById("fitTime").value = "";
  if (sel.options.length) sel.selectedIndex = 0;
  markPreset();
  persist();
  render();
}

/* ---------- formatting ---------- */

function hms(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 60 ? `${h + 1}h00` : `${h}h${String(m).padStart(2, "0")}`;
}

function signed(sec) {
  const s = Math.round(sec / 60);
  if (Math.abs(s) < 1) return "—";
  const a = Math.abs(s);
  const txt = a >= 60 ? `${Math.floor(a / 60)}h${String(a % 60).padStart(2, "0")}` : `${a} min`;
  return (s > 0 ? "+" : "−") + txt;
}

/** Race second -> { day, hhmm }. Day 0 is race day; the race runs into the next one. */
function clockOf(sec) {
  const abs = state.start + sec;
  const dayOffset = Math.floor(abs / 86400);
  const rem = abs - dayOffset * 86400;
  const base = new Date(D.race.date + "T00:00:00");
  base.setDate(base.getDate() + dayOffset);
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  return { day: DAYS[base.getDay()], hhmm: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
           dayOffset, secOfDay: rem };
}

function hhmmToSec(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

/** Is this instant after sunset / before sunrise? Sun times are valley values. */
function isNight(sec) {
  if (!D.sun) return false;
  const c = clockOf(sec);
  const set = hhmmToSec(D.sun.sunset);
  const rise = hhmmToSec(c.dayOffset > 0 ? (D.sun.sunrise_next || D.sun.sunrise) : D.sun.sunrise);
  if (c.dayOffset === 0) return c.secOfDay >= set || c.secOfDay < rise;
  return c.secOfDay < rise;
}

/* ---------- model ---------- */

/**
 * Run the model for the current state and align every POI onto the result.
 *
 * With observed passages present, the speed profile becomes piecewise — one factor per leg
 * between two observations, fitted so each leg reproduces its measured duration — and the
 * flat `scale` is ignored. `fit` carries what was solved, for the summary line.
 */
function run(params, scale) {
  const built = S.applyShunts(D.course, D.shunts, state.shunts);
  const stops = D.stops.map((k) => S.mapKm(built.cuts, k)).filter((k) => k !== null);

  const obs = liveObs(built.cuts);
  let fit = null;
  let profile = scale;
  if (obs.length) {
    fit = S.fitLegs(built.course, stops, params, D.tech, D.sections, D.bounds, obs);
    profile = fit.scales;
  }

  const res = S.simulate(built.course, stops, params, D.tech, D.sections, D.bounds, profile);
  const lastObsSec = obs.length ? obs[obs.length - 1].elapsed : null;
  const rows = D.pois.map((p) => {
    const km = S.mapKm(built.cuts, p.course_km);
    const sec = km === null ? null : S.secAtKm(built.course, res.tAt, km);
    return {
      poi: p,
      cut: km === null,
      sec,
      // official km, shifted by whatever the upstream cuts removed
      showKm: km === null ? null : p.km + (km - p.course_km),
      observed: obs.some((o) => o.name === p.name),
      past: sec !== null && lastObsSec !== null && sec < lastObsSec - 30,
    };
  });
  return { built, res, rows, obs, fit };
}

/**
 * The observations that are usable right now: point still on the course, sorted by km, and
 * strictly increasing in time. A pair that goes backwards in time is impossible, so the
 * later entry is dropped rather than fed to the solver.
 */
function liveObs(cuts) {
  const out = [];
  for (const o of state.obs) {
    const poi = D.pois.find((p) => p.name === o.name);
    if (!poi) continue;
    const km = S.mapKm(cuts, poi.course_km);
    if (km === null) continue;
    out.push({ name: o.name, km, elapsed: o.elapsed });
  }
  out.sort((a, b) => a.km - b.km);
  const clean = [];
  for (const o of out) {
    if (clean.length && o.elapsed <= clean[clean.length - 1].elapsed) continue;
    clean.push(o);
  }
  return clean;
}

/** The reference every "écart" is measured against: my profile, full course, no re-fit. */
function baseline() {
  const saveShunts = state.shunts;
  const saveObs = state.obs;
  state.shunts = {};
  state.obs = [];
  const out = run(D.profile.params, 1);
  state.shunts = saveShunts;
  state.obs = saveObs;
  const by = {};
  out.rows.forEach((r) => { if (r.sec !== null) by[r.poi.name] = r.sec; });
  return { by, total: out.res.total };
}

const BASE = baseline();

/* ---------- render ---------- */

function render() {
  const { built, res, rows, obs, fit } = run(state.params, state.scale);

  document.getElementById("totalTime").textContent = hms(res.total);
  const fin = clockOf(res.total);
  document.getElementById("finishClock").textContent = `${fin.day} ${fin.hhmm}`;
  const cutDp = built.cuts.reduce((t, c) => t + byId(c.id).removes.dplus - (byId(c.id).bypass.dplus || 0), 0);
  document.getElementById("totalDist").textContent =
    `${fr(D.race.official_dist_km + built.shift)} km / ${D.race.official_dplus - cutDp} m`;
  document.getElementById("totalSplit").textContent = `${hms(res.movingSec)} / ${hms(res.stopSec)}`;

  // clamp the map clock into the (possibly shunted, possibly re-fitted) new total
  if (state.posSec === null) state.posSec = defaultPosSec(res.total);
  state.posSec = Math.max(0, Math.min(res.total, state.posSec));

  renderObs(obs, fit);
  renderFitSummary(obs, fit, res);
  renderSplits(rows, res);
  renderMap(built.course, res, rows);
  renderProfile(built.course, res, rows);
  renderKnobValues();
  renderShuntEffects();
}

/** Where the map opens: the real clock if the race is running, the start otherwise. */
function defaultPosSec(total) {
  const now = new Date();
  const start = new Date(D.race.date + "T00:00:00");
  start.setSeconds(state.start);
  const el = (now - start) / 1000;
  return el > 0 && el < total ? el : 0;
}

function renderSplits(rows, res) {
  const tb = document.querySelector("#splits tbody");
  tb.innerHTML = "";
  let cutCount = 0;
  for (const r of rows) {
    const p = r.poi;
    const tr = document.createElement("tr");
    if (r.cut) {
      cutCount++;
      tr.className = "dim";
      tr.innerHTML =
        `<td class="r">—</td><td class="pt">${NAME(p)} <span class="pill cut">shunté</span></td>` +
        `<td class="r">${p.alt.toFixed(0)}</td><td colspan="3">retiré du parcours par le repli coché</td>`;
      tb.appendChild(tr);
      continue;
    }
    const isCrew = p.crew === "yes" || p.crew === "start" || p.crew === "finish";
    const past = r.past;
    tr.className = [isCrew ? "crew" : "", past ? "past" : "", r.observed ? "obsrow" : ""]
      .filter(Boolean).join(" ");
    const c = clockOf(r.sec);
    const base = BASE.by[p.name];
    const gap = base === undefined ? null : r.sec - base;
    const gapCls = gap === null || Math.abs(gap) < 60 ? "" : gap > 0 ? "late" : "early";
    // "=" rather than a dash: an all-empty column reads as broken, "=" reads as "conforme"
    const gapTxt = gap === null ? "—" : Math.abs(gap) < 60 ? "=" : signed(gap);
    const pills = [];
    if (isCrew) pills.push('<span class="pill crew">accessible</span>');
    if (/base vie/i.test(p.type)) pills.push('<span class="pill base">base vie</span>');
    if (isNight(r.sec)) pills.push('<span class="pill night">nuit</span>');
    if (r.observed) pills.push('<span class="pill obs">relevé</span>');
    else if (past && p.crew !== "start") pills.push('<span class="pill past">déjà passé</span>');
    tr.innerHTML =
      `<td class="r">${fr(r.showKm)}</td>` +
      `<td class="pt">${NAME(p)} ${pills.join(" ")}</td>` +
      `<td class="r">${p.alt.toFixed(0)}</td>` +
      `<td class="clock"><span class="day">${c.day}</span> ${c.hhmm}</td>` +
      `<td class="r gap ${gapCls}">${gapTxt}</td>` +
      `<td class="acc">${p.access || (p.aid ? "Ravitaillement, non accessible en voiture." : "—")}</td>`;
    tb.appendChild(tr);
  }
  const parts = [
    `« écart » = différence avec mon scénario objectif (${hms(BASE.total)}, profil mesuré, parcours complet).`,
  ];
  if (cutCount) {
    parts.push(`${cutCount} point(s) retiré(s) par le repli coché, et les km en aval sont ` +
               `recalculés — ils ne correspondent plus au dépliant papier.`);
  }
  if (state.obs.length) {
    parts.push(`Recalé sur ${state.obs.length} passage${state.obs.length > 1 ? "s" : ""} relevé`
               + `${state.obs.length > 1 ? "s" : ""}.`);
  }
  document.getElementById("splitsNote").textContent = parts.join(" ");
}

function renderProfile(course, res, rows) {
  const W = 1000, H = 250, PADL = 40, PADR = 14, PADT = 24, PADB = 28;
  const kmMax = course[course.length - 1][0];
  const eles = course.map((p) => p[3]);
  const lo = Math.min(...eles), hi = Math.max(...eles);
  const px = (km) => PADL + (km / kmMax) * (W - PADL - PADR);
  const py = (e) => H - PADB - ((e - lo) / (hi - lo || 1)) * (H - PADT - PADB);

  // night bands, from the simulated clock at each course point
  const bands = [];
  let open = null;
  for (let i = 0; i < course.length; i += 4) {
    const n = isNight(res.tAt[i]);
    if (n && open === null) open = course[i][0];
    if (!n && open !== null) { bands.push([open, course[i][0]]); open = null; }
  }
  if (open !== null) bands.push([open, kmMax]);

  const line = course.map((p) => `${px(p[0]).toFixed(1)},${py(p[3]).toFixed(1)}`).join(" ");
  const out = [`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">`];
  for (const [a, b] of bands) {
    out.push(`<rect x="${px(a).toFixed(1)}" y="${PADT - 12}" width="${(px(b) - px(a)).toFixed(1)}"`
             + ` height="${H - PADB - PADT + 12}" fill="${C.night}"/>`);
  }
  for (let e = Math.ceil(lo / 500) * 500; e <= hi; e += 500) {
    out.push(`<line x1="${PADL}" y1="${py(e).toFixed(1)}" x2="${W - PADR}" y2="${py(e).toFixed(1)}" stroke="${C.line}"/>`);
    out.push(`<text x="${PADL - 6}" y="${(py(e) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.faint}">${e}</text>`);
  }
  out.push(`<polygon points="${px(0).toFixed(1)},${H - PADB} ${line} ${px(kmMax).toFixed(1)},${H - PADB}" fill="${C.fill}"/>`);
  out.push(`<polyline points="${line}" fill="none" stroke="${C.muted}" stroke-width="1.4"/>`);

  for (const r of rows) {
    if (r.cut) continue;
    const p = r.poi;
    const isCrew = p.crew === "yes" || p.crew === "start" || p.crew === "finish";
    if (!p.aid && !isCrew) continue;
    const x = px(Math.min(r.showKm / KMF, kmMax));
    const c = clockOf(r.sec);
    out.push(`<line x1="${x.toFixed(1)}" y1="${PADT - 12}" x2="${x.toFixed(1)}" y2="${H - PADB}"`
             + ` stroke="${C.line}" stroke-width="1"/>`);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${py(p.alt).toFixed(1)}" r="${isCrew ? 4.5 : 3}"`
             + ` fill="${isCrew ? C.accent : "#ffffff"}" stroke="${isCrew ? "#ffffff" : C.muted}" stroke-width="1.4">`
             + `<title>${NAME(p)} — ${c.day} ${c.hhmm}</title></circle>`);
    if (isCrew) {
      out.push(`<text x="${x.toFixed(1)}" y="${PADT - 2}" text-anchor="middle" font-size="10"`
               + ` font-weight="700" fill="${C.accent}">${c.hhmm}</text>`);
    }
  }

  // The estimated position, in its own group so renderRunner can move it on every slider
  // tick without rebuilding the whole SVG.
  out.push(`<g id="profPos"><line stroke="${C.accent}" stroke-width="1.4" stroke-dasharray="3,3"`
           + ` y1="${PADT - 12}" y2="${H - PADB}"/>`
           + `<circle r="5" fill="${C.accent}" stroke="#ffffff" stroke-width="2"/></g>`);

  out.push(`<text x="${PADL}" y="${H - 7}" font-size="10" fill="${C.faint}">km 0</text>`);
  out.push(`<text x="${W - PADR}" y="${H - 7}" text-anchor="end" font-size="10" fill="${C.faint}">km ${fr(D.race.official_dist_km)}</text>`);
  out.push("</svg>");
  document.getElementById("profile").innerHTML = out.join("");
  P.px = px;
  P.py = py;
  P.kmMax = kmMax;
  moveProfilePos(course, res);
}

/** Geometry of the last-drawn profile, shared with the position marker. */
const P = { px: null, py: null, kmMax: 0 };

function moveProfilePos(course, res) {
  const g = document.getElementById("profPos");
  if (!g || !P.px) return;
  const km = S.kmAtSec(course, res.tAt, state.posSec);
  const x = P.px(Math.min(km, P.kmMax));
  const y = P.py(S.posAtKm(course, km)[2]);
  const line = g.querySelector("line");
  line.setAttribute("x1", x.toFixed(1));
  line.setAttribute("x2", x.toFixed(1));
  const dot = g.querySelector("circle");
  dot.setAttribute("cx", x.toFixed(1));
  dot.setAttribute("cy", y.toFixed(1));
}

/* ---------- map ---------- */

const M = { map: null, trace: null, pois: null, runner: null, fitted: false };

/**
 * Draw the course, the points, and the estimated position at `state.posSec`.
 *
 * The Leaflet instance is created once and reused: the trace and markers are cheap to
 * rebuild when a shunt changes the course, but re-creating the map would reset the pan and
 * zoom the reader had just set.
 */
function renderMap(course, res, rows) {
  const host = document.getElementById("map");
  if (!window.L) {
    host.innerHTML = '<p class="note" style="padding:14px">Fond de carte indisponible '
      + '(vendor/leaflet.js absent). Le reste de la page fonctionne.</p>';
    return;
  }
  const L = window.L;
  const latlngs = course.map((p) => [p[1], p[2]]);

  if (!M.map) {
    M.map = L.map(host, { scrollWheelZoom: false, zoomSnap: 0, zoomDelta: 0.5 });
    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) '
        + '&middot; &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(M.map);
    L.control.scale({ imperial: false }).addTo(M.map);
  }

  if (M.trace) M.map.removeLayer(M.trace);
  M.trace = L.layerGroup();
  // pale casing under a thin dark line: legible on the busy topo raster either way
  L.polyline(latlngs, { color: "#ffffff", weight: 7, opacity: 0.8, interactive: false }).addTo(M.trace);
  L.polyline(latlngs, { color: C.body, weight: 2.6, opacity: 0.95, interactive: false }).addTo(M.trace);
  M.trace.addTo(M.map);

  if (M.pois) M.map.removeLayer(M.pois);
  M.pois = L.layerGroup();
  for (const r of rows) {
    if (r.cut) continue;
    const p = r.poi;
    const isCrew = p.crew === "yes" || p.crew === "start" || p.crew === "finish";
    if (!p.aid && !isCrew) continue;
    const c = clockOf(r.sec);
    L.circleMarker([p.lat, p.lon], {
      radius: isCrew ? 8 : 5,
      color: "#ffffff", weight: 2,
      fillColor: isCrew ? C.accent : C.faint, fillOpacity: 1,
    })
      .bindPopup(
        `<b>${NAME(p)}</b><br/>${c.day} ${c.hhmm} · km ${fr(r.showKm)} · ${p.alt.toFixed(0)} m`
        + (isCrew ? `<br/>${p.access || ""}` : "<br/>Non accessible en voiture.")
      )
      .addTo(M.pois);
  }
  M.pois.addTo(M.map);

  if (!M.fitted) {
    // measure first: fitting against a stale container size leaves the course floating in
    // the middle of the Alps instead of filling the frame
    M.map.invalidateSize();
    M.map.fitBounds(L.polyline(latlngs).getBounds(), { padding: [16, 16] });
    M.fitted = true;
  }
  renderRunner(course, res, rows);
}

/** Move the runner dot and write the "where is he" line. Cheap: called on every slider tick. */
function renderRunner(course, res, rows) {
  const L = window.L;
  const sec = state.posSec;
  const km = S.kmAtSec(course, res.tAt, sec);
  const pos = S.posAtKm(course, km);
  const c = clockOf(sec);

  if (L && M.map) {
    if (!M.runner) {
      M.runner = L.marker([pos[0], pos[1]], {
        icon: L.divIcon({ className: "", html: '<div class="runner"></div>',
                         iconSize: [14, 14], iconAnchor: [7, 7] }),
        zIndexOffset: 1000,
      }).addTo(M.map);
    } else {
      M.runner.setLatLng([pos[0], pos[1]]);
    }
    M.runner.bindTooltip(`${c.day} ${c.hhmm} · km ${fr(km * KMF)}`, { direction: "top", offset: [0, -8] });
  }
  moveProfilePos(course, res);

  document.getElementById("posElapsed").textContent = `h+${hms(sec)}`;
  document.getElementById("posTime").value = c.hhmm;
  const slider = document.getElementById("posSlider");
  if (document.activeElement !== slider) {
    slider.value = String(Math.round((sec / (res.total || 1)) * 1000));
  }

  // the useful sentence: which leg he is on, and when he reaches the next crew point
  const done = rows.filter((r) => !r.cut && r.sec <= sec);
  const left = rows.filter((r) => !r.cut && r.sec > sec);
  const prev = done.length ? done[done.length - 1] : null;
  const next = left.length ? left[0] : null;
  const nextCrew = left.find((r) => r.poi.crew === "yes" || r.poi.crew === "finish");
  const bits = [`<b>${c.day} ${c.hhmm}</b> — km ${fr(km * KMF)}, ${pos[2].toFixed(0)} m`];
  if (sec < 60) bits.push("au départ");
  else if (!next) bits.push("arrivé");
  else if (prev) bits.push(`entre ${NAME(prev.poi)} et ${NAME(next.poi)}`);
  else bits.push(`avant ${NAME(next.poi)}`);
  if (nextCrew) {
    const nc = clockOf(nextCrew.sec);
    bits.push(`prochain point où le voir : <b>${NAME(nextCrew.poi)}</b>, ${nc.day} ${nc.hhmm} `
              + `(dans ${hms(nextCrew.sec - sec)})`);
  }
  document.getElementById("posWhere").innerHTML = bits.join(" · ");
}

/** Traced km -> official km, so every displayed distance is on the roadbook's scale. */
const KMF = D.race.official_dist_km / D.race.course_dist_km;

function buildPos() {
  const slider = document.getElementById("posSlider");
  slider.addEventListener("input", () => {
    const { built, res, rows } = run(state.params, state.scale);
    state.posSec = (Number(slider.value) / 1000) * res.total;
    renderRunner(built.course, res, rows);
    persist();
  });
  document.getElementById("posTime").addEventListener("change", (e) => {
    const v = hhmmToSec(e.target.value);
    if (v === null) return;
    let el = v - state.start;
    while (el < 0) el += 86400;   // an hour before the start means the next morning
    state.posSec = el;
    persist();
    render();
  });
  document.getElementById("posNow").addEventListener("click", () => {
    const { res } = run(state.params, state.scale);
    state.posSec = defaultPosSec(res.total);
    persist();
    render();
  });
}

/* ---------- controls ---------- */

function renderKnobValues() {
  for (const k of KNOBS) {
    const el = document.getElementById("v_" + k.key);
    if (el) el.textContent = fr(Number(state.params[k.key]), k.nd);
    const sl = document.getElementById("s_" + k.key);
    if (sl) sl.value = state.params[k.key];
  }
}

function buildKnobs() {
  const host = document.getElementById("knobs");
  host.innerHTML = KNOBS.map((k) => `
    <div class="knob" title="${k.hint}">
      <div class="top"><span class="lbl">${k.label}</span>
        <span class="val"><span id="v_${k.key}"></span> <span class="unit">${k.unit}</span></span></div>
      <input type="range" id="s_${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" />
    </div>`).join("");
  for (const k of KNOBS) {
    document.getElementById("s_" + k.key).addEventListener("input", (e) => {
      state.params[k.key] = Number(e.target.value);
      // a hand-moved slider invalidates the re-fit and the preset: both were solved for
      // other parameter values
      clearFit(false);
      state.preset = null;
      markPreset();
      persist();
      render();
    });
  }
}

/* B "Objectif" and the measured profile are the same scenario (26h27 vs 26h26, one minute
   of rounding), so they are one button. A and C stay as time targets reached by scaling
   every speed at once. `preset` records which one is active so it survives a reload. */
const PRESETS = [
  { id: "me", label: "👤 B · Objectif", cls: "btn me", target: null },
  { id: "bonne_journee", label: "A · Bonne journée", cls: "btn" },
  { id: "journee_dure", label: "C · Journée dure", cls: "btn" },
];

function presetLabel(pr) {
  if (pr.id === "me") return `${pr.label} · ${hms(BASE.total)}`;
  const sc = D.scenarios[pr.id];
  return sc ? `${pr.label} · ${hms(sc.total_sec)}` : pr.label;
}

/** Apply a preset by id. Returns false if the id is unknown (stale stored state). */
function applyPreset(id, rerender) {
  if (id === "me") {
    state.params = Object.assign({}, D.profile.params);
    state.scale = 1;
  } else {
    const sc = D.scenarios[id];
    if (!sc) return false;
    state.params = Object.assign({}, D.profile.params);
    const built = S.applyShunts(D.course, D.shunts, state.shunts);
    const stops = D.stops.map((k) => S.mapKm(built.cuts, k)).filter((k) => k !== null);
    state.scale = S.fitScale(built.course, stops, state.params, D.tech, D.sections, D.bounds,
                             built.course[built.course.length - 1][0], sc.total_sec).scale;
  }
  state.preset = id;
  markPreset();
  if (rerender) { persist(); render(); }
  return true;
}

function markPreset() {
  document.querySelectorAll("#presets button[data-id]").forEach((b) => {
    b.classList.toggle("on", b.dataset.id === state.preset && b.dataset.id !== "reset");
  });
}

function buildPresets() {
  const host = document.getElementById("presets");
  host.innerHTML =
    PRESETS.map((pr) => `<button class="${pr.cls}" data-id="${pr.id}">${presetLabel(pr)}</button>`).join("")
    + '<button class="btn" data-id="reset">Réinitialiser</button>';

  host.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.id;
      if (id === "reset") {
        resetAll();
        return;
      }
      clearFit(false);
      applyPreset(id, true);
    });
  });
}

function buildShunts() {
  const host = document.getElementById("shunts");
  host.innerHTML = (D.shunts || []).map((s) => {
    const ok = !!s.bypass;
    const netKm = ok ? s.bypass.dist_km - s.removes.dist_km : 0;
    const netDp = ok ? (s.bypass.dplus || 0) - s.removes.dplus : 0;
    const sg = (v, unit, nd) => `${v > 0 ? "+" : "−"}${fr(Math.abs(v), nd)} ${unit}`;
    const eff = ok
      ? `${sg(netKm, "km", 1)} · ${sg(netDp, "m D+", 0)}`
      : "effet inconnu";
    return `
      <label class="shunt ${ok ? "" : "disabled"}">
        <input type="checkbox" data-id="${s.id}" ${ok ? "" : "disabled"} />
        <span class="body">
          <span class="name">Repli sans ${s.label}</span>
          <span class="eff"> ${eff}</span>
          <span class="gain" id="g_${s.id}"></span>
          <div class="why">${s.why}</div>
          ${s.pending ? `<div class="pending"><b>Provisoire.</b> ${s.pending}</div>` : ""}
        </span>
      </label>`;
  }).join("");
  host.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      state.shunts[cb.dataset.id] = cb.checked;
      clearFit(false);
      persist();
      render();
    });
  });
}

/** How much time each active shunt actually saves, recomputed against the current params. */
function renderShuntEffects() {
  for (const s of (D.shunts || [])) {
    const el = document.getElementById("g_" + s.id);
    if (!el) continue;
    if (!s.bypass || !state.shunts[s.id]) { el.textContent = ""; continue; }
    const saveAll = Object.assign({}, state.shunts);
    delete saveAll[s.id];
    const withOut = (() => {
      const keep = state.shunts;
      state.shunts = saveAll;
      const r = run(state.params, state.scale).res.total;
      state.shunts = keep;
      return r;
    })();
    const withIt = run(state.params, state.scale).res.total;
    el.textContent = ` → ${signed(withIt - withOut)} sur le total`;
  }
}

function buildFit() {
  const sel = document.getElementById("fitPoi");
  sel.innerHTML = D.pois
    .filter((p) => p.aid || p.crew === "start")
    .map((p) => `<option value="${p.name}">${NAME(p)} (km ${fr(p.km)})</option>`)
    .join("");

  document.getElementById("fitApply").addEventListener("click", () => {
    const observed = hhmmToSec(document.getElementById("fitTime").value);
    if (observed === null) {
      showFitError("Saisis une heure (format 14:35).");
      return;
    }
    // an observed time before the start means it rolled past midnight
    let elapsed = observed - state.start;
    while (elapsed < 0) elapsed += 86400;
    addObs(sel.value, elapsed);
  });

  document.getElementById("fitClear").addEventListener("click", () => clearFit(true));
}

function showFitError(msg) {
  const out = document.getElementById("fitOut");
  out.className = "fitout bad";
  out.textContent = msg;
}

/**
 * Record a passage. Adding one at a point already recorded replaces it — correcting a
 * mistyped time should not need a delete first.
 */
function addObs(name, elapsed) {
  const poi = D.pois.find((p) => p.name === name);
  if (!poi) return;
  const built = S.applyShunts(D.course, D.shunts, state.shunts);
  if (S.mapKm(built.cuts, poi.course_km) === null) {
    showFitError(`${NAME(poi)} est retiré du parcours par le repli coché — choisis un autre point.`);
    return;
  }
  // Times must increase with distance. Refuse the entry here rather than store something
  // liveObs() would silently drop — a reading typed and then ignored is worse than an error.
  const kmOf = (n) => (D.pois.find((x) => x.name === n) || {}).course_km;
  const others = state.obs
    .filter((o) => o.name !== name && kmOf(o.name) !== undefined)
    .map((o) => ({ name: o.name, elapsed: o.elapsed, km: kmOf(o.name) }));
  const before = others.filter((o) => o.km < poi.course_km).sort((x, y) => y.km - x.km)[0];
  const after = others.filter((o) => o.km > poi.course_km).sort((x, y) => x.km - y.km)[0];
  const label = (o) => `${NAME(D.pois.find((x) => x.name === o.name))} (${clockOf(o.elapsed).hhmm})`;
  if (before && elapsed <= before.elapsed) {
    showFitError(`${NAME(poi)} est après ${label(before)} sur le parcours : son heure doit être plus tard.`);
    return;
  }
  if (after && elapsed >= after.elapsed) {
    showFitError(`${NAME(poi)} est avant ${label(after)} sur le parcours : son heure doit être plus tôt.`);
    return;
  }

  state.obs = state.obs.filter((o) => o.name !== name).concat([{ name, elapsed }]);
  state.obs.sort((a, b) => {
    const ka = D.pois.find((p) => p.name === a.name).course_km;
    const kb = D.pois.find((p) => p.name === b.name).course_km;
    return ka - kb;
  });
  state.params = Object.assign({}, D.profile.params);
  state.scale = 1;
  state.preset = null;
  markPreset();
  document.getElementById("fitTime").value = "";
  persist();
  render();
}

function removeObs(name) {
  state.obs = state.obs.filter((o) => o.name !== name);
  if (!state.obs.length) {
    state.preset = "me";
    markPreset();
  }
  persist();
  render();
}

function clearFit(rerender) {
  if (!state.obs.length) return;
  state.obs = [];
  state.params = Object.assign({}, D.profile.params);
  state.scale = 1;
  state.preset = "me";
  markPreset();
  const out = document.getElementById("fitOut");
  out.className = "fitout";
  out.textContent = "";
  document.getElementById("fitTime").value = "";
  if (rerender) { persist(); render(); }
}

/** The chips: one per recorded passage, with the leg pace it implies and a delete button. */
function renderObs(obs, fit) {
  const host = document.getElementById("obsList");
  host.innerHTML = "";
  obs.forEach((o, i) => {
    const poi = D.pois.find((p) => p.name === o.name);
    const leg = fit && fit.legs[i];
    const pct = leg ? (1 / leg.scale - 1) * 100 : null;
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="oname">${NAME(poi)}</span>`
      + `<span class="otime">${clockOf(o.elapsed).hhmm}</span>`
      + (pct === null || Math.abs(pct) < 0.5 ? ""
         : `<span class="oleg" title="rythme du tronçon précédent">`
           + `${pct > 0 ? "+" : "−"}${fr(Math.abs(pct))} %</span>`)
      + `<button type="button" title="Retirer ce relevé" aria-label="Retirer">×</button>`;
    li.querySelector("button").addEventListener("click", () => removeObs(o.name));
    host.appendChild(li);
  });
}

/** What the recorded passages imply, and which pace is being projected forward. */
function renderFitSummary(obs, fit, res) {
  const out = document.getElementById("fitOut");
  if (!obs.length || !fit) {
    out.className = "fitout";
    out.textContent = "";
    return;
  }
  const last = obs[obs.length - 1];
  const poi = D.pois.find((p) => p.name === last.name);
  const planned = BASE.by[last.name];
  const drift = planned === undefined ? null : last.elapsed - planned;
  const projPct = (1 / fit.projScale - 1) * 100;
  const cumPct = (1 / fit.cumScale - 1) * 100;
  const sgn = (v) => `${v >= 0 ? "+" : "−"}${fr(Math.abs(v))} %`;

  const nLegs = obs.length;
  out.className = "fitout ok";
  out.innerHTML =
    `<b>${nLegs} passage${nLegs > 1 ? "s" : ""} relevé${nLegs > 1 ? "s" : ""}.</b> `
    + `Dernier : <b>${NAME(poi)}</b> en <b>${hms(last.elapsed)}</b> de course`
    + (drift === null ? "" : ` — ${signed(drift)} sur le plan objectif`)
    + `.<br/>Rythme depuis le départ : <b>${sgn(cumPct)}</b> de temps. `
    + `Sur les ${hms(fit.windowSec)} qui précèdent le dernier relevé : <b>${sgn(projPct)}</b> — `
    + `c'est celui-là qui est projeté sur la suite, parce qu'il décrit mieux l'état actuel `
    + `que la moyenne depuis Vizille.`
    + (nLegs > 1 ? ` Les tronçons entre relevés ne sont plus estimés : ils collent aux heures saisies.` : "")
    + (fit.clamped ? ` <b>⚠️ Un écart sort des bornes du modèle : recalage plafonné, à lire avec prudence.</b>` : "")
    + (Math.abs(projPct) > 40
        ? `<br/><b>⚠️ ${sgn(projPct)} est invraisemblable sur un ultra — vérifiez les heures `
          + `saisies (une heure tapée de travers suffit). Les horaires ci-dessous sont à jeter `
          + `tant que ce chiffre reste là.</b>`
        : "");
}

/* ---------- boot ---------- */

function boot() {
  const start = new Date(D.race.date + "T00:00:00");
  const dayName = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"][start.getDay()];
  const dateTxt = start.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  document.getElementById("raceLine").textContent =
    `${D.race.name} · ${dayName} ${dateTxt}, départ ${hms(D.race.start_hour * 3600)} · ` +
    `${fr(D.race.official_dist_km)} km, ${D.race.official_dplus} m D+`;
  document.getElementById("gen").textContent = D.generated.replace("T", " ").slice(0, 16);
  if (D.sun) {
    document.getElementById("sunset").textContent = D.sun.sunset;
    document.getElementById("sunrise").textContent = D.sun.sunrise_next || D.sun.sunrise;
  }

  document.getElementById("startTime").addEventListener("change", (e) => {
    const v = hhmmToSec(e.target.value);
    if (v !== null) { state.start = v; persist(); render(); }
  });

  buildKnobs();
  buildPos();
  buildPresets();
  buildShunts();
  buildFit();

  // Restore last: the controls must exist before stored values can be written into them.
  const got = restore();
  document.getElementById("startTime").value = clockOf(0).hhmm;
  for (const sh of (D.shunts || [])) {
    const cb = document.querySelector(`#shunts input[data-id="${sh.id}"]`);
    if (cb) cb.checked = !!state.shunts[sh.id];
  }
  // A stored preset is re-applied rather than trusted: the scale it implies depends on the
  // shunts, which may also have been restored. A stored re-fit wins over a preset.
  if (got.obs) {
    state.obs = got.obs;
    state.params = Object.assign({}, D.profile.params);
    state.scale = 1;
    state.preset = null;
  } else if (got.preset !== undefined && got.preset !== null) {
    if (!applyPreset(got.preset, false)) applyPreset("me", false);
  } else if (got.params || got.scale) {
    state.preset = got.preset === null ? null : state.preset;
  }
  markPreset();
  render();
}

boot();
