/**
 * Limited-English households by zone: ACS 2020–24 table C16002 (household language by household
 * limited English speaking status), block groups of San Francisco, from the Census Bureau's
 * table-based summary file (raw/language/acs_c16002.dat). A household is limited-English when no one
 * 14 or over speaks only English or speaks English "very well" (C16002_004, 007, 010, 013).
 */
import fs from 'node:fs';
import type { Bundle } from '../../../shared/beta3/types';
import { RAW } from './paths';

export const LEP_COLUMNS = ['C16002_E004', 'C16002_E007', 'C16002_E010', 'C16002_E013'];

/** block group GEOID → [limited-English households, all households] */
export function readC16002(text: string): Map<string, [number, number]> {
  const rows = text.trim().split('\n');
  const h = rows[0].split('|');
  const col = (n: string) => h.indexOf(n);
  const out = new Map<string, [number, number]>();
  for (const r of rows.slice(1)) {
    const f = r.split('|');
    if (!f[0].startsWith('1500000US')) continue;
    out.set(f[0].slice(9), [LEP_COLUMNS.reduce((a, k) => a + Number(f[col(k)]), 0), Number(f[col('C16002_E001')])]);
  }
  return out;
}

/** each zone's share of households that are limited-English (0 where the ACS has no households) */
export function lepShares(b: Bundle, file = `${RAW}/language/acs_c16002.dat`): Float32Array {
  const m = readC16002(fs.readFileSync(file, 'utf8'));
  return Float32Array.from(b.header.zones, (z) => {
    const x = m.get(z.id);
    return x && x[1] > 0 ? x[0] / x[1] : 0;
  });
}
