/**
 * Station-to-station rider flows on BART and Caltrain by period, from the operators' own data, for
 * the riders the demand model does not carry (trips with no end in San Francisco; see background.ts)
 * and for validating the ones it does.
 *
 * BART: the August 2026 average-weekday station-to-station matrix (reference/bart-ridership.json),
 * split into the model's periods pair by pair with the hours of BART's 2025 hourly origin–destination
 * file (weekdays, Saturdays, and Sundays of September–November 2025, by tap-in hour). Weekend
 * matrices are the 2025 averages for those days, scaled to BART's August 2026 Saturday and Sunday
 * totals.
 *
 * Caltrain: Caltrain counts boardings by station but has no fare gates, so no station-to-station
 * counts exist. The 2024 Caltrain/MTC origin–destination survey's on-to-off study (5,521 riders,
 * weekdays in May 2024, weighted to 22,028 riders) published its boarding-to-alighting matrix by nine
 * groups of stations (report Table 3). Here it is spread to stations in proportion to each station's
 * FY2026 boardings and fitted (iterative proportional fitting) to FY2026 weekday boardings at every
 * station, with each station's alightings taken equal to its boardings (most riders make a round trip
 * on Caltrain: 85% in the 2025 triennial survey). Periods: the survey's riders by direction and time
 * of day (January 2023 counts, report Table 1), rescaled to the peak/off-peak split of Caltrain's fall
 * 2025 station count (2025 triennial survey); within a direction, each journey takes the hours at
 * which riders board at its first station (2025 customer survey respondents; caltrain_css.py). Weekends: weekday pattern scaled to the FY2026 average
 * weekend day, with the weekend periods of the survey's sampling table (Table 10).
 *
 * Writes server/beta3/reference/regional-od.json.
 * Run: npx tsx server/beta3/pipeline/regional-od.ts
 */
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { RAW, REFERENCE } from './paths';

const P = ['AM', 'MD', 'PM', 'NT'] as const;
type Per = (typeof P)[number];
const periodOfHour = (h: number): Per => (h >= 6 && h < 10 ? 'AM' : h >= 10 && h < 15 ? 'MD' : h >= 15 && h < 19 ? 'PM' : 'NT');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---------- BART ----------
async function bart() {
  const ref = read(`${REFERENCE}/bart-ridership.json`);
  const codes: string[] = ref.od.codes;
  const M: number[][] = ref.od.matrix;
  const n = codes.length;
  const ix = new Map(codes.map((c, i) => [c, i]));
  // 2025 hourly file: Sep 2 – Nov 26, 2025 (Labor Day is Sep 1; Veterans Day, Nov 11, is left out)
  const HOLIDAYS = new Set(['2025-11-11']);
  type Day = 'wkd' | 'sat' | 'sun';
  const acc: Record<Day, Float64Array> = { wkd: new Float64Array(n * n * 4), sat: new Float64Array(n * n * 4), sun: new Float64Array(n * n * 4) };
  const days: Record<Day, Set<string>> = { wkd: new Set(), sat: new Set(), sun: new Set() };
  const rl = readline.createInterface({ input: fs.createReadStream(`${RAW}/obs/bart_date-hour-soo-dest-2025.csv.gz`).pipe(zlib.createGunzip()) });
  for await (const line of rl) {
    const [date, hour, o, d, trips] = line.split(',');
    if (date < '2025-09-02' || date > '2025-11-26' || HOLIDAYS.has(date)) continue;
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const day: Day = dow === 0 ? 'sun' : dow === 6 ? 'sat' : 'wkd';
    const i = ix.get(o), j = ix.get(d);
    if (i === undefined || j === undefined) continue;
    days[day].add(date);
    acc[day][(i * n + j) * 4 + P.indexOf(periodOfHour(Number(hour)))] += Number(trips);
  }
  const nd = { wkd: days.wkd.size, sat: days.sat.size, sun: days.sun.size };
  // systemwide period shares, for pairs with no 2025 trips
  const sysShare = (day: Day) => {
    const s = [0, 0, 0, 0];
    for (let k = 0; k < n * n; k++) for (let p = 0; p < 4; p++) s[p] += acc[day][k * 4 + p];
    const t = s.reduce((a, v) => a + v, 0);
    return s.map((v) => v / t);
  };
  const out: Record<string, Record<Per, number[][]>> = {};
  {
    const sh = sysShare('wkd');
    const m = Object.fromEntries(P.map((p) => [p, codes.map(() => new Array(n).fill(0))])) as Record<Per, number[][]>;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const daily = M[i]?.[j] ?? 0;
        if (!daily || i === j) continue;
        const a = acc.wkd.subarray((i * n + j) * 4, (i * n + j) * 4 + 4);
        const t = a[0] + a[1] + a[2] + a[3];
        P.forEach((p, k) => (m[p][i][j] = +(daily * (t > 0 ? a[k] / t : sh[k])).toFixed(2)));
      }
    out.wkd = m;
  }
  const totals2025: Record<string, number> = {};
  for (const day of ['sat', 'sun'] as Day[]) {
    let t25 = 0;
    for (let k = 0; k < acc[day].length; k++) t25 += acc[day][k];
    t25 /= nd[day];
    totals2025[day] = Math.round(t25);
    const target = day === 'sat' ? ref.systemAvgSaturdayTrips : ref.systemAvgSundayTrips;
    const f = target / t25;
    out[day] = Object.fromEntries(P.map((p, k) => [p, codes.map((_, i) => codes.map((_, j) => (i === j ? 0 : +((acc[day][(i * n + j) * 4 + k] / nd[day]) * f).toFixed(2))))])) as Record<Per, number[][]>;
  }
  return {
    source: 'BART August 2026 average-weekday station-to-station matrix (bart-ridership.json), split into periods pair by pair with BART\'s 2025 hourly origin–destination file (date-hour-soo-dest-2025.csv.gz, by tap-in hour); weekends: the 2025 Saturday and Sunday averages scaled to BART\'s August 2026 Saturday and Sunday totals',
    url: 'https://afcweb.bart.gov/ridership/origin-destination/date-hour-soo-dest-2025.csv.gz',
    hoursFrom: `2025-09-02 to 2025-11-26 (${nd.wkd} weekdays, ${nd.sat} Saturdays, ${nd.sun} Sundays; Veterans Day left out)`,
    periods: { AM: '06:00–09:59', MD: '10:00–14:59', PM: '15:00–18:59', NT: '19:00–05:59' },
    weekendTotals2025: totals2025,
    codes,
    od: out,
  };
}

// ---------- Caltrain ----------
/** stations north to south with the survey's nine groups (2024 Caltrain OD survey, Table 3) */
const CT_STATIONS: [string, number][] = [
  ['San Francisco', 1], ['22nd Street', 2], ['Bayshore', 2], ['South San Francisco', 2], ['San Bruno', 2],
  ['Millbrae', 3], ['Burlingame', 3], ['San Mateo', 3], ['Hayward Park', 3],
  ['Hillsdale', 4], ['Belmont', 4], ['San Carlos', 4], ['Redwood City', 4],
  ['Menlo Park', 5], ['Palo Alto', 5], ['California Ave', 5],
  ['San Antonio', 6], ['Mountain View', 6], ['Sunnyvale', 6],
  ['Lawrence', 7], ['Santa Clara', 7], ['College Park', 7], ['San Jose Diridon', 7], ['Tamien', 7],
  ['Capitol', 8], ['Blossom Hill', 8],
  ['Morgan Hill', 9], ['San Martin', 9], ['Gilroy', 9],
];
/** weighted weekday boarding-group → alighting-group riders, May 2024 (Table 3; total 22,028) */
const CT_GROUPS = [
  [0, 181, 676, 1190, 989, 1180, 720, 0, 21],
  [237, 184, 325, 358, 425, 311, 186, 0, 0],
  [528, 235, 340, 422, 421, 254, 255, 0, 0],
  [978, 279, 584, 260, 436, 305, 334, 0, 11],
  [851, 306, 453, 462, 102, 535, 607, 5, 16],
  [1022, 263, 315, 344, 537, 184, 266, 0, 0],
  [686, 241, 298, 433, 739, 272, 189, 0, 5],
  [8, 0, 0, 0, 12, 4, 0, 0, 5],
  [8, 0, 31, 27, 74, 8, 72, 19, 4],
];
const CT_GROUP_NAMES = ['San Francisco', '22nd Street to San Bruno', 'Millbrae to Hayward Park', 'Hillsdale to Redwood City', 'Menlo Park to California Ave', 'San Antonio to Sunnyvale', 'Lawrence to Tamien', 'Capitol and Blossom Hill', 'Morgan Hill to Gilroy'];
/** weekday riders by direction and time of day, January 2023 counts (survey report Table 1, summed over service types) */
const CT_TOD = {
  NB: { early: 93 + 611 + 201, amPeak: 534 + 1426 + 733, midday: 871 + 753, pmPeak: 414 + 1559 + 598, evening: 135 + 341 },
  SB: { early: 30 + 92, amPeak: 627 + 1015 + 597, midday: 714 + 883, pmPeak: 806 + 1796 + 825, evening: 239 + 598 },
};
/** fall 2025 station count, average weekly riders by stratum (2025 triennial survey, p. 7): peak = start of service to 9am and 3–7pm */
const CT_FALL2025 = { amPeak: 59370, pmPeak: 77185, offPeak: 61350, saturday: 22883, sunday: 16846 };

function caltrain() {
  const cr = read(`${REFERENCE}/caltrain-ridership.json`);
  const amwr = new Map<string, number>((cr.stations as { name: string; amwrFY2026: number }[]).map((s) => [s.name, s.amwrFY2026]));
  const names = CT_STATIONS.map((s) => s[0]);
  const grp = CT_STATIONS.map((s) => s[1] - 1);
  const n = names.length;
  const sumAmwr = names.reduce((a, s) => a + (amwr.get(s) ?? 0), 0);
  const all = (cr.stations as { amwrFY2026: number }[]).reduce((a, s) => a + s.amwrFY2026, 0);
  // all-weekday boardings: mid-week counts × Caltrain's ratio of its average weekday to the mid-week sum
  const wk = cr.systemwide.avgWeekdayRidershipFY2026 / all;
  const W = names.map((s) => (amwr.get(s) ?? 0) * wk);
  const gW = new Array(9).fill(0);
  W.forEach((w, i) => (gW[grp[i]] += w));
  // seed: each group pair's riders spread over its station pairs by both stations' boardings
  const T: number[][] = names.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const gi = grp[i], gj = grp[j];
      let den = gW[gi] * gW[gj];
      if (gi === gj) den -= W.reduce((a, w, k) => a + (grp[k] === gi ? w * w : 0), 0);
      T[i][j] = den > 0 ? (CT_GROUPS[gi][gj] * W[i] * W[j]) / den : 0;
    }
  // fit rows (boardings) and columns (alightings = boardings) to FY2026
  for (let it = 0; it < 100; it++) {
    for (let i = 0; i < n; i++) {
      const s = T[i].reduce((a, v) => a + v, 0);
      if (s > 0) for (let j = 0; j < n; j++) T[i][j] *= W[i] / s;
    }
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += T[i][j];
      if (s > 0) for (let i = 0; i < n; i++) T[i][j] *= W[j] / s;
    }
  }
  // periods by direction: Table 1's riders mapped to the model's periods (the survey's early AM is
  // trains leaving before 6am, whose riders mostly board after 6: half to AM, half to the night; 9–10am
  // is a fifth of the survey's 9am–3pm midday), then rescaled so the AM-peak, PM-peak and off-peak
  // totals match the fall 2025 count
  const f25 = CT_FALL2025, t25 = f25.amPeak + f25.pmPeak + f25.offPeak;
  const t23 = (k: 'early' | 'amPeak' | 'midday' | 'pmPeak' | 'evening') => CT_TOD.NB[k] + CT_TOD.SB[k];
  const kAM = f25.amPeak / t25 / ((t23('early') + t23('amPeak')) / (t23('early') + t23('amPeak') + t23('midday') + t23('pmPeak') + t23('evening')));
  const kPM = f25.pmPeak / t25 / (t23('pmPeak') / (t23('early') + t23('amPeak') + t23('midday') + t23('pmPeak') + t23('evening')));
  const kOff = f25.offPeak / t25 / ((t23('midday') + t23('evening')) / (t23('early') + t23('amPeak') + t23('midday') + t23('pmPeak') + t23('evening')));
  const shares = Object.fromEntries(
    (['NB', 'SB'] as const).map((dir) => {
      const x = CT_TOD[dir];
      const early = x.early * kAM, am = x.amPeak * kAM, md = x.midday * kOff, pm = x.pmPeak * kPM, ev = x.evening * kOff;
      const v: Record<Per, number> = { AM: am + 0.5 * early + 0.2 * md, MD: 0.8 * md, PM: pm, NT: 0.5 * early + ev };
      const t = v.AM + v.MD + v.PM + v.NT;
      return [dir, Object.fromEntries(P.map((p) => [p, +(v[p] / t).toFixed(4)]))];
    }),
  ) as Record<'NB' | 'SB', Record<Per, number>>;
  const byPeriod = (scale: number, sh: Record<'NB' | 'SB', Record<Per, number>>) =>
    Object.fromEntries(P.map((p) => [p, T.map((row, i) => row.map((v, j) => +(v * scale * sh[i < j ? 'SB' : 'NB'][p]).toFixed(2)))])) as Record<Per, number[][]>;
  // weekdays: when each station's riders board in each direction (2025 customer survey respondents by
  // train; caltrain_css.py), shrunk toward the direction's shares (10 respondents' weight), then each
  // direction raked to its period totals above; a journey keeps the timing of its boarding station
  const bt = read(`${REFERENCE}/caltrain-boarding-times.json`).counts as Record<string, Partial<Record<Per, number>>>;
  const K = 10;
  const weekday = () => {
    const X = Object.fromEntries(P.map((p) => [p, T.map((row) => row.map(() => 0))])) as Record<Per, number[][]>;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === j || !T[i][j]) continue;
        const dir = i < j ? 'SB' : 'NB';
        const c = bt[`${names[i]}|${dir}`] ?? {};
        const m = P.reduce((a, p) => a + (c[p] ?? 0), 0);
        P.forEach((p) => (X[p][i][j] = (T[i][j] * ((c[p] ?? 0) + K * shares[dir][p])) / (m + K)));
      }
    for (let it = 0; it < 50; it++) {
      for (const dir of ['NB', 'SB'] as const) {
        const inDir = (i: number, j: number) => i !== j && (dir === 'SB') === i < j;
        let tot = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (inDir(i, j)) tot += T[i][j];
        for (const p of P) {
          let s = 0;
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (inDir(i, j)) s += X[p][i][j];
          const f = s > 0 ? (tot * shares[dir][p]) / s : 1;
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (inDir(i, j)) X[p][i][j] *= f;
        }
      }
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const s = P.reduce((a, p) => a + X[p][i][j], 0);
          if (s > 0) for (const p of P) X[p][i][j] *= T[i][j] / s;
        }
    }
    return Object.fromEntries(P.map((p) => [p, X[p].map((r) => r.map((v) => +v.toFixed(2)))])) as Record<Per, number[][]>;
  };
  // weekends: an average weekend day of FY2026 (Saturday and Sunday from the fall 2025 count's ratio);
  // the weekday pattern of station pairs, periods from the survey's weekend sampling table (Table 10)
  const wkdTotal = cr.systemwide.avgWeekdayRidershipFY2026;
  const weekendDay = cr.systemwide.avgWeekendRidershipFY2026;
  const satF = (2 * weekendDay * (f25.saturday / (f25.saturday + f25.sunday))) / wkdTotal;
  const sunF = (2 * weekendDay * (f25.sunday / (f25.saturday + f25.sunday))) / wkdTotal;
  // Table 10 (an average weekend day, January 2023): AM peak 6–9am, midday 9am–3pm, PM peak 3–7pm, evening
  const WE = { NB: { am: 220, md: 1923, pm: 837, ev: 420 }, SB: { am: 193, md: 1474, pm: 1164, ev: 565 } };
  const weShares = Object.fromEntries(
    (['NB', 'SB'] as const).map((dir) => {
      const x = WE[dir];
      const v: Record<Per, number> = { AM: x.am + 0.2 * x.md, MD: 0.8 * x.md, PM: x.pm, NT: x.ev };
      const t = v.AM + v.MD + v.PM + v.NT;
      return [dir, Object.fromEntries(P.map((p) => [p, +(v[p] / t).toFixed(4)]))];
    }),
  ) as Record<'NB' | 'SB', Record<Per, number>>;
  const groups = CT_GROUP_NAMES.map((name, g) => ({ name, stations: names.filter((_, i) => grp[i] === g) }));
  return {
    source: '2024 Caltrain Origin and Destination Survey (Caltrain and MTC; RSG, 2025), on-to-off study, Table 3 (weighted weekday boarding-to-alighting riders by station group, May 2024) and Table 1 (riders by direction and time of day, January 2023); Caltrain FY2026 station boardings (caltrain-ridership.json); 2025 Caltrain Triennial Customer Survey (fall 2025 station count by stratum); 2025 Caltrain Customer Satisfaction Survey respondent file (boarding times by station; caltrain-boarding-times.json)',
    url: 'https://www.caltrain.com/media/34860/download',
    otherUrls: { triennial2025: 'https://www.caltrain.com/media/37005/download', surveysIndex: 'https://www.caltrain.com/about-caltrain/statistics-reports/surveys' },
    rawFiles: ['data/beta3/raw/caltrain/caltrain_OD_survey_2024.pdf', 'data/beta3/raw/caltrain/caltrain_triennial_2025.pdf'],
    method: 'Group matrix spread to stations by FY2026 boardings, then fitted to FY2026 all-weekday boardings by station (rows) and the same as alightings (columns); periods: each journey by the boarding times at its first station in the 2025 customer survey (caltrain-boarding-times.json), raked to the riders by direction and period of Table 1 rescaled to the fall 2025 peak split. An estimate: Caltrain has no station-to-station counts.',
    surveyGroups: { names: CT_GROUP_NAMES, matrix: CT_GROUPS, total: 22028, period: 'Weekdays, May 2–14, 2024' },
    groups,
    weekdayFactor: +wk.toFixed(4),
    periodSharesByDirection: shares,
    weekendFactors: { sat: +satF.toFixed(4), sun: +sunF.toFixed(4) },
    stations: names,
    boardings: W.map((w) => Math.round(w)),
    stationsAmwrSum: sumAmwr,
    weekendPeriodShares: weShares,
    od: { wkd: weekday(), sat: byPeriod(satF, weShares), sun: byPeriod(sunF, weShares) },
  };
}

async function main() {
  const out = { generated: new Date().toISOString().slice(0, 10), bart: await bart(), caltrain: caltrain() };
  fs.writeFileSync(`${REFERENCE}/regional-od.json`, JSON.stringify(out));
  const c = out.caltrain;
  const tot = (m: number[][]) => m.reduce((a, r) => a + r.reduce((x, v) => x + v, 0), 0);
  console.log('Caltrain weekday by period', P.map((p) => `${p} ${Math.round(tot(c.od.wkd[p]))}`).join(', '), 'shares', JSON.stringify(c.periodSharesByDirection));
  const b = out.bart;
  console.log('BART weekday by period', P.map((p) => `${p} ${Math.round(tot(b.od.wkd[p]))}`).join(', '), '| sat', Math.round(P.reduce((a, p) => a + tot(b.od.sat[p]), 0)), 'sun', Math.round(P.reduce((a, p) => a + tot(b.od.sun[p]), 0)), b.hoursFrom);
}
main();
