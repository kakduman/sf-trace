/**
 * Hand-written SVG charts. Each returns an SVG string sized by viewBox to the sidebar width.
 * Marks carry `data-tip` (HTML) for the shared hover tooltip (ui/tooltip.ts). Text uses text
 * color classes, never the series color; gridlines are recessive hairlines; one y-axis.
 */
import { compact, esc, int } from './format';

/** drawing width in px: charts are drawn for the panel's width so text stays at its intended size */
export let W = 360;
export function setChartWidth(px: number): void {
  if (px > 0) W = Math.max(280, Math.min(720, Math.round(px)));
}

const attr = (s: string) => esc(s);
/** rounded data-end bar path (4px radius at the far end, square at the baseline) */
function hbarPath(x0: number, x1: number, y: number, h: number, r = 3): string {
  const w = x1 - x0;
  if (Math.abs(w) < 0.5) return '';
  const rr = Math.min(r, Math.abs(w), h / 2);
  if (w > 0) return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}
function vbarPath(x: number, w: number, y0: number, y1: number, r = 3): string {
  const h = y0 - y1;
  if (h < 0.5) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
}

/** clean tick values for 0..max */
export function ticks(max: number, n = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

// ---------- horizontal bars (optionally stacked) ----------

export interface BarSeg {
  v: number;
  color: string;
  tip?: string;
  /** lighter wash for a secondary part of the same thing */
  wash?: boolean;
}
export interface BarRow {
  label: string;
  sub?: string;
  segs: BarSeg[];
  /** text at the bar end (defaults to the total) */
  end?: string;
  tip?: string;
}

export function hbars(rows: BarRow[], opts: { labelW?: number; rowH?: number; max?: number; fmt?: (v: number) => string; axis?: boolean } = {}): string {
  const labelW = opts.labelW ?? 112, rowH = opts.rowH ?? 26, barH = Math.min(16, rowH - 8);
  const fmt = opts.fmt ?? compact;
  const totals = rows.map((r) => r.segs.reduce((a, s) => a + s.v, 0));
  const max = opts.max ?? Math.max(1, ...totals);
  // room for the longest end label (about 6px per character at 11px)
  const endW = 8 + 6.2 * Math.max(4, ...rows.map((r, i) => (r.end ?? fmt(totals[i])).length));
  const x0 = labelW, x1 = W - endW;
  const sx = (v: number) => x0 + ((x1 - x0) * v) / max;
  const top = 4;
  const H = top + rows.length * rowH + (opts.axis ? 18 : 2);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  if (opts.axis)
    for (const t of ticks(max, 3)) {
      if (t > max * 1.0001) continue;
      s += `<line class="grid" x1="${sx(t)}" x2="${sx(t)}" y1="${top}" y2="${H - 16}"/><text class="ax" x="${sx(t)}" y="${H - 4}" text-anchor="middle">${fmt(t)}</text>`;
    }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const by = y + (rowH - barH) / 2;
    s += `<g class="row"${r.tip ? ` data-tip="${attr(r.tip)}"` : ''}><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/>`;
    s += `<text class="lbl" x="0" y="${y + rowH / 2 + 4}">${esc(r.label)}${r.sub ? `<tspan class="ax"> ${esc(r.sub)}</tspan>` : ''}</text>`;
    let acc = 0;
    const segs = r.segs.filter((g) => g.v > 0);
    segs.forEach((g, j) => {
      const a = sx(acc), b = sx(acc + g.v);
      acc += g.v;
      const last = j === segs.length - 1;
      // 2px surface gap between stacked parts
      const bb = last ? b : Math.max(a, b - 2);
      const d = last ? hbarPath(a, bb, by, barH) : `M${a},${by}H${bb}V${by + barH}H${a}Z`;
      if (d) s += `<path d="${d}" fill="${g.color}"${g.wash ? ' fill-opacity="0.35"' : ''}${g.tip ? ` data-tip="${attr(g.tip)}"` : ''}/>`;
    });
    s += `<text class="val" x="${sx(acc) + 6}" y="${y + rowH / 2 + 4}">${esc(r.end ?? fmt(totals[i]))}</text></g>`;
  });
  return s + '</svg>';
}

// ---------- diverging horizontal bars (signed values around zero) ----------

export interface DivRow {
  label: string;
  v: number;
  tip?: string;
  end?: string;
}
export function divbars(rows: DivRow[], opts: { labelW?: number; fmt?: (v: number) => string; pos?: string; neg?: string } = {}): string {
  const labelW = opts.labelW ?? 112, rowH = 24, barH = 14;
  const fmt = opts.fmt ?? ((v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + compact(Math.abs(v)));
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.v)));
  const endW = 50;
  const hasNeg = rows.some((r) => r.v < 0), hasPos = rows.some((r) => r.v > 0);
  // put zero where it leaves room for both sides that occur
  const span = W - labelW - (hasNeg && hasPos ? 2 * endW : endW);
  const zero = labelW + (hasNeg ? (hasPos ? endW + span / 2 : endW + span) : 0);
  const half = hasNeg && hasPos ? span / 2 : span;
  const H = rows.length * rowH + 4;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"><line class="base" x1="${zero}" x2="${zero}" y1="0" y2="${H}"/>`;
  rows.forEach((r, i) => {
    const y = 2 + i * rowH, by = y + (rowH - barH) / 2;
    const x = zero + (half * r.v) / max;
    const color = r.v >= 0 ? (opts.pos ?? 'var(--c-up)') : (opts.neg ?? 'var(--c-down)');
    s += `<g class="row"${r.tip ? ` data-tip="${attr(r.tip)}"` : ''}><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/><text class="lbl" x="0" y="${y + rowH / 2 + 4}">${esc(r.label)}</text>`;
    const d = hbarPath(zero, x, by, barH);
    if (d) s += `<path d="${d}" fill="${color}"/>`;
    const tx = r.v >= 0 ? Math.max(x, zero) + 5 : Math.min(x, zero) - 5;
    s += `<text class="val" x="${tx}" y="${y + rowH / 2 + 4}" text-anchor="${r.v >= 0 ? 'start' : 'end'}">${esc(r.end ?? fmt(r.v))}</text></g>`;
  });
  return s + '</svg>';
}

// ---------- columns (ordered categories such as periods) ----------

export interface ColGroup {
  label: string;
  sub?: string;
  bars: { v: number; color: string; tip?: string }[];
}
export function columns(groups: ColGroup[], opts: { h?: number; fmt?: (v: number) => string; unit?: string } = {}): string {
  const H = opts.h ?? 150, left = 40, bottom = 32, top = 14;
  const fmt = opts.fmt ?? compact;
  const max = Math.max(1, ...groups.flatMap((g) => g.bars.map((b) => b.v)));
  const tk = ticks(max, 3);
  const ymax = tk[tk.length - 1];
  const sy = (v: number) => H - bottom - ((H - bottom - top) * v) / ymax;
  const gw = (W - left) / groups.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  for (const t of tk) s += `<line class="${t === 0 ? 'base' : 'grid'}" x1="${left}" x2="${W}" y1="${sy(t)}" y2="${sy(t)}"/><text class="ax" x="${left - 6}" y="${sy(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
  groups.forEach((g, i) => {
    const n = g.bars.length;
    const bw = Math.min(24, (gw - 16) / n - 2);
    const gx = left + i * gw + (gw - (bw * n + 2 * (n - 1))) / 2;
    g.bars.forEach((b, j) => {
      const x = gx + j * (bw + 2);
      const d = vbarPath(x, bw, sy(0), sy(b.v));
      s += `<g${b.tip ? ` data-tip="${attr(b.tip)}"` : ''}><rect class="hit" x="${x - 1}" y="${top}" width="${bw + 2}" height="${H - bottom - top}"/>${d ? `<path d="${d}" fill="${b.color}"/>` : ''}</g>`;
      if (n === 1) s += `<text class="val" x="${x + bw / 2}" y="${sy(b.v) - 4}" text-anchor="middle">${fmt(b.v)}</text>`;
    });
    s += `<text class="lbl" x="${left + i * gw + gw / 2}" y="${H - bottom + 15}" text-anchor="middle">${esc(g.label)}</text>`;
    if (g.sub) s += `<text class="ax" x="${left + i * gw + gw / 2}" y="${H - bottom + 28}" text-anchor="middle">${esc(g.sub)}</text>`;
  });
  return s + '</svg>';
}

// ---------- scatter: modeled vs observed, equal axes ----------

export interface ScatterPt {
  x: number;
  y: number;
  label: string;
  tip: string;
  flag?: boolean;
  key?: string;
}
export function scatter(pts: ScatterPt[], opts: { log?: boolean; xLabel: string; yLabel: string; band?: number }): string {
  const S = W, pad = { l: 44, r: 10, t: 10, b: 36 };
  const plot = S - pad.l - pad.r;
  const H = pad.t + plot + pad.b;
  const max = Math.max(1, ...pts.flatMap((p) => [p.x, p.y]));
  const log = !!opts.log;
  const lo = log ? Math.max(100, 10 ** Math.floor(Math.log10(Math.max(1, Math.min(...pts.flatMap((p) => [p.x, p.y]).filter((v) => v > 0)))))) : 0;
  const tk = log ? logTicks(lo, max) : ticks(max, 4);
  const hi = tk[tk.length - 1];
  const f = (v: number) => (log ? (Math.log10(Math.max(lo, v)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : v / hi);
  const sx = (v: number) => pad.l + plot * f(v);
  const sy = (v: number) => pad.t + plot * (1 - f(v));
  let s = `<svg class="chart scatter" viewBox="0 0 ${S} ${H}" role="img">`;
  for (const t of tk) {
    s += `<line class="${t === tk[0] ? 'base' : 'grid'}" x1="${pad.l}" x2="${pad.l + plot}" y1="${sy(t)}" y2="${sy(t)}"/><text class="ax" x="${pad.l - 6}" y="${sy(t) + 4}" text-anchor="end">${compact(t)}</text>`;
    s += `<line class="${t === tk[0] ? 'base' : 'grid'}" y1="${pad.t}" y2="${pad.t + plot}" x1="${sx(t)}" x2="${sx(t)}"/><text class="ax" x="${sx(t)}" y="${pad.t + plot + 14}" text-anchor="middle">${compact(t)}</text>`;
  }
  // ±band around the 1:1 line
  const b = opts.band ?? 0.25;
  const steps = 24;
  const xs = Array.from({ length: steps + 1 }, (_, i) => (log ? lo * (hi / lo) ** (i / steps) : (hi * i) / steps));
  const up = xs.map((x) => [sx(Math.min(hi, x)), sy(Math.min(hi, x * (1 + b)))]);
  const dn = xs.map((x) => [sx(x), sy(Math.max(log ? lo : 0, x * (1 - b)))]).reverse();
  s += `<path class="band" d="M${[...up, ...dn].map((p) => p.map((v) => v.toFixed(1)).join(',')).join('L')}Z"/>`;
  s += `<line class="oneone" x1="${sx(log ? lo : 0)}" y1="${sy(log ? lo : 0)}" x2="${sx(hi)}" y2="${sy(hi)}"/>`;
  s += `<text class="ax" x="${sx(hi) - 4}" y="${sy(hi) + 12}" text-anchor="end">1:1</text>`;
  s += `<text class="ax" x="${pad.l + plot / 2}" y="${H - 4}" text-anchor="middle">${esc(opts.xLabel)}</text>`;
  s += `<text class="ax" transform="translate(11 ${pad.t + plot / 2}) rotate(-90)" text-anchor="middle">${esc(opts.yLabel)}</text>`;
  // points: flagged (outside the band) drawn on top and labeled
  const sorted = [...pts].sort((a, c) => Number(!!a.flag) - Number(!!c.flag));
  for (const p of sorted) {
    const cx = sx(p.x), cy = sy(p.y);
    s += `<g class="pt${p.flag ? ' flag' : ''}" data-tip="${attr(p.tip)}"${p.key ? ` data-key="${attr(p.key)}"` : ''}><circle class="hit" cx="${cx}" cy="${cy}" r="9"/><circle class="dot" cx="${cx}" cy="${cy}" r="4.5"/></g>`;
  }
  // label the flagged points, biggest misses first, skipping labels that would collide
  const placed: [number, number, number, number][] = [];
  const flagged = pts.filter((p) => p.flag).sort((a, c) => Math.abs(c.y - c.x) - Math.abs(a.y - a.x));
  for (const p of flagged) {
    const x = sx(p.x) + 7, y = sy(p.y) + 4;
    const box: [number, number, number, number] = [x - 2, y - 10, x + p.label.length * 6.5 + 2, y + 2];
    if (box[2] > S - 2 || placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    // keep labels off other dots too
    if (pts.some((q) => q !== p && sx(q.x) > box[0] - 3 && sx(q.x) < box[2] + 3 && sy(q.y) > box[1] - 3 && sy(q.y) < box[3] + 3)) continue;
    placed.push(box);
    s += `<text class="ptl" x="${x}" y="${y}">${esc(p.label)}</text>`;
  }
  return s + '</svg>';
}
function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = lo; v < hi * 10; v *= 10) {
    out.push(v);
    if (v >= hi) break;
  }
  return out;
}

// ---------- paired bars: observed vs modeled ----------

export interface PairRow {
  label: string;
  a: number;
  b: number;
  tip: string;
}
export function pairs(rows: PairRow[], opts: { aColor: string; bColor: string; labelW?: number; fmt?: (v: number) => string }): string {
  const labelW = opts.labelW ?? 112, rowH = 30, bh = 10;
  const fmt = opts.fmt ?? compact;
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const x0 = labelW, x1 = W - 48;
  const sx = (v: number) => x0 + ((x1 - x0) * v) / max;
  const H = rows.length * rowH + 20;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  for (const t of ticks(max, 3)) if (t <= max) s += `<line class="grid" x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${H - 16}"/><text class="ax" x="${sx(t)}" y="${H - 4}" text-anchor="middle">${fmt(t)}</text>`;
  rows.forEach((r, i) => {
    const y = i * rowH + 3;
    s += `<g class="row" data-tip="${attr(r.tip)}"><rect class="hit" x="0" y="${y - 2}" width="${W}" height="${rowH}"/><text class="lbl" x="0" y="${y + bh + 4}">${esc(r.label)}</text>`;
    s += `<path d="${hbarPath(x0, sx(r.a), y, bh)}" fill="${opts.aColor}"/><path d="${hbarPath(x0, sx(r.b), y + bh + 2, bh)}" fill="${opts.bColor}"/>`;
    s += `<text class="val sm" x="${sx(r.a) + 4}" y="${y + bh - 1}">${fmt(r.a)}</text><text class="val sm" x="${sx(r.b) + 4}" y="${y + 2 * bh + 1}">${fmt(r.b)}</text></g>`;
  });
  return s + '</svg>';
}

// ---------- load profile along a route ----------

export interface ProfileSeries {
  label: string;
  color: string;
  /** load per hop */
  v: number[];
  /** dashed reference (capacity) */
  ref?: boolean;
  /** area wash under the line */
  area?: boolean;
}
/**
 * Step chart of the load on each hop, x = distance along the route. Stops are tick marks; hovering
 * a hop shows the stop pair and every series' value.
 */
export function loadProfile(stopNames: string[], dist: number[], series: ProfileSeries[], opts: { unit: string; h?: number }): string {
  const H = opts.h ?? 170, pad = { l: 44, r: 8, t: 10, b: 30 };
  const total = dist[dist.length - 1] || 1;
  const max = Math.max(1, ...series.flatMap((s) => s.v));
  const tk = ticks(max, 3);
  const ymax = tk[tk.length - 1];
  const sx = (d: number) => pad.l + ((W - pad.l - pad.r) * d) / total;
  const sy = (v: number) => H - pad.b - ((H - pad.b - pad.t) * v) / ymax;
  let s = `<svg class="chart loadprof" viewBox="0 0 ${W} ${H}" role="img">`;
  for (const t of tk) s += `<line class="${t === 0 ? 'base' : 'grid'}" x1="${pad.l}" x2="${W - pad.r}" y1="${sy(t)}" y2="${sy(t)}"/><text class="ax" x="${pad.l - 6}" y="${sy(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  for (const d of dist) s += `<line class="stoptick" x1="${sx(d)}" x2="${sx(d)}" y1="${H - pad.b}" y2="${H - pad.b + 3}"/>`;
  for (const se of series) {
    let p = '';
    se.v.forEach((v, k) => {
      const a = sx(dist[k]), b = sx(dist[k + 1]), y = sy(v);
      p += `${k === 0 ? 'M' : 'L'}${a.toFixed(1)},${y.toFixed(1)}H${b.toFixed(1)}`;
    });
    if (!p) continue;
    if (se.area) s += `<path d="${p}V${sy(0)}H${sx(dist[0])}Z" fill="${se.color}" fill-opacity="0.12"/>`;
    s += `<path d="${p}" fill="none" stroke="${se.color}" stroke-width="${se.ref ? 1.5 : 2}"${se.ref ? ' stroke-dasharray="4 3"' : ''} stroke-linejoin="round"/>`;
  }
  // end labels: first and last stop
  s += `<text class="ax" x="${pad.l}" y="${H - 8}">${esc(short(stopNames[0]))}</text><text class="ax" x="${W - pad.r}" y="${H - 8}" text-anchor="end">${esc(short(stopNames[stopNames.length - 1]))}</text>`;
  // hover targets per hop
  for (let k = 0; k + 1 < dist.length; k++) {
    const a = sx(dist[k]), b = sx(dist[k + 1]);
    const tip = `<b>${esc(stopNames[k])}</b> → ${esc(stopNames[k + 1])}<br>` + series.map((se) => `<span class="sw" style="background:${se.color}"></span>${esc(se.label)}: ${int(se.v[k] ?? 0)} ${esc(opts.unit)}`).join('<br>');
    s += `<rect class="hit hop" x="${a}" y="${pad.t}" width="${Math.max(1, b - a)}" height="${H - pad.b - pad.t}" data-tip="${attr(tip)}"/>`;
  }
  return s + '</svg>';
}
const short = (n: string) => (n.length > 26 ? n.slice(0, 25) + '…' : n);

/** legend row for ≥2 series */
export function legend(items: { label: string; color: string; dashed?: boolean; wash?: boolean }[]): string {
  return `<div class="legend">${items
    .map((i) => `<span class="li"><span class="sw${i.dashed ? ' dash' : ''}" style="${i.dashed ? `border-color:${i.color}` : `background:${i.color}`}${i.wash ? ';opacity:.4' : ''}"></span>${esc(i.label)}</span>`)
    .join('')}</div>`;
}
