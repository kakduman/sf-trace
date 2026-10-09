/**
 * Article plumbing: numbering of figures, tables and equations, numbered citations in order of
 * first use, KaTeX equations, and number formatting. Sections are written as functions that
 * return HTML strings, rendered once in order, so citation numbers follow the text.
 */
import katex from 'katex';
import { OUTLINE } from './outline';
import { REFS, type RefKey } from './refs';

// ---------- figures, tables, equations: numbered in the order of first mention or appearance ----------
// (the article renders once, top to bottom, so the first call that names an id fixes its number)
export type FigId = string;
export type TabId = string;
export type EqId = string;
const figs: string[] = [], tabs: string[] = [], eqs: string[] = [];
const num = (list: string[], id: string) => (list.includes(id) ? 0 : list.push(id), list.indexOf(id) + 1);
export const figN = (id: FigId) => num(figs, id);
export const tabN = (id: TabId) => num(tabs, id);
export const eqN = (id: EqId) => num(eqs, id);
export const fig = (id: FigId) => `<a class="xref" href="#fig-${id}">Figure&nbsp;${figN(id)}</a>`;
export const tab = (id: TabId) => `<a class="xref" href="#tab-${id}">Table&nbsp;${tabN(id)}</a>`;
export const eq = (id: EqId) => `<a class="xref" href="#eq-${id}">Equation&nbsp;${eqN(id)}</a>`;

// ---------- sections: numbered from the outline (outline.ts) ----------
const SEC_NUM = new Map<string, { num: string; level: 2 | 3 }>();
{
  let major = 0, minor = 0;
  for (const it of OUTLINE) {
    if (it.level === 2) (major++, (minor = 0));
    else minor++;
    SEC_NUM.set(it.id, { num: it.level === 2 ? String(major) : `${major}.${minor}`, level: it.level });
  }
}
/** a section's number ("5.3"), or "?" for an id missing from the outline */
export function secN(id: string): string {
  const s = SEC_NUM.get(id);
  if (!s) console.warn(`section ${id} is not in outline.ts`);
  return s?.num ?? '?';
}
/** a cross-reference: "Section 5.3", linked */
export const sec = (id: string) => `<a class="xref" href="#${id}">Section&nbsp;${secN(id)}</a>`;
/** several: "Sections 3.4 and 5.2" */
export const secs = (...ids: string[]) => `Sections&nbsp;${list(ids.map((id) => `<a class="xref" href="#${id}">${secN(id)}</a>`))}`;

// ---------- citations (TRR style: numbered in order of first citation) ----------
const order: RefKey[] = [];
export function cite(...keys: (RefKey | [RefKey, string])[]): string {
  const parts = keys.map((k) => {
    const [key, loc] = Array.isArray(k) ? k : [k, ''];
    if (!REFS[key]) throw new Error(`unknown reference ${key}`);
    if (!order.includes(key)) order.push(key);
    const n = order.indexOf(key) + 1;
    return `<a class="cite" href="#ref-${key}" aria-label="reference ${n}">${n}</a>${loc ? `, ${loc}` : ''}`;
  });
  return `<span class="cites">(${parts.join('; ')})</span>`;
}
export const citedOrder = () => order.slice();

// ---------- equations ----------
export function math(tex: string): string {
  return katex.renderToString(tex, { throwOnError: true, output: 'htmlAndMathml' });
}
export function display(id: EqId, tex: string): string {
  return `<div class="equation" id="eq-${id}" role="group" aria-label="Equation ${eqN(id)}"><div class="eq-body">${katex.renderToString(tex, { displayMode: true, throwOnError: true, output: 'htmlAndMathml' })}</div><span class="eq-num" aria-hidden="true">(${eqN(id)})</span></div>`;
}

// ---------- blocks ----------
export function figure(id: FigId, svg: string, caption: string, opts: { alt: string; data?: string; wide?: boolean } = { alt: '' }): string {
  return `<figure class="fig${opts.wide === false ? '' : ' wide'}" id="fig-${id}">
  <div class="fig-art" role="img" aria-label="${esc(opts.alt)}">${svg}</div>
  <figcaption><span class="cap-label">Figure ${figN(id)}.</span> ${caption}</figcaption>
  ${opts.data ? `<details class="fig-data"><summary>Data for Figure ${figN(id)}</summary>${opts.data}</details>` : ''}
</figure>`;
}

export function table(id: TabId, caption: string, head: string[], rows: (string | number)[][], opts: { notes?: string; numeric?: number[]; wide?: boolean; cls?: string } = {}): string {
  const num = new Set(opts.numeric ?? []);
  const cell = (v: string | number, i: number, tag: 'td' | 'th') => `<${tag}${num.has(i) ? ' class="num"' : ''}>${v}</${tag}>`;
  return `<div class="table-block${opts.wide ? ' wide' : ''}${opts.cls ? ' ' + opts.cls : ''}" id="tab-${id}">
  <table>
    <caption><span class="cap-label">Table ${tabN(id)}.</span> ${caption}</caption>
    <thead><tr>${head.map((h, i) => cell(h, i, 'th')).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((v, i) => (i === 0 ? `<th scope="row"${num.has(0) ? ' class="num"' : ''}>${v}</th>` : cell(v, i, 'td'))).join('')}</tr>`).join('')}</tbody>
  </table>
  ${opts.notes ? `<p class="table-notes">${opts.notes}</p>` : ''}
</div>`;
}

/** a plain data table (inside figure data drawers) */
export function dataTable(head: string[], rows: (string | number)[][], numeric: number[] = []): string {
  const num = new Set(numeric);
  return `<div class="data-scroll"><table class="data"><thead><tr>${head.map((h, i) => `<th${num.has(i) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((v, i) => `<td${num.has(i) ? ' class="num"' : ''}>${v}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

/** a numbered section; its number and heading level come from the outline */
export function section(id: string, title: string, body: string): string {
  const level = SEC_NUM.get(id)?.level ?? 3;
  return `<section id="${id}" aria-labelledby="${id}-h"><h${level} id="${id}-h"><span class="sec-num">${secN(id)}</span> ${title}</h${level}>${body}</section>`;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- numbers ----------
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** 12,345 */
export const int = (n: number) => nf0.format(Math.round(n));
/** fixed decimals */
export const fx = (n: number, d = 2) => (n < 0 && +Math.abs(n).toFixed(d) !== 0 ? '−' : '') + Math.abs(n).toFixed(d);
/** 0.123 → 12.3% */
export const pc = (x: number, d = 0) => `${(100 * x).toFixed(d)}%`;
/** 0.123 → +12.3% (true minus) */
export const spc = (x: number, d = 0) => {
  const v = +(100 * x).toFixed(d);
  return v === 0 ? `0${d ? '.' + '0'.repeat(d) : ''}%` : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`;
};
/** a percentage already in percent units */
export const spcU = (v: number, d = 0) => spc(v / 100, d);
export const money = (n: number, d = 2) => `$${n.toFixed(d)}`;
/** a ratio to a share difference: 0.911 → −8.9% */
export const dev = (ratio: number, d = 1) => spc(ratio - 1, d);
/** 20261007 (or 2026-10-07) → October 7, 2026 */
export function ymd(s: string): string {
  const t = s.replace(/-/g, '');
  const d = new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function isoDate(s: string): string {
  return new Date(s).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Los_Angeles' });
}
/** small counts in words, as prose wants them */
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const nw = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 10 ? WORDS[n] : int(n));
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** a source note with balanced parentheses (some are cut at a semicolon upstream) */
export const balanced = (s: string) => s + ')'.repeat(Math.max(0, (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length));
/** list words: a and b; a, b, and c (serial comma) */
export function list(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}
/** "above"/"below" a threshold, for sentences that must stay true when results change */
export const vs = (v: number, t: number, hi = 'above', lo = 'below') => (v >= t ? hi : lo);

// ---------- statistics ----------
/** Pearson correlation, optionally weighted */
export function pearson(x: number[], y: number[], w: number[] = x.map(() => 1)): number {
  const W = w.reduce((a, v) => a + v, 0);
  const mx = x.reduce((a, v, i) => a + w[i] * v, 0) / W, my = y.reduce((a, v, i) => a + w[i] * v, 0) / W;
  let c = 0, vx = 0, vy = 0;
  x.forEach((v, i) => ((c += w[i] * (v - mx) * (y[i] - my)), (vx += w[i] * (v - mx) ** 2), (vy += w[i] * (y[i] - my) ** 2)));
  return c / Math.sqrt(vx * vy);
}
/** approximate 95% interval for a correlation from n pairs (Fisher's z) */
export function rInterval(r: number, n: number): [number, number] {
  if (n <= 3) return [NaN, NaN];
  const z = Math.atanh(r), s = 1.96 / Math.sqrt(n - 3);
  return [Math.tanh(z - s), Math.tanh(z + s)];
}
/** "0.88 to 0.96" */
export const interval = ([a, b]: [number, number], d = 2) => `${fx(a, d)} to ${fx(b, d)}`;
