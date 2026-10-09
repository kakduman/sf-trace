/**
 * Observed traffic on the Peninsula freeways (server/beta3/reference/peninsula-traffic.json), for
 * the corridors of the road assignment (peninsula.ts, roads-base.ts):
 *
 *  - Caltrans 2023 AADT on US-101 and I-280 in San Mateo and Santa Clara counties (Traffic Volumes
 *    AADT feature service, raw/peninsula/caltrans_aadt_2023_101_280.json): both directions.
 *  - The weekday time of day: FHWA's Travel Monitoring Analysis System hourly volumes for April
 *    2024 at the one continuous count station on these freeways it publishes, I-280 a mile south of
 *    Cañada Road (station 049040; raw/peninsula/tmas-ca), Tuesdays to Thursdays, both directions.
 *  - Direction in the peaks: VTA's 2024 freeway gateway counts at the San Mateo County line, US-101
 *    and I-280 together (2024 CMP Monitoring & Conformance Report, Tables 4.12 and 4.13; 6:30–9:30
 *    a.m. and 4–7 p.m.).
 *  - Peak speeds: C/CAG's 2025 CMP Monitoring Report, Table 25, INRIX average speeds by segment and
 *    direction, 7–9 a.m. and 4–6 p.m., Tuesdays to Thursdays in April and May 2025. (The report
 *    labels I-280's directions EB and WB; its own Table 13 and the peaks show EB is northbound.)
 *
 * Run: npx tsx server/beta3/pipeline/peninsula-data.ts
 */
import fs from 'node:fs';
import { RAW, REFERENCE } from './paths';
import type { TPeriod } from '../../../shared/beta3/types';
import { corridorCarriageways, corridorSegments, PEN_CUTS } from './peninsula';

const PEN_RAW = `${RAW}/peninsula`;
/** the model's periods by clock hour (as roads-base.ts compares INRIX's hours) */
const HOURS: Record<TPeriod, number[]> = { AM: [6, 7, 8, 9], MD: [10, 11, 12, 13, 14], PM: [15, 16, 17, 18], NT: [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5] };

/** C/CAG 2025 CMP Monitoring Report, Table 25 (2025 columns): mph, AM and PM peak periods */
const CCAG_TABLE_25: { route: 'US-101' | 'I-280'; from: string; to: string; ffs: number; N: [number, number]; S: [number, number] }[] = [
  { route: 'US-101', from: 'the county line', to: 'I-380', ffs: 65, N: [40, 37], S: [53, 50] },
  { route: 'US-101', from: 'I-380', to: 'Millbrae Ave', ffs: 65, N: [64, 54], S: [60, 46] },
  { route: 'US-101', from: 'Millbrae Ave', to: 'Broadway', ffs: 65, N: [60, 61], S: [55, 31] },
  { route: 'US-101', from: 'Broadway', to: 'Peninsula Ave', ffs: 65, N: [49, 55], S: [44, 22] },
  { route: 'US-101', from: 'Peninsula Ave', to: 'SR-92', ffs: 65, N: [37, 58], S: [51, 34] },
  { route: 'US-101', from: 'SR-92', to: 'Whipple Ave', ffs: 65, N: [61, 21], S: [49, 62] },
  { route: 'US-101', from: 'Whipple Ave', to: 'the Santa Clara County line', ffs: 65, N: [56, 53], S: [33, 44] },
  // "SF County Line to SR-1 (North)" (EB 60/59, WB 67/66) is a few hundred metres; the model's first
  // segment runs on to SR-1 (south), so it takes "SR-1 (North) to SR-1 (South)"
  { route: 'I-280', from: 'the county line', to: 'SR-1 (south)', ffs: 65, N: [65, 53], S: [57, 64] },
  { route: 'I-280', from: 'SR-1 (south)', to: 'San Bruno Ave', ffs: 65, N: [65, 36], S: [30, 65] },
  { route: 'I-280', from: 'San Bruno Ave', to: 'SR-92', ffs: 65, N: [69, 64], S: [68, 68] },
  { route: 'I-280', from: 'SR-92', to: 'SR-84', ffs: 65, N: [69, 59], S: [56, 68] },
  { route: 'I-280', from: 'SR-84', to: 'the Santa Clara County line', ffs: 65, N: [68, 27], S: [63, 65] },
];
/** VTA 2024 CMP Monitoring & Conformance Report, Tables 4.12–4.13: the Peninsula gateway (US-101 and I-280), vehicles in three hours */
const VTA_GATEWAY_2024 = { AM: { intoSantaClara: 37519, outOf: 31613 }, PM: { intoSantaClara: 30835, outOf: 38069 } };

function main() {
  // ---------- Caltrans AADT ----------
  const cal = JSON.parse(fs.readFileSync(`${PEN_RAW}/caltrans_aadt_2023_101_280.json`, 'utf8')) as { features: { attributes: Record<string, string | null>; geometry: { x: number; y: number } }[] };
  const seen = new Set<string>();
  const aadt: { route: string; county: string; pm: string; desc: string; lat: number; lon: number; back: number; ahead: number; peakHour: number }[] = [];
  for (const f of cal.features) {
    const a = f.attributes;
    if (!['101', '280'].includes(String(a.RTE)) || !['SM', 'SCL'].includes(String(a.CNTY))) continue;
    const k = `${a.RTE}|${a.CNTY}|${a.PM_PFX ?? ''}${a.PM}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const back = Number(a.BACK_AADT) || 0,
      ahead = Number(a.AHEAD_AADT) || 0;
    const ph = [Number(a.BACK_PEAK_HOUR) || 0, Number(a.AHEAD_PEAK_HOUR) || 0].filter((v) => v > 0);
    aadt.push({ route: a.RTE === '101' ? 'US-101' : 'I-280', county: String(a.CNTY), pm: `${a.PM_PFX ?? ''}${a.PM}`.trim(), desc: String(a.DESCRIPTION), lat: +f.geometry.y.toFixed(5), lon: +f.geometry.x.toFixed(5), back, ahead, peakHour: ph.length ? Math.round(ph.reduce((s, v) => s + v, 0) / ph.length) : 0 });
  }
  console.log(`Caltrans AADT points: ${aadt.length} (US-101 ${aadt.filter((x) => x.route === 'US-101').length}, I-280 ${aadt.filter((x) => x.route === 'I-280').length})`);

  // ---------- FHWA TMAS: I-280 station 049040, April 2024, Tue–Thu ----------
  const lines = fs.readFileSync(`${PEN_RAW}/tmas-ca/CA_APR_2024_049040.VOL`, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('|');
  const col = (n: string) => head.indexOf(n);
  const hourly: Record<string, number[]> = { N: new Array(24).fill(0), S: new Array(24).fill(0) };
  const days = new Set<string>();
  for (const l of lines.slice(1)) {
    const c = l.split('|');
    if (c[col('station_id')] !== '049040') continue;
    // day_of_week: 1 Sunday … 7 Saturday
    if (!['3', '4', '5'].includes(c[col('day_of_week')])) continue;
    const d = c[col('travel_dir')] === '1' ? 'N' : c[col('travel_dir')] === '5' ? 'S' : '';
    if (!d) continue;
    days.add(c[col('day_record')]);
    for (let h = 0; h < 24; h++) hourly[d][h] += Number(c[col(`hour_${String(h).padStart(2, '0')}`)]) || 0;
  }
  const tot = (d: string) => hourly[d].reduce((a, v) => a + v, 0);
  const both = hourly.N.map((v, h) => v + hourly.S[h]);
  const all = tot('N') + tot('S');
  const periodShare = Object.fromEntries((Object.keys(HOURS) as TPeriod[]).map((p) => [p, +(HOURS[p].reduce((a, h) => a + both[h], 0) / all).toFixed(4)])) as Record<TPeriod, number>;
  const stationSouth = Object.fromEntries((Object.keys(HOURS) as TPeriod[]).map((p) => {
    const s = HOURS[p].reduce((a, h) => a + hourly.S[h], 0),
      n = HOURS[p].reduce((a, h) => a + hourly.N[h], 0);
    return [p, +(s / (s + n)).toFixed(4)];
  }));
  console.log(`TMAS 049040: ${days.size} weekdays, ${Math.round(all / days.size).toLocaleString()} vehicles a day; period shares ${JSON.stringify(periodShare)}; southbound share at the station ${JSON.stringify(stationSouth)}`);

  // ---------- direction: VTA's Peninsula gateway counts for the peaks; even at midday; the night balances the day ----------
  const southShare = {
    AM: +(VTA_GATEWAY_2024.AM.intoSantaClara / (VTA_GATEWAY_2024.AM.intoSantaClara + VTA_GATEWAY_2024.AM.outOf)).toFixed(4),
    MD: 0.5,
    PM: +(VTA_GATEWAY_2024.PM.intoSantaClara / (VTA_GATEWAY_2024.PM.intoSantaClara + VTA_GATEWAY_2024.PM.outOf)).toFixed(4),
    NT: 0,
  } as Record<TPeriod, number>;
  // each direction carries half the day's traffic
  southShare.NT = +((0.5 - (periodShare.AM * southShare.AM + periodShare.MD * southShare.MD + periodShare.PM * southShare.PM)) / periodShare.NT).toFixed(4);
  console.log(`southbound share by period: ${JSON.stringify(southShare)}`);

  // ---------- the freeways' peak speeds in San Mateo County, each direction: INRIX's segment speeds
  // over C/CAG's segments, weighted by their length along the carriageway (harmonic mean: total
  // length over total time). The fixed skims' regional legs through US-101's and I-280's gateways
  // drive at these (skims.ts), and at C/CAG's free-flow speed off the peaks.
  const osm = JSON.parse(fs.readFileSync(`${RAW}/roads/osm-regional.json`, 'utf8')) as { elements: never[] };
  const { cw, pos } = corridorCarriageways(osm.elements);
  const segs = corridorSegments(cw, pos);
  const corridorMph: Record<string, Record<'N' | 'S', Record<'AM' | 'PM', number>>> = {};
  const corridorMiles: Record<string, Record<'N' | 'S', number>> = {};
  for (const route of ['US-101', 'I-280'] as const) {
    corridorMph[route] = { N: { AM: 0, PM: 0 }, S: { AM: 0, PM: 0 } };
    const cuts = PEN_CUTS[route].map((c) => c.name);
    for (const dir of ['N', 'S'] as const)
      for (const p of ['AM', 'PM'] as const) {
        let mi = 0,
          h = 0;
        for (const r of CCAG_TABLE_25.filter((x) => x.route === route)) {
          const a = cuts.indexOf(r.from),
            b = cuts.indexOf(r.to);
          const m = segs.filter((g) => g.route === route && g.dir === dir && Math.min(g.from, g.to) >= a && Math.max(g.from, g.to) <= b).reduce((t, g) => t + g.metres / 1609.34, 0);
          mi += m;
          h += m / r[dir][p === 'AM' ? 0 : 1];
        }
        corridorMph[route][dir][p] = +(mi / h).toFixed(2);
        corridorMiles[route] = { ...corridorMiles[route], [dir]: +mi.toFixed(2) } as Record<'N' | 'S', number>;
      }
  }
  console.log(`San Mateo County freeway peak speeds, length-weighted: ${JSON.stringify(corridorMph)}`);

  const cmp = CCAG_TABLE_25.flatMap((r) => (['N', 'S'] as const).map((dir) => ({ route: r.route, from: dir === 'S' ? r.from : r.to, to: dir === 'S' ? r.to : r.from, north: r.from, south: r.to, dir, ffs: r.ffs, AM: r[dir][0], PM: r[dir][1] })));
  const out = {
    note: 'Observed traffic on US-101 and I-280 from the San Francisco county line to San Jose, for the Peninsula corridors of the road assignment (server/beta3/pipeline/peninsula-data.ts).',
    sources: {
      aadt: 'Caltrans, Traffic Volumes: Annual Average Daily Traffic (AADT), 2023, GIS feature service CHhighway/Traffic_AADT; routes 101 and 280, San Mateo and Santa Clara counties.',
      timeOfDay: 'FHWA Travel Monitoring Analysis System (TMAS) volume data, April 2024, California station 049040 (I-280, 1 mile south of Cañada Road, San Mateo County), Tuesdays to Thursdays, hourly by direction. https://www.fhwa.dot.gov/policyinformation/tables/tmasdata/',
      direction: 'Santa Clara Valley Transportation Authority, 2024 CMP Monitoring & Conformance Report (June 2025), Tables 4.12 and 4.13: freeway gateway counts, Peninsula gateway (US-101 and I-280), 6:30–9:30 a.m. and 4–7 p.m.',
      speeds: 'C/CAG, 2025 San Mateo County Congestion Management Program Monitoring Report (October 2025), Table 25: INRIX average speeds by freeway segment and direction, 7–9 a.m. and 4–6 p.m., Tuesdays to Thursdays, April–May 2025.',
    },
    hours: HOURS,
    periodShare,
    southShare,
    station: { id: '049040', days: days.size, dailyBothWays: Math.round(all / days.size), southShare: stationSouth, hourlyShare: { N: hourly.N.map((v) => +(v / tot('N')).toFixed(4)), S: hourly.S.map((v) => +(v / tot('S')).toFixed(4)) } },
    vtaGateway2024: VTA_GATEWAY_2024,
    cmpSpeeds: cmp,
    /** INRIX's peak speeds over C/CAG's San Mateo segments by route and direction (mph, length-weighted harmonic mean), and C/CAG's free-flow speed */
    corridorMph,
    /** the miles those speeds cover (C/CAG's segments, along the carriageway) */
    corridorMiles,
    freeFlowMph: 65,
    aadt,
  };
  fs.writeFileSync(`${REFERENCE}/peninsula-traffic.json`, JSON.stringify(out, null, 1));
  console.log(`wrote ${REFERENCE}/peninsula-traffic.json`);
}

main();
