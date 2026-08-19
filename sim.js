/* Virtual runner over the 2026 course — plain-JS port of web/lib/simulate.ts.
 *
 * Same grade-driven model: above a threshold you stop running and vertical speed (VAM)
 * governs; below it you run, with a penalty rising with the grade. Descents give speed
 * back up to a point. Everything decays with a fatigue drift, and aid stations add flat
 * time where they really happen.
 *
 * Two things this port adds, both for the crew page:
 *   - shunts, which cut a stretch of course out and splice a bypass in;
 *   - a speed scale, which can be one factor for the whole race OR a list of breakpoints,
 *     one per leg between two observed passages. That is what the live re-fit solves for:
 *     a leg whose duration is known is not a prediction any more, so it gets its own
 *     factor and matches the observation exactly.
 *
 * Course points are [km, lat, lon, ele, kmOrig]. `kmOrig` is the km on the UNSHUNTED
 * course and is what terrain lookups use: cutting 2 km out must not slide the whole
 * roadbook's difficulty bands 2 km upstream.
 */

const DEFAULTS = {
  vam: 700, vamDown: 1400, flatMinKm: 6.5, hikePct: 12, steepDownPct: 20,
  upPenalty: 4.5, downGain: 25, driftPct: 12, techPct: 7, stopMin: 4,
};

/** Metres between two points; the bypass line carries no km of its own. */
function haversine(la1, lo1, la2, lo2) {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p;
  const x = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const MIN_FACTOR = 0.22; // a hiked-but-not-steep stretch never drops below this of flat speed
const MAX_FACTOR = 1.9;  // nor does a descent run away above it

function levelAt(bands, km) {
  if (!bands || !bands.length) return 1;
  let lo = 0;
  for (let i = 0; i < bands.length && bands[i][0] <= km; i++) lo = i;
  return bands[lo][1];
}

/** [km, lat, lon, ele] -> [km, lat, lon, ele, kmOrig] */
function prepare(course) {
  return course.map((p) => [p[0], p[1], p[2], p[3], p[0]]);
}

/**
 * Cut each active shunt out of the course and splice its bypass in.
 *
 * When the bypass carries `line` — the real routed geometry, [[lat, lon, ele], …] — those
 * points are spliced in as they are, so the map and the profile show the path actually
 * drawn. Without it the geometry falls back to a synthetic rise-then-fall between the
 * anchors, which is only ever right for a bypass short enough to be a straight link.
 */
function applyShunts(course, shunts, active) {
  const pts = prepare(course);
  const on = (shunts || [])
    .filter((s) => active[s.id] && s.bypass)
    .sort((a, b) => a.from_km - b.from_km);
  if (!on.length) return { course: pts, cuts: [], shift: 0 };

  let out = pts;
  const cuts = [];
  for (const s of on) {
    // anchors are expressed on the ORIGINAL km scale, so find them by kmOrig
    let i = 0, j = 0;
    for (let k = 0; k < out.length; k++) {
      if (out[k][4] <= s.from_km) i = k;
      if (out[k][4] <= s.to_km) j = k;
    }
    if (j <= i) continue;
    const a = out[i], b = out[j];
    const line = s.bypass.line;
    const bridge = [];
    let dist;
    if (line && line.length > 1) {
      // real geometry: walk it, accumulating its own km so the profile is the true one
      let walked = 0;
      const steps = [];
      for (let k = 1; k < line.length; k++) {
        walked += haversine(line[k - 1][0], line[k - 1][1], line[k][0], line[k][1]) / 1000;
        steps.push(walked);
      }
      const k2 = walked > 0 ? (s.bypass.dist_km || walked) / walked : 1;
      for (let k = 1; k < line.length; k++) {
        // kmOrig is spread evenly over the cut it replaces, so the roadbook's terrain bands
        // and the learned section factors keep applying to the right stretch of mountain
        const kmOrig = a[4] + (s.to_km - s.from_km) * (k / (line.length - 1));
        bridge.push([a[0] + steps[k - 1] * k2, line[k][0], line[k][1], line[k][2], kmOrig]);
      }
      dist = walked * k2;
    } else {
      dist = s.bypass.dist_km;
      const crest = a[3] + (s.bypass.dplus || 0);
      const n = Math.max(1, Math.ceil((dist * 1000) / 50));
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        // rise to the crest over the first half, then fall to the far anchor
        const ele = f <= 0.5
          ? a[3] + (crest - a[3]) * (f / 0.5)
          : crest + (b[3] - crest) * ((f - 0.5) / 0.5);
        bridge.push([a[0] + dist * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
                     ele, a[4] + (s.to_km - s.from_km) * f]);
      }
    }
    const removed = b[0] - a[0];
    const delta = dist - removed; // negative: the course gets shorter
    const tail = out.slice(j + 1).map((p) => [p[0] + delta, p[1], p[2], p[3], p[4]]);
    out = out.slice(0, i + 1).concat(bridge, tail);
    cuts.push({ id: s.id, from_km: s.from_km, to_km: s.to_km, delta });
  }
  const shift = cuts.reduce((t, c) => t + c.delta, 0);
  return { course: out, cuts, shift };
}

/** km on the shunted course for a point given by its original km (null if cut out). */
function mapKm(cuts, kmOrig) {
  let shift = 0;
  for (const c of cuts) {
    if (kmOrig > c.from_km && kmOrig < c.to_km) return null; // inside a cut
    if (kmOrig >= c.to_km) shift += c.delta;
  }
  return kmOrig + shift;
}

/**
 * Resolve the speed factor at a given km.
 *
 * `scale` is either a number for the whole race, or breakpoints `[{fromKm, scale}]` sorted
 * ascending — the factor of the last breakpoint at or before `km` applies.
 */
function scaleFor(scale, km) {
  if (typeof scale === "number") return scale || 1;
  if (!scale || !scale.length) return 1;
  let s = scale[0].scale;
  for (let i = 0; i < scale.length && scale[i].fromKm <= km; i++) s = scale[i].scale;
  return s;
}

/**
 * Walk the course and return cumulative seconds at each point.
 *
 * `scale` multiplies every speed at once (VAM up and down, flat pace). Stops are NOT
 * scaled: a runner who is late because of long aid stations is not a slower runner, and
 * conflating the two would push the re-fit onto the wrong parameter.
 */
function simulate(course, stopsKm, p, tech, sections, bounds, scale) {
  const flatBase = 1000 / (p.flatMinKm * 60);
  const stops = (stopsKm || []).slice().sort((a, b) => a - b);

  const tAt = new Array(course.length).fill(0);
  const splits = [];
  let t = 0, moving = 0, stopped = 0, dplus = 0, dneg = 0, nextStop = 0;

  for (let i = 1; i < course.length; i++) {
    const d = (course[i][0] - course[i - 1][0]) * 1000;
    const de = course[i][3] - course[i - 1][3];
    if (d > 0) {
      const sc = scaleFor(scale, course[i][0]);
      const gPct = (de / d) * 100;
      let sec;
      if (gPct >= p.hikePct) {
        sec = (de / (p.vam * sc)) * 3600;
      } else if (gPct <= -p.steepDownPct) {
        sec = (-de / (p.vamDown * sc)) * 3600;
      } else {
        let f = gPct > 0 ? 1 - (p.upPenalty / 100) * gPct : 1 + (p.downGain / 100) * (-gPct / 10);
        f = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, f));
        sec = d / (flatBase * sc * f);
      }
      const lvl = levelAt(tech, course[i][4]);
      if (lvl > 1) sec *= 1 + (p.techPct / 100) * (lvl - 1);
      if (sections && sections.length && bounds && bounds.length) {
        let si = -1;
        for (let k = bounds.length - 2; k >= 0; k--) {
          if (course[i][4] >= bounds[k]) { si = k; break; }
        }
        if (si >= 0 && si < sections.length) sec *= sections[si].factor;
      }
      sec *= 1 + (p.driftPct / 100) * (t / 36000);
      t += sec;
      moving += sec;
      if (de > 0) dplus += de; else dneg -= de;
    }
    while (nextStop < stops.length && course[i][0] >= stops[nextStop]) {
      const add = p.stopMin * 60;
      t += add;
      stopped += add;
      splits.push({ km: stops[nextStop], sec: t });
      nextStop++;
    }
    tAt[i] = t;
  }
  return { tAt, total: t, movingSec: moving, stopSec: stopped,
           dplus: Math.round(dplus), dneg: Math.round(dneg),
           distKm: course[course.length - 1][0], splits };
}

/** Cumulative seconds at an arbitrary km, interpolated on the time curve. */
function secAtKm(course, tAt, km) {
  if (km <= course[0][0]) return 0;
  const last = course.length - 1;
  if (km >= course[last][0]) return tAt[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (course[mid][0] <= km) lo = mid; else hi = mid;
  }
  const span = course[hi][0] - course[lo][0] || 1;
  return tAt[lo] + ((km - course[lo][0]) / span) * (tAt[hi] - tAt[lo]);
}

/**
 * Solve for the speed scale that puts the runner at `km` after `targetSec`.
 *
 * Bisection rather than algebra: the model is not invertible in closed form (thresholds,
 * drift and clamps all bend it), but total time is monotonic in the scale, so 40 halvings
 * land well inside a second.
 */
function fitScale(course, stopsKm, p, tech, sections, bounds, km, targetSec) {
  const at = (sc) => secAtKm(course, simulate(course, stopsKm, p, tech, sections, bounds, sc).tAt, km);
  let lo = 0.3, hi = 3.0;
  if (at(hi) > targetSec) return { scale: hi, clamped: true };  // even flat out, too slow
  if (at(lo) < targetSec) return { scale: lo, clamped: true };  // even crawling, too fast
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > targetSec) lo = mid; else hi = mid;
  }
  return { scale: (lo + hi) / 2, clamped: false };
}

const MIN_WINDOW_SEC = 2700; // 45 min: the shortest leg worth extrapolating from

/**
 * Solve the factor of ONE leg, with every earlier leg already fixed.
 *
 * Only the tail from `fromKm` moves when the trial factor changes, so the arrival time at
 * `fromKm` is a constant and total time at `toKm` stays monotonic in the factor —
 * bisection holds.
 */
function fitOneLeg(course, stopsKm, p, tech, sections, bounds, fixed, fromKm, toKm, durationSec) {
  const at = (sc) => {
    const scales = fixed.concat([{ fromKm, scale: sc }]);
    const tAt = simulate(course, stopsKm, p, tech, sections, bounds, scales).tAt;
    return secAtKm(course, tAt, toKm) - secAtKm(course, tAt, fromKm);
  };
  let lo = 0.25, hi = 4.0;
  if (at(hi) > durationSec) return { scale: hi, clamped: true };
  if (at(lo) < durationSec) return { scale: lo, clamped: true };
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > durationSec) lo = mid; else hi = mid;
  }
  return { scale: (lo + hi) / 2, clamped: false };
}

/**
 * Turn a list of observed passages into a piecewise speed profile.
 *
 * `obs` = [{km, elapsed}] sorted by km. Each leg between two consecutive observations gets
 * the factor that reproduces its measured duration, so those legs stop being predictions.
 * The remaining course is projected on `projScale`, fitted over the most recent window of
 * at least 45 minutes — an ultra runner's recent pace predicts the next hours better than
 * the average since the start, but a 20-minute leg is too short to extrapolate from.
 */
function fitLegs(course, stopsKm, p, tech, sections, bounds, obs) {
  const legs = [];
  let clamped = false;
  let prevKm = course[0][0], prevSec = 0;
  for (const o of obs) {
    const r = fitOneLeg(course, stopsKm, p, tech, sections, bounds, legs,
                        prevKm, o.km, o.elapsed - prevSec);
    clamped = clamped || r.clamped;
    legs.push({ fromKm: prevKm, toKm: o.km, scale: r.scale });
    prevKm = o.km;
    prevSec = o.elapsed;
  }
  if (!legs.length) return { legs: [], scales: 1, projScale: 1, cumScale: 1, clamped };

  // widen the projection window backwards until it covers at least MIN_WINDOW_SEC
  let wi = obs.length - 1;
  while (wi > 0 && obs[obs.length - 1].elapsed - obs[wi - 1].elapsed < MIN_WINDOW_SEC) wi--;
  const winFromKm = wi === 0 ? course[0][0] : obs[wi - 1].km;
  const winFromSec = wi === 0 ? 0 : obs[wi - 1].elapsed;
  const fixedBefore = legs.filter((l) => l.fromKm < winFromKm);
  const proj = fitOneLeg(course, stopsKm, p, tech, sections, bounds, fixedBefore,
                         winFromKm, obs[obs.length - 1].km,
                         obs[obs.length - 1].elapsed - winFromSec);

  const last = obs[obs.length - 1];
  const cum = fitOneLeg(course, stopsKm, p, tech, sections, bounds, [],
                        course[0][0], last.km, last.elapsed);

  const scales = legs.map((l) => ({ fromKm: l.fromKm, scale: l.scale }));
  scales.push({ fromKm: last.km, scale: proj.scale });
  return {
    legs, scales, projScale: proj.scale, cumScale: cum.scale,
    windowFromKm: winFromKm, windowSec: last.elapsed - winFromSec,
    clamped: clamped || proj.clamped,
  };
}

/** km reached at elapsed second `sec` — the inverse of secAtKm, same binary search. */
function kmAtSec(course, tAt, sec) {
  const last = course.length - 1;
  if (sec <= 0) return course[0][0];
  if (sec >= tAt[last]) return course[last][0];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tAt[mid] <= sec) lo = mid; else hi = mid;
  }
  const span = tAt[hi] - tAt[lo] || 1;
  const f = (sec - tAt[lo]) / span;
  return course[lo][0] + f * (course[hi][0] - course[lo][0]);
}

/** [lat, lon, ele] at a given km, linearly interpolated between course points. */
function posAtKm(course, km) {
  const last = course.length - 1;
  if (km <= course[0][0]) return [course[0][1], course[0][2], course[0][3]];
  if (km >= course[last][0]) return [course[last][1], course[last][2], course[last][3]];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (course[mid][0] <= km) lo = mid; else hi = mid;
  }
  const span = course[hi][0] - course[lo][0] || 1;
  const f = (km - course[lo][0]) / span;
  return [
    course[lo][1] + f * (course[hi][1] - course[lo][1]),
    course[lo][2] + f * (course[hi][2] - course[lo][2]),
    course[lo][3] + f * (course[hi][3] - course[lo][3]),
  ];
}

window.EBSim = { DEFAULTS, applyShunts, mapKm, simulate, secAtKm, kmAtSec, posAtKm,
                 fitScale, fitOneLeg, fitLegs, scaleFor, MIN_WINDOW_SEC };
