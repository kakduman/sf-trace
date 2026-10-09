/**
 * The synthetic population's seed: San Francisco's households and persons from the ACS 2020–24
 * five-year PUMS (California files), the city's eight 2020 PUMAs (07507–07514), with only the
 * columns the synthesis uses. Reads about 1.7 GB of CSV once; writes two small CSVs to the work
 * folder (pums-sf-h.csv, pums-sf-p.csv) that synpop.ts reads.
 *
 * Inputs (data/beta3/raw): commute-county/csv_hca_2024_5yr.zip (housing) and
 * commute-county/csv_pca_2024_5yr.zip (persons), from
 * https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/.
 *
 * Also takes San Francisco's block groups' group-quarters population by type (2020 census
 * redistricting file, table P5: synpop/ca2020.pl.zip) and writes gq2020-bg.json.
 *
 * Run: npx tsx server/beta3/pipeline/synpop-seed.ts
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { RAW, WORK } from './paths';

export const SF_PUMAS = ['07507', '07508', '07509', '07510', '07511', '07512', '07513', '07514'];

const H_COLS = ['SERIALNO', 'PUMA', 'ADJINC', 'WGTP', 'NP', 'TYPEHUGQ', 'VEH', 'HINCP', 'TEN', 'BLD', 'HHT'];
const P_COLS = ['SERIALNO', 'SPORDER', 'PUMA', 'PWGTP', 'AGEP', 'SEX', 'ESR', 'WKHP', 'WKWN', 'SCH', 'SCHG', 'JWTRNS', 'RELSHIPP', 'PINCP', 'ADJINC', 'POWSP', 'POWPUMA'];

async function extract(zip: string, member: string, cols: string[], out: string) {
  const child = spawn('unzip', ['-p', zip, member]);
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ws = fs.createWriteStream(out);
  let idx: number[] = [];
  let puma = -1, n = 0;
  const pumas = new Set(SF_PUMAS);
  for await (const line of rl) {
    if (!idx.length) {
      const head = line.split(',');
      idx = cols.map((c) => {
        const k = head.indexOf(c);
        if (k < 0) throw new Error(`${member}: no column ${c}`);
        return k;
      });
      puma = head.indexOf('PUMA');
      ws.write(cols.join(',') + '\n');
      continue;
    }
    // PUMA is the 4th or 5th field; split only rows that might match
    const c = line.split(',', puma + 1);
    if (!pumas.has(c[puma])) continue; // the California file: PUMA codes are unique within the state
    const all = line.split(',');
    ws.write(idx.map((k) => all[k]).join(',') + '\n');
    n++;
  }
  await new Promise((r) => ws.end(r));
  console.log(`${member}: ${n} San Francisco records → ${out}`);
}

/** 2020 census group-quarters population by major type (P5) for San Francisco's block groups */
async function groupQuarters(zip: string, out: string) {
  const lines = (member: string) => readline.createInterface({ input: spawn('unzip', ['-p', zip, member]).stdout, crlfDelay: Infinity });
  const geoOf = new Map<string, string>();
  for await (const l of lines('cageo2020.pl')) {
    const c = l.split('|');
    if (c[2] === '150' && c[14] === '075') geoOf.set(c[7], c[9]);
  }
  const keys = ['total', 'institutional', 'correctional', 'juvenile', 'nursing', 'otherInstitutional', 'noninstitutional', 'college', 'military', 'otherNoninstitutional'];
  const rows: Record<string, Record<string, number>> = {};
  for await (const l of lines('ca000032020.pl')) {
    const c = l.split('|');
    const g = geoOf.get(c[4]);
    if (g) rows[g] = Object.fromEntries(keys.map((k, i) => [k, Number(c[5 + i])]));
  }
  fs.writeFileSync(out, JSON.stringify({ source: '2020 Census Redistricting Data (P.L. 94-171), table P5, block groups (summary level 150), San Francisco County', blockGroups: rows }));
  console.log(`group quarters: ${Object.keys(rows).length} block groups, ${Object.values(rows).reduce((a, r) => a + r.total, 0)} people → ${out}`);
}

async function main() {
  console.time('synpop-seed');
  const dir = `${RAW}/commute-county`;
  fs.mkdirSync(WORK, { recursive: true });
  await extract(`${dir}/csv_hca_2024_5yr.zip`, 'psam_h06.csv', H_COLS, `${WORK}/pums-sf-h.csv`);
  await extract(`${dir}/csv_pca_2024_5yr.zip`, 'psam_p06.csv', P_COLS, `${WORK}/pums-sf-p.csv`);
  await groupQuarters(`${RAW}/synpop/ca2020.pl.zip`, `${WORK}/gq2020-bg.json`);
  console.timeEnd('synpop-seed');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
