/**
 * The article's figures as hand-written SVG, drawn at the width they are shown at (so text stays
 * at reading size on a phone) and redrawn when that width changes. Colors are the app's tokens.
 */
import { BC, DAYS, DAY_NAME, F, muni, STD, V, VX, type Day } from './data';
import { esc, int, spc } from './doc';

type Render = (w: number) => string;

const FONT = 12;
const tick = (n: number) => (n >= 1000 ? `${n / 1000}k` : `${n}`);

function logScale(d0: number, d1: number, r0: number, r1: number) {
  const a = Math.log10(d0), b = Math.log10(d1);
  return (v: number) => r0 + ((Math.log10(Math.max(v, d0)) - a) / (b - a)) * (r1 - r0);
}
function linScale(d0: number, d1: number, r0: number, r1: number) {
  return (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}
const LOG_TICKS = [10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000, 300000];
function niceLogDomain(vals: number[]): [number, number] {
  const pos = vals.filter((v) => v > 0);
  const lo = Math.min(...pos), hi = Math.max(...pos);
  const d0 = [...LOG_TICKS].reverse().find((t) => t <= lo * 0.9) ?? 10;
  const d1 = LOG_TICKS.find((t) => t >= hi * 1.1) ?? 300000;
  return [d0, d1];
}
const svg = (w: number, h: number, body: string, label = '') =>
  `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"${label ? ` aria-label="${esc(label)}"` : ' aria-hidden="true"'} font-size="${FONT}">${body}</svg>`;
const text = (x: number, y: number, s: string, cls = 'lbl', anchor = 'start', extra = '') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;

// ---------- point labels that avoid each other ----------
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/** try right, left, above and below the point (then further out), keep the first spot that is free */
function placeLabel(cx: number, cy: number, label: string, placed: Box[], xmin: number, xmax: number, ymin: number, ymax: number): string {
  const w = label.length * 7 + 2, h = 12;
  const tries: [number, number][] = [[8, 4], [-8 - w, 4], [-w / 2, -9], [-w / 2, 17], [10, -10], [-10 - w, -10], [10, 16], [-10 - w, 16], [16, 4], [-16 - w, 4], [-w / 2, -20], [-w / 2, 28]];
  let best: Box | null = null;
  for (const [dx, dy] of tries) {
    const b = { x0: cx + dx, y0: cy + dy - h + 2, x1: cx + dx + w, y1: cy + dy + 2 };
    if (b.x0 < xmin || b.x1 > xmax + 8 || b.y0 < ymin - 6 || b.y1 > ymax) continue;
    if (placed.some((p) => overlaps(p, b))) continue;
    best = b;
    break;
  }
  best ??= { x0: cx + 8, y0: cy - 8, x1: cx + 8 + w, y1: cy + 4 };
  placed.push(best);
  return text(best.x0 + 1, best.y1 - 2, label, 'pt-lbl');
}

// ---------- Figure: Muni routes, modeled against counted (one panel per day type) ----------
export function muniScatter(day: Day): Render {
  return (w) => {
    const m = muni(day);
    const pts = m.routes;
    const [d0, d1] = niceLogDomain(pts.flatMap((p) => [p.observed, p.model]));
    const L = 46, R = 10, T = 10, B = 38;
    const side = Math.max(160, Math.min(w, 420) - L - R);
    const W = L + side + R, H = T + side + B;
    const x = logScale(d0, d1, L, L + side), y = logScale(d0, d1, T + side, T);
    const ticks = LOG_TICKS.filter((t) => t >= d0 && t <= d1);
    let s = '';
    // grid and axes
    for (const t of ticks) {
      s += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T + side}"/><line class="grid" x1="${L}" x2="${L + side}" y1="${y(t)}" y2="${y(t)}"/>`;
      s += text(x(t), T + side + 16, tick(t), 'tick', 'middle') + text(L - 6, y(t) + 4, tick(t), 'tick', 'end');
    }
    s += `<rect class="frame" x="${L}" y="${T}" width="${side}" height="${side}"/>`;
    // ±25% band and the 1:1 line
    const band = [[d0, d0 * 0.75], [d1, d1 * 0.75], [d1 / 1.25, d1], [d0, d0 * 1.25]];
    s += `<polygon class="band" points="${band.map(([a, b]) => `${x(a).toFixed(1)},${y(Math.min(Math.max(b, d0), d1)).toFixed(1)}`).join(' ')}"/>`;
    s += `<line class="one" x1="${x(d0)}" y1="${y(d0)}" x2="${x(d1)}" y2="${y(d1)}"/>`;
    // the largest absolute misses get a label
    const misses = new Set(pts.slice().sort((a, b) => Math.abs(b.model - b.observed) - Math.abs(a.model - a.observed)).slice(0, 5).map((p) => p.route));
    const labels: string[] = [];
    const placed: Box[] = pts.map((p) => ({ x0: x(p.observed) - 4, y0: y(Math.max(p.model, d0)) - 4, x1: x(p.observed) + 4, y1: y(Math.max(p.model, d0)) + 4 }));
    for (const p of pts) {
      const cx = x(p.observed), cy = y(Math.max(p.model, d0));
      s += `<circle class="dot${Math.abs(p.pct) <= 25 ? '' : ' out'}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"><title>${esc(`Route ${p.route}: counted ${int(p.observed)}, modeled ${int(p.model)} (${spc(p.pct / 100)})`)}</title></circle>`;
      if (misses.has(p.route)) labels.push(placeLabel(cx, cy, p.route, placed, L, L + side, T, T + side));
    }
    s += labels.join('');
    s += text(L + side / 2, H - 4, 'Counted boardings per day', 'axis', 'middle');
    s += text(-(T + side / 2), 12, 'Modeled boardings per day', 'axis', 'middle', ' transform="rotate(-90)"');
    return svg(W, H, s, `${DAY_NAME[day]}: modeled against counted boardings for ${pts.length} Muni routes, logarithmic axes`);
  };
}

// ---------- Figure: percent error against route size, with the FHWA bands ----------
export const muniBands: Render = (w) => {
  const pts = muni('wkd').routes;
  const bands = STD.fhwaTransit.bands.map((b) => ({ ...b, max: b.max ?? Infinity }));
  const [d0, d1] = niceLogDomain(pts.map((p) => p.observed));
  const yMax = Math.max(200, Math.ceil(Math.max(...pts.map((p) => p.pct)) / 50) * 50);
  const L = 60, R = 12, T = 12, B = 38;
  const W = Math.min(w, 760), H = Math.round(Math.min(380, Math.max(260, W * 0.55)));
  const x = logScale(d0, d1, L, W - R), y = linScale(-100, yMax, H - B, T);
  let s = '';
  for (let v = -100; v <= yMax; v += 50) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>` + text(L - 6, y(v) + 4, `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`, 'tick', 'end');
  for (const t of LOG_TICKS.filter((t) => t >= d0 && t <= d1)) s += text(x(t), H - B + 16, tick(t), 'tick', 'middle');
  // bands as steps
  let lo = d0;
  for (const b of bands) {
    const hi = Math.min(b.max, d1);
    if (hi <= lo) continue;
    s += `<rect class="band-acc" x="${x(lo)}" width="${x(hi) - x(lo)}" y="${y(b.acceptable)}" height="${y(-Math.min(b.acceptable, 100)) - y(b.acceptable)}"><title>${esc(`${int(lo)}–${b.max === Infinity ? 'more' : int(b.max)} riders: acceptable ±${b.acceptable}%, preferable ±${b.preferable}%`)}</title></rect>`;
    s += `<rect class="band-pref" x="${x(lo)}" width="${x(hi) - x(lo)}" y="${y(b.preferable)}" height="${y(-Math.min(b.preferable, 100)) - y(b.preferable)}"/>`;
    lo = hi;
  }
  s += `<line class="axis-line" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  const placed: Box[] = pts.map((p) => ({ x0: x(p.observed) - 4, y0: y(Math.min(p.pct, yMax)) - 4, x1: x(p.observed) + 4, y1: y(Math.min(p.pct, yMax)) + 4 }));
  const labels: string[] = [];
  for (const p of pts) {
    s += `<circle class="dot${p.acceptable ? '' : ' out'}" cx="${x(p.observed).toFixed(1)}" cy="${y(Math.min(p.pct, yMax)).toFixed(1)}" r="4"><title>${esc(`Route ${p.route} (${p.category}): ${spc(p.pct / 100)} at ${int(p.observed)} counted boardings; ${p.acceptable ? 'within' : 'outside'} the acceptable band`)}</title></circle>`;
    if (!p.acceptable) labels.push(placeLabel(x(p.observed), y(Math.min(p.pct, yMax)), p.route, placed, L, W - R, T, H - B));
  }
  s += labels.join('');
  s += text((L + W - R) / 2, H - 4, 'Counted weekday boardings on the route (log scale)', 'axis', 'middle');
  s += text(-(T + (H - B - T) / 2), 12, 'Model error', 'axis', 'middle', ' transform="rotate(-90)"');
  return svg(W, H, s, 'Percent error of each Muni route against its counted boardings, with the FHWA acceptable and preferable bands');
};

// ---------- horizontal paired bars (observed, model), with an optional inner segment ----------
interface PairRow {
  label: string;
  obs: number;
  mod: number;
  /** part of the observed bar drawn hatched (e.g. trips the model does not carry) */
  part?: number;
  note?: string;
  /** of the modeled value, the part held fixed (background riders), drawn hatched */
  modPart?: number;
}
function pairedBars(rows: PairRow[], w: number, label: string, unit: string): string {
  const W = Math.min(w, 760);
  const L = W < 480 ? 92 : 150, R = 58, T = 6, rowH = 30, B = 30;
  const H = T + rows.length * rowH + B;
  const max = Math.max(...rows.flatMap((r) => [r.obs, r.mod]));
  const maxTicks = Math.max(3, Math.floor((W - L - R) / 56));
  const step = [1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000].find((s) => max / s <= maxTicks) ?? 100000;
  const xm = Math.ceil(max / step) * step;
  const x = linScale(0, xm, L, W - R);
  let s = rows.some((r) => r.part) ? `<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><rect width="4" height="4" class="bar-obs"/><rect width="2" height="4" class="hatch"/></pattern></defs>` : '';
  if (rows.some((r) => r.modPart)) s += `<defs><pattern id="hatch-mod" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><rect width="4" height="4" class="bar-mod"/><rect width="2" height="4" class="hatch"/></pattern></defs>`;
  for (let v = 0; v <= xm; v += step) s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}"/>` + text(x(v), H - B + 15, tick(v), 'tick', 'middle');
  rows.forEach((r, i) => {
    const y0 = T + i * rowH + 4;
    s += text(L - 8, y0 + 15, r.label, 'row-lbl', 'end');
    s += `<rect class="bar-obs" x="${L}" y="${y0}" width="${Math.max(0, x(r.obs) - L)}" height="10" rx="1.5"><title>${esc(`${r.label}: counted ${int(r.obs)} ${unit}`)}</title></rect>`;
    if (r.part) s += `<rect class="bar-part" x="${x(r.obs - r.part)}" y="${y0}" width="${x(r.obs) - x(r.obs - r.part)}" height="10"><title>${esc(`${r.label}: ${int(r.part)} of the counted trips have neither end in the city`)}</title></rect>`;
    s += `<rect class="bar-mod" x="${L}" y="${y0 + 12}" width="${Math.max(0, x(r.mod) - L)}" height="10" rx="1.5"><title>${esc(`${r.label}: modeled ${int(r.mod)} ${unit}`)}</title></rect>`;
    if (r.modPart) s += `<rect class="bar-modpart" x="${x(r.mod - r.modPart)}" y="${y0 + 12}" width="${x(r.mod) - x(r.mod - r.modPart)}" height="10"><title>${esc(`${r.label}: ${int(r.modPart)} of the modeled riders are background riders with neither station in the city, held fixed`)}</title></rect>`;
    s += text(Math.max(x(r.obs), x(r.mod)) + 6, y0 + 15, r.note ?? spc(r.mod / r.obs - 1), 'val');
  });
  s += `<line class="axis-line" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/>`;
  s += text((L + W - R) / 2, H - 2, unit[0].toUpperCase() + unit.slice(1), 'axis', 'middle');
  return svg(W, H, s, label);
}

export const bartStations: Render = (w) =>
  pairedBars(
    V.bart.wkd.exits.map((e) => ({ label: w < 480 ? e.code : e.name.replace(' / UN Plaza', '').replace(' / Mission', ''), obs: e.observed, mod: e.model })),
    w,
    'BART exits on an average weekday at the nine city-area stations, counted and modeled',
    'exits per weekday',
  );

export const bartSegments: Render = (w) => {
  const thr = new Map(F.bartThrough.map((t) => [`${t.a}-${t.b}`, t.through]));
  return pairedBars(
    V.bart.segments.loads.map((g) => ({ label: `${g.a}–${g.b}`, obs: g.observed, mod: g.model, part: thr.get(`${g.a}-${g.b}`) ?? 0, modPart: (g as { background?: number }).background ?? 0 })),
    w,
    'BART passenger loads on the nine segments from West Oakland to Daly City, counted and modeled, both directions over the day',
    'passengers per weekday',
  );
};

const ctShort = (n: string) => n.replace('South San Francisco', 'S. San Francisco').replace('San Jose Diridon', 'San Jose').replace('California Ave', 'Calif. Ave').replace('22nd Street', '22nd St');
/** Caltrain loads on each stretch, one direction and peak, counted (estimated) and modeled with the background riders hatched */
export const caltrainSegments = (dir: 'NB' | 'SB', period: 'AM' | 'PM'): Render => (w) => {
  const rows = (VX.caltrainRegional?.segments.peakRows ?? []).filter((x) => x.dir === dir && x.period === period);
  const ordered = dir === 'NB' ? rows.slice().reverse() : rows;
  return pairedBars(
    ordered.map((x) => ({ label: w < 480 ? `${ctShort(x.a).slice(0, 9)}–${ctShort(x.b).slice(0, 9)}` : `${ctShort(x.a)}–${ctShort(x.b)}`, obs: x.observed, mod: x.model, modPart: x.background })),
    w,
    `Caltrain ${dir === 'NB' ? 'northbound' : 'southbound'} riders on each stretch in the ${period === 'AM' ? 'morning' : 'evening'} peak, estimated from the 2024 survey and FY2026 boardings, and modeled with background riders`,
    `riders, ${period === 'AM' ? '6–10am' : '3–7pm'}`,
  );
};

// ---------- Figure: time of day ----------
export const timeOfDay: Render = (w) => {
  const rows = V.timeOfDay.rows;
  const W = Math.min(w, 520), L = 40, R = 8, T = 10, B = 40, H = 220;
  const max = Math.ceil(Math.max(...rows.flatMap((r) => [r.observed, r.model])) * 10) / 10;
  const y = linScale(0, max, H - B, T);
  const gw = (W - L - R) / rows.length;
  const NAMES: Record<string, string> = { AM: '6–10am', MD: '10am–3pm', PM: '3–7pm', NT: '7pm–6am' };
  let s = '';
  for (let v = 0; v <= max + 1e-9; v += 0.1) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>` + text(L - 6, y(v) + 4, `${Math.round(v * 100)}%`, 'tick', 'end');
  rows.forEach((r, i) => {
    const cx = L + gw * (i + 0.5), bw = Math.min(26, gw * 0.3);
    s += `<rect class="bar-obs" x="${cx - bw - 1}" y="${y(r.observed)}" width="${bw}" height="${y(0) - y(r.observed)}" rx="1.5"><title>${esc(`${NAMES[r.period]}: counted ${(100 * r.observed).toFixed(1)}%`)}</title></rect>`;
    s += `<rect class="bar-mod" x="${cx + 1}" y="${y(r.model)}" width="${bw}" height="${y(0) - y(r.model)}" rx="1.5"><title>${esc(`${NAMES[r.period]}: modeled ${(100 * r.model).toFixed(1)}%`)}</title></rect>`;
    s += text(cx, H - B + 16, r.period, 'tick', 'middle') + text(cx, H - B + 30, NAMES[r.period], 'tick sub', 'middle');
  });
  s += `<line class="axis-line" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  return svg(W, H, s, 'Share of weekday BART exits at the eight San Francisco stations by period, counted and modeled');
};

// ---------- Figure: elasticities against published ranges ----------
export const elasticity: Render = (w) => {
  // a frequency test is scored on its corridor (the route and the lines sharing its street); the route alone is shown beside it
  const rows = V.sensitivity as ((typeof V.sensitivity)[number] & { corridorElasticity?: number })[];
  const scored = (r: (typeof rows)[number]) => r.corridorElasticity ?? r.elasticity;
  const W = Math.min(w, 760), L = W < 480 ? 118 : 190, R = 16, T = 8, rowH = 34, B = 34;
  const H = T + rows.length * rowH + B;
  const lo = Math.min(-1, ...rows.map((r) => Math.min(r.elasticity, scored(r), r.range[0]))) - 0.1;
  const hi = Math.max(1, ...rows.map((r) => Math.max(r.elasticity, scored(r), r.range[1]))) + 0.1;
  const x = linScale(lo, hi, L, W - R);
  let s = '';
  for (let v = Math.ceil(lo * 2) / 2; v <= hi; v += 0.5) s += `<line class="${v === 0 ? 'axis-line' : 'grid'}" x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}"/>` + text(x(v), H - B + 15, v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`, 'tick', 'middle');
  rows.forEach((r, i) => {
    const yc = T + i * rowH + rowH / 2;
    const name = W < 480 ? r.test.replace(' service', '').replace('running time', 'time').replace('Car running cost', 'Car cost') : r.test;
    s += text(L - 8, yc + 4, name, 'row-lbl', 'end');
    s += `<rect class="range" x="${x(r.range[0])}" y="${yc - 6}" width="${x(r.range[1]) - x(r.range[0])}" height="12" rx="2"><title>${esc(`Published range ${r.range[0]} to ${r.range[1]}`)}</title></rect>`;
    s += `<line class="central" x1="${x(r.central)}" x2="${x(r.central)}" y1="${yc - 8}" y2="${yc + 8}"/>`;
    const e = scored(r);
    const inside = e >= r.range[0] && e <= r.range[1];
    if (r.corridorElasticity !== undefined && Math.abs(r.corridorElasticity - r.elasticity) > 0.005) s += `<circle class="dot muted" cx="${x(r.elasticity)}" cy="${yc}" r="3.5"><title>${esc(`${r.test}: route alone ${r.elasticity.toFixed(2)}`)}</title></circle>`;
    s += `<circle class="dot${inside ? '' : ' out'}" cx="${x(e)}" cy="${yc}" r="5"><title>${esc(`${r.test}: model elasticity ${e.toFixed(2)} (${r.corridorElasticity !== undefined ? 'corridor' : r.measure})`)}</title></circle>`;
  });
  s += text((L + W - R) / 2, H - 2, 'Elasticity', 'axis', 'middle');
  return svg(W, H, s, 'Model elasticities against the ranges published in TCRP Report 95 and UK TAG M2.1');
};

// ---------- Figure: backcast ----------
export const backcastChart: Render = (w) => {
  const rows = BC.rows;
  const W = Math.min(w, 560), L = 60, R = 12, T = 12, B = 40;
  const side = W - L - R, H = T + side + B;
  const m = Math.ceil(Math.max(...rows.flatMap((r) => [Math.abs(r.obsRelChange), Math.abs(r.modelRelChange)])) * 10) / 10;
  const x = linScale(-m, m, L, L + side), y = linScale(-m, m, T + side, T);
  const maxRiders = Math.max(...rows.map((r) => r.observed2026));
  let s = '';
  const stepv = m > 0.6 ? 0.2 : 0.1;
  for (let v = Math.ceil(-m / stepv - 1e-9) * stepv; v <= m + 1e-9; v += stepv) {
    const lab = `${Math.round(v * 100) > 0 ? '+' : Math.round(v * 100) < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}%`;
    s += `<line class="${Math.abs(v) < 1e-9 ? 'axis-line' : 'grid'}" x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${T + side}"/><line class="${Math.abs(v) < 1e-9 ? 'axis-line' : 'grid'}" x1="${L}" x2="${L + side}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += text(x(v), T + side + 16, lab, 'tick', 'middle') + text(L - 6, y(v) + 4, lab, 'tick', 'end');
  }
  s += `<line class="one" x1="${x(-m)}" y1="${y(-m)}" x2="${x(m)}" y2="${y(m)}"/>`;
  const changed = (r: (typeof rows)[number]) => r.runs2024 > 0 && Math.abs(r.runs2026 / r.runs2024 - 1) > 0.1;
  const placed: Box[] = [];
  const labels: string[] = [];
  const sorted = rows.slice().sort((a, b) => b.observed2026 - a.observed2026);
  for (const r of sorted) {
    const rad = 2.5 + 7 * Math.sqrt(r.observed2026 / maxRiders);
    placed.push({ x0: x(r.obsRelChange) - rad, y0: y(r.modelRelChange) - rad, x1: x(r.obsRelChange) + rad, y1: y(r.modelRelChange) + rad });
  }
  for (const r of sorted) {
    const rad = 2.5 + 7 * Math.sqrt(r.observed2026 / maxRiders);
    const c = changed(r);
    s += `<circle class="${c ? 'dot hl' : 'dot muted'}" cx="${x(r.obsRelChange).toFixed(1)}" cy="${y(r.modelRelChange).toFixed(1)}" r="${rad.toFixed(1)}"><title>${esc(`Route ${r.route}: counted ${spc(r.obsRelChange)}, modeled ${spc(r.modelRelChange)} relative to the system; scheduled trips ${r.runs2024} → ${r.runs2026}`)}</title></circle>`;
    if (c || Math.abs(r.obsRelChange - r.modelRelChange) > 0.25) labels.push(placeLabel(x(r.obsRelChange), y(r.modelRelChange), r.route, placed, L, L + side, T, T + side).replace('pt-lbl', c ? 'pt-lbl strong' : 'pt-lbl'));
  }
  s += labels.join('');
  s += text(L + side / 2, H - 4, 'Counted change, 2024 to 2026, relative to the system', 'axis', 'middle');
  s += text(-(T + side / 2), 12, 'Modeled change', 'axis', 'middle', ' transform="rotate(-90)"');
  return svg(W, H, s, "Backcast: modeled against counted change in each Muni route's weekday riders between summer 2024 and summer 2026, relative to the system");
};

// ---------- Figure: model structure ----------
export const structure: Render = (w) => {
  const narrow = w < 600;
  const boxes = narrow
    ? [
        ['in', 12, 10, 'Inputs', 'zones, streets, GTFS, fares'],
        ['skim', 12, 74, 'Transit skims', 'optimal strategies, AM, MD, PM'],
        ['gen', 12, 138, 'Tour generation', 'commutes, NHTS tours, visitors'],
        ['dest', 12, 202, 'Destination choice', 'size and mode-choice logsum'],
        ['mode', 12, 266, 'Mode choice', 'nested logit, one per tour'],
        ['tod', 12, 330, 'Stops, time of day', 'NHTS stops and shares'],
        ['asg', 12, 394, 'Transit assignment', 'optimal strategies, 4 periods'],
        ['crowd', 12, 458, 'Crowding', 'TM2 curves, averaged'],
      ]
    : [
        ['in', 10, 20, 'Inputs', 'zones, streets, GTFS, fares'],
        ['skim', 200, 20, 'Transit skims', 'strategies, AM, MD, PM'],
        ['gen', 390, 20, 'Tour generation', 'commutes, NHTS, visitors'],
        ['dest', 580, 20, 'Destination choice', 'size and logsum'],
        ['mode', 580, 116, 'Mode choice', 'nested logit per tour'],
        ['tod', 390, 116, 'Stops, time of day', 'NHTS stops, shares'],
        ['asg', 200, 116, 'Assignment', 'strategies, 4 periods'],
        ['crowd', 10, 116, 'Crowding', 'TM2 curves, averaged'],
      ];
  const bw = narrow ? Math.min(w - 24, 320) : 170, bh = 50;
  const W = narrow ? bw + 24 + 40 : 760, H = narrow ? 520 : 196;
  const pos = Object.fromEntries(boxes.map(([id, x, y]) => [id as string, { x: x as number, y: y as number }]));
  let s = `<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="arrowhead"/></marker></defs>`;
  const link = (a: string, b: string, cls = 'flow') => {
    const A = pos[a], Bp = pos[b];
    if (narrow) return `<line class="${cls}" x1="${A.x + bw / 2}" y1="${A.y + bh}" x2="${Bp.x + bw / 2}" y2="${Bp.y - 2}" marker-end="url(#arr)"/>`;
    if (A.y === Bp.y) {
      const dir = Bp.x > A.x ? 1 : -1;
      return `<line class="${cls}" x1="${dir > 0 ? A.x + bw : A.x}" y1="${A.y + bh / 2}" x2="${dir > 0 ? Bp.x - 2 : Bp.x + bw + 2}" y2="${Bp.y + bh / 2}" marker-end="url(#arr)"/>`;
    }
    return `<line class="${cls}" x1="${A.x + bw / 2}" y1="${A.y + bh}" x2="${Bp.x + bw / 2}" y2="${Bp.y - 2}" marker-end="url(#arr)"/>`;
  };
  for (const [a, b] of [['in', 'skim'], ['skim', 'gen'], ['gen', 'dest'], ['dest', 'mode'], ['mode', 'tod'], ['tod', 'asg'], ['asg', 'crowd']]) s += link(a, b);
  // feedback: crowding back to the skims (second pass)
  if (narrow) {
    const c = pos.crowd, k = pos.skim;
    s += `<path class="flow fb" d="M${c.x + bw} ${c.y + bh / 2} H${c.x + bw + 22} V${k.y + bh / 2} H${k.x + bw + 2}" marker-end="url(#arr)"/>`;
    s += text(c.x + bw + 30, (c.y + k.y) / 2 + bh / 2, 'next pass', 'tick', 'middle', ` transform="rotate(90 ${c.x + bw + 30} ${(c.y + k.y) / 2 + bh / 2})"`);
  } else {
    const c = pos.crowd, k = pos.skim;
    const yMid = (k.y + bh + c.y) / 2;
    s += `<path class="flow fb" d="M${c.x + bw / 2} ${c.y - 2} V${yMid} H${k.x + bw / 2} V${k.y + bh + 2}" marker-end="url(#arr)"/>`;
    s += text(c.x + bw / 2 + 8, yMid - 5, 'next pass', 'tick', 'start');
  }
  for (const [, x, y, t, sub] of boxes) {
    s += `<rect class="node" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="3"/>`;
    s += text((x as number) + 10, (y as number) + 21, t as string, 'node-t') + text((x as number) + 10, (y as number) + 38, sub as string, 'node-s');
  }
  return svg(W, H, s, 'Model structure: inputs, transit skims, tour generation, destination choice, mode choice, stops and time of day, transit assignment, and crowding, with crowding fed back for the next pass');
};

export const CHARTS: Record<string, Render> = {
  structure,
  'muni-wkd': muniScatter('wkd'),
  'muni-sat': muniScatter('sat'),
  'muni-sun': muniScatter('sun'),
  'muni-bands': muniBands,
  'bart-stations': bartStations,
  'bart-segments': bartSegments,
  'caltrain-am-nb': caltrainSegments('NB', 'AM'),
  'caltrain-pm-sb': caltrainSegments('SB', 'PM'),
  tod: timeOfDay,
  elasticity,
  backcast: backcastChart,
};
export { DAYS };
