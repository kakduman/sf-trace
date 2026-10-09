/** Number and text formatting, one place so units and rounding stay consistent. */

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** 12,345 */
export const int = (n: number) => (Number.isFinite(n) ? nf0.format(Math.round(n) === 0 ? 0 : n) : '–');
/** 12.3 */
export const dec1 = (n: number) => (Number.isFinite(n) ? nf1.format(n) : '–');

/** 950 · 12.3k · 1.24M — for chart labels and tight spaces */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  // thresholds on the rounded value, so 9,996 reads 10k (not 10.0k)
  if (a >= 9.995e8) return `${(n / 1e9).toFixed(a >= 9.95e9 ? 0 : 2)}B`;
  if (a >= 9.9995e5) return `${(n / 1e6).toFixed(a >= 9.995e6 ? 1 : 2)}M`;
  if (a >= 9.95e3) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 999.5) return `${(n / 1e3).toFixed(1)}k`;
  return int(n);
}

/** 0.1234 → 12.3% */
export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d).replace(/^-/, '−')}%` : '–');

/** a signed count: +1,234 / −1,234 (true minus sign) */
export function signedInt(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const r = Math.round(n);
  if (r === 0) return '0';
  return (r > 0 ? '+' : '−') + nf0.format(Math.abs(r));
}

export function signedCompact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  if (Math.abs(n) < 0.5) return '0';
  return (n > 0 ? '+' : '−') + compact(Math.abs(n));
}

/** signed relative change: +12.3% */
export function signedPct(x: number, d = 1): string {
  if (!Number.isFinite(x)) return '–';
  const v = x * 100;
  if (Math.abs(v) < 0.5 * 10 ** -d) return `0${d ? '.' + '0'.repeat(d) : ''}%`;
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(d) + '%';
}

/** percentage points: +1.2 pp */
export function signedPp(x: number, d = 1): string {
  if (!Number.isFinite(x)) return '–';
  const v = x * 100;
  if (Math.abs(v) < 0.5 * 10 ** -d) return '0 pp';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(d) + ' pp';
}

/** $1.2M, $34,500, $4.10 */
export function money(n: number, opts: { cents?: boolean } = {}): string {
  if (!Number.isFinite(n)) return '–';
  const s = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e5) return `${s}$${(a / 1e3).toFixed(0)}k`;
  if (opts.cents || a < 100) return `${s}$${a.toFixed(2)}`;
  return `${s}$${nf0.format(a)}`;
}

export const signedMoney = (n: number) => (Math.abs(n) < 0.5 ? '$0' : (n > 0 ? '+' : '') + money(n));

/** minutes, as "6 min" or "1 h 05 min" */
export function minutes(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 60) return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(Math.round(m - h * 60)).padStart(2, '0')} min`;
}

/** headway from trips per hour */
export function headway(tripsPerHour: number): string {
  if (!(tripsPerHour > 0.05)) return 'no service';
  const h = 60 / tripsPerHour;
  return `every ${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} min`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** "GEARY RAPID" → "Geary Rapid" (GTFS names are often upper case) */
export function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/(])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/\b(Bart|Ucsf|Sf|Ssf|Va|Sfsu)\b/g, (w) => w.toUpperCase());
}
