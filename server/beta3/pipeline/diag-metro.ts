/**
 * Diagnostic: how long the model's Muni Metro rides are, and where they begin and end.
 *  1. Metro rides by boarding and alighting stop, recovered exactly from the assignment (one
 *     destination at a time, as station-od.ts does for BART): the ride length distribution, the
 *     rides that stay inside the Market Street subway (Embarcadero to West Portal) or the Central
 *     Subway, and miles per boarding by route, against NTD's 2.34 for the whole light rail mode.
 *  2. The same routes in SFMTA's 2006–07 stop counts (TEP; muni-stop-ridership.json): ride length
 *     from the published loads, and the share of boardings and alightings at the subway stations.
 *     Straight-line hops on both sides, so the comparison is like for like.
 *  3. BART journeys between the city's stations, model against BART's own counts (regional-od.json):
 *     the short trips on Market Street that BART and the Metro could both carry.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-metro.ts [--json out.json]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildNet, LINK_ALIGHT, LINK_BOARD } from '../../../shared/beta3/net';
import { prepare } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import { StrategySolver } from '../../../shared/beta3/strategy';
import { toXY } from '../../../shared/beta3/geo';
import type { TPeriod } from '../../../shared/beta3/types';
import { TPERIODS } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';
import { modelState } from './od-checks';
import { modelRegionalPairs, readRegional } from './station-od';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const MI = 1.609;
/** the Market Street subway's stations (Twin Peaks tunnel included) and the Central Subway's */
export const MARKET_SUBWAY = /^(Metro )?(Embarcadero|Montgomery|Powell|Civic Center|Van ?Ness|Church( St)?|Castro|Forest Hill|West Portal) Station/i;
export const CENTRAL_SUBWAY = /^(Chinatown - Rose Pak|Union Square\/Market St|Yerba Buena\/Moscone) Station/;
/** a station's name without platform or direction, so both directions and source spellings meet */
export const stationKey = (name: string) => {
  const m = name.match(/(Embarcadero|Montgomery|Powell|Civic Center|Van ?Ness|Church|Castro|Forest Hill|West Portal|Chinatown|Union Square|Yerba Buena)/i);
  return m ? m[1].toLowerCase().replace(/\s/g, '') : name;
};
export const isSubway = (name: string) => MARKET_SUBWAY.test(name.replace(/^VANNESS/i, 'Van Ness')) || CENTRAL_SUBWAY.test(name);
const METRO_ROUTES = ['J', 'K', 'L', 'M', 'N', 'T'];
const BANDS_MI = [0.5, 1, 1.5, 2, 3, 4, 6, Infinity];
const band = (mi: number) => BANDS_MI.findIndex((b) => mi <= b);
/** distance from Embarcadero station (straight line, miles): where along the lines riders get on and off */
const EMBR = toXY(37.7929, -122.3971);
export const FROM_DOWNTOWN_MI = [1, 2, 3, 4, 5, Infinity];
const fromDowntown = (x: number, y: number) => FROM_DOWNTOWN_MI.findIndex((b) => Math.hypot(x - EMBR[0], y - EMBR[1]) / 1000 / MI <= b);

type TepRow = { route: string; patternId: number; seq: number; stopName: string; lat: number | null; lon: number | null; boardings: number; alightings: number; load: number; xy?: [number, number] };
/** where the 2006–07 rows the source could not match to a stop are (stations and the Caltrain stop) */
const PLACES: [RegExp, number, number][] = [
  [/embarcadero station/i, 37.7929, -122.3971],
  [/van ?ness station/i, 37.7752, -122.4192],
  [/king st ?& ?4th st|4th street ?& ?king/i, 37.7766, -122.3943],
];
/** every row of a pattern placed: matched rows where matched, known places, and the rest halfway along the pattern between their neighbors */
function placeRows(list: TepRow[]) {
  for (const r of list) {
    if (r.lat != null) r.xy = toXY(r.lat, r.lon!);
    else {
      const k = PLACES.find(([re]) => re.test(r.stopName));
      if (k) r.xy = toXY(k[1], k[2]);
    }
  }
  for (let k = 0; k < list.length; k++) {
    if (list[k].xy) continue;
    let a = k - 1, b = k + 1;
    while (a >= 0 && !list[a].xy) a--;
    while (b < list.length && !list[b].xy) b++;
    if (a < 0 && b < list.length) list[k].xy = list[b].xy;
    else if (b >= list.length && a >= 0) list[k].xy = list[a].xy;
    else if (a >= 0 && b < list.length) {
      const f = (k - a) / (b - a), A = list[a].xy!, B = list[b].xy!;
      list[k].xy = [A[0] + f * (B[0] - A[0]), A[1] + f * (B[1] - A[1])];
    }
  }
}
/** SFMTA's 2006–07 counts on the Metro lines: ride length from the loads, and boardings and alightings at the subway stations */
export function tepMetro() {
  const T = JSON.parse(fs.readFileSync(`${REFERENCE}/muni-stop-ridership.json`, 'utf8'));
  const out: Record<string, { boardings: number; miPerBoarding: number; subwayOn: number; subwayOff: number; insideSubway: number; onByDistance: number[]; offByDistance: number[] }> = {};
  for (const route of ['J', 'KT', 'L', 'M', 'N']) {
    const rows = (T.rows as TepRow[]).filter((r) => r.route === route);
    let on = 0, pm = 0, sOn = 0, sOff = 0, inside = 0;
    const onD = FROM_DOWNTOWN_MI.map(() => 0), offD = FROM_DOWNTOWN_MI.map(() => 0);
    for (const p of new Set(rows.map((r) => r.patternId))) {
      const list = rows.filter((r) => r.patternId === p).sort((a, b) => a.seq - b.seq);
      placeRows(list);
      for (const r of list) {
        if (!r.xy) continue;
        onD[fromDowntown(...r.xy)] += r.boardings;
        offD[fromDowntown(...r.xy)] += r.alightings;
      }
      // the subway's place on the pattern: riders who board at a subway station and alight at another
      // are bounded by the station alightings on a pattern that starts downtown and the station
      // boardings on one that ends there; take the alightings at subway stations after the first
      // station boarding, less those of riders who boarded before the subway (in proportion)
      let onBoard = 0, fromSubway = 0;
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        on += r.boardings;
        const sub = isSubway(r.stopName);
        if (sub) (sOn += r.boardings), (sOff += r.alightings);
        // alightings come out of everyone on board in proportion
        if (onBoard > 0 && r.alightings > 0) {
          const share = Math.min(1, r.alightings / onBoard);
          if (sub) inside += fromSubway * share;
          fromSubway -= fromSubway * share;
          onBoard -= Math.min(onBoard, r.alightings);
        }
        onBoard += r.boardings;
        if (sub) fromSubway += r.boardings;
        const nx = list[k + 1];
        if (nx && r.xy && nx.xy)
          // the published load leaving the stop
          pm += (r.load * Math.hypot(nx.xy[0] - r.xy[0], nx.xy[1] - r.xy[1])) / 1000 / MI;
      }
    }
    const tOn = onD.reduce((a, v) => a + v, 0), tOff = offD.reduce((a, v) => a + v, 0);
    out[route] = { boardings: on, miPerBoarding: pm / on, subwayOn: sOn / on, subwayOff: sOff / on, insideSubway: inside / on, onByDistance: onD.map((v) => v / tOn), offByDistance: offD.map((v) => v / tOff) };
  }
  return out;
}

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  const crowd = base.finalCrowd;
  const st = await modelState(b, calib, prepare(b), crowd);
  const sc = { name: 'Today', edits: [] };
  // Metro rides by boarding and alighting stop (all periods), per route
  const stopIdx = new Map<number, number>();
  const metroStops: number[] = [];
  H.lines.forEach((l) => {
    if (l.feed !== 'muni' || l.mode !== 'lightrail') return;
    for (const s of l.stops) if (!stopIdx.has(s)) (stopIdx.set(s, metroStops.length), metroStops.push(s));
  });
  const n = metroStops.length;
  const rides: Record<string, Float64Array> = Object.fromEntries(METRO_ROUTES.map((r) => [r, new Float64Array(n * n)]));
  for (const p of TPERIODS as readonly TPeriod[]) {
    const net0 = buildNet(b, sc, p, calib);
    const cr = net0.lines.map((l) => (l.src >= 0 && crowd?.[p]?.[l.src] && [1, 2, 4].some((m) => crowd[p][l.src].length === m * l.stops.length - 1) ? crowd[p][l.src] : new Float32Array(Math.max(0, l.stops.length - 1)).fill(1)));
    const net = buildNet(b, sc, p, calib, cr);
    const lines = net.lines.map((l, i) => [l, i] as const).filter(([l]) => l.feed === 'muni' && l.mode === 'lightrail');
    const boardL = new Map<number, number[][]>(), alightL = new Map<number, number[][]>();
    for (const [l, i] of lines) (boardL.set(i, l.stops.map(() => [])), alightL.set(i, l.stops.map(() => [])));
    for (let a = 0; a < net.nLinks; a++) {
      const t = net.type[a];
      if (t !== LINK_BOARD && t !== LINK_ALIGHT) continue;
      const m = (t === LINK_BOARD ? boardL : alightL).get(net.line[a]);
      if (m) m[net.pos[a]].push(a);
    }
    const solver = new StrategySolver(net);
    const od = st.demand.transitOD[p], Z = net.nZones;
    const prev = new Float64Array(net.nLinks);
    for (let d = 0; d < Z; d++) {
      let any = false;
      for (let o = 0; o < Z; o++) if (od[o * Z + d] > 0) (any = true), (o = Z);
      if (!any) continue;
      solver.solve(d);
      solver.load((o) => od[o * Z + d]);
      const lv = solver.linkVol;
      const delta = (as: number[]) => as.reduce((x, a) => x + lv[a] - prev[a], 0);
      for (const [l, i] of lines) {
        const R = rides[l.route];
        if (!R) continue;
        const b2 = boardL.get(i)!, al = alightL.get(i)!;
        const comp = new Float64Array(l.stops.length);
        let total = 0;
        for (let k = 0; k < l.stops.length; k++) {
          const x = delta(al[k]);
          if (x > 0 && total > 0) {
            const share = Math.min(1, x / total);
            for (let q = 0; q < k; q++) {
              if (!comp[q]) continue;
              const v = comp[q] * share;
              R[stopIdx.get(l.stops[q])! * n + stopIdx.get(l.stops[k])!] += v;
              comp[q] -= v;
            }
            total -= Math.min(total, x);
          }
          const y = delta(b2[k]);
          if (y > 0) (comp[k] += y), (total += y);
        }
      }
      for (const [l, i] of lines) for (const as of [...boardL.get(i)!, ...alightL.get(i)!]) for (const a of as) prev[a] = lv[a];
    }
  }
  // ride lengths (straight line between the stops, as for the 2006–07 counts) and where rides are
  const xy = metroStops.map((s) => [H.stops[s].x, H.stops[s].y]);
  const straightMi = (i: number, j: number) => Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]) / 1000 / MI;
  const byRoute: Record<string, { boardings: number; miPerBoarding: number; subwayOn: number; subwayOff: number; insideSubway: number; bands: number[]; onByDistance: number[]; offByDistance: number[] }> = {};
  const allBands = new Array(BANDS_MI.length).fill(0);
  let allOn = 0, allMi = 0;
  const pairTotals = new Map<string, number>();
  for (const r of METRO_ROUTES) {
    const R = rides[r];
    let on = 0, mi = 0, sOn = 0, sOff = 0, inside = 0;
    const bands = new Array(BANDS_MI.length).fill(0);
    const onD = FROM_DOWNTOWN_MI.map(() => 0), offD = FROM_DOWNTOWN_MI.map(() => 0);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const v = R[i * n + j];
        if (!v) continue;
        const m = straightMi(i, j);
        on += v;
        mi += v * m;
        bands[band(m)] += v;
        onD[fromDowntown(xy[i][0], xy[i][1])] += v;
        offD[fromDowntown(xy[j][0], xy[j][1])] += v;
        const si = isSubway(H.stops[metroStops[i]].name), sj = isSubway(H.stops[metroStops[j]].name);
        if (si) sOn += v;
        if (sj) sOff += v;
        if (si && sj) {
          inside += v;
          const k = [stationKey(H.stops[metroStops[i]].name), stationKey(H.stops[metroStops[j]].name)].sort().join('–');
          pairTotals.set(k, (pairTotals.get(k) ?? 0) + v);
        }
      }
    byRoute[r] = { boardings: on, miPerBoarding: mi / Math.max(1, on), subwayOn: sOn / Math.max(1, on), subwayOff: sOff / Math.max(1, on), insideSubway: inside / Math.max(1, on), bands: bands.map((v) => v / Math.max(1, on)), onByDistance: onD.map((v) => v / Math.max(1, on)), offByDistance: offD.map((v) => v / Math.max(1, on)) };
    bands.forEach((v, k) => (allBands[k] += v));
    allOn += on;
    allMi += mi;
  }
  const tep = tepMetro();
  // BART between the city's stations
  const ref = readRegional();
  const bm = modelRegionalPairs(b, calib, 'wkd', st.demand, crowd, ref).bart;
  const codes = ref.bart.codes, ix = (c: string) => codes.indexOf(c);
  const DT = ['EMBR', 'MONT', 'POWL', 'CIVC'], CITY = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB'];
  const sumOD = (M: Record<string, number[][]>, A: string[], B: string[]) => TPERIODS.reduce((a, p) => a + A.reduce((x, s) => x + B.reduce((y, t) => y + (s === t ? 0 : M[p][ix(s)][ix(t)]), 0), 0), 0);
  const bart = {
    downtown: { observed: Math.round(sumOD(ref.bart.od.wkd, DT, DT)), model: Math.round(sumOD(bm, DT, DT)) },
    downtownMission: { observed: Math.round(sumOD(ref.bart.od.wkd, DT, ['16TH', '24TH']) + sumOD(ref.bart.od.wkd, ['16TH', '24TH'], DT)), model: Math.round(sumOD(bm, DT, ['16TH', '24TH']) + sumOD(bm, ['16TH', '24TH'], DT)) },
    city: { observed: Math.round(sumOD(ref.bart.od.wkd, CITY, CITY)), model: Math.round(sumOD(bm, CITY, CITY)) },
  };
  const out = {
    note: 'Metro rides by boarding and alighting stop from the assignment at the base run crowding (one demand pass); straight-line miles between the two stops for the model and the 2006–07 counts alike (NTD follows the track, about 10% longer).',
    model: { boardings: Math.round(allOn), miPerBoardingStraight: allMi / allOn, bandsMi: BANDS_MI.map(String), bands: allBands.map((v) => v / allOn), byRoute },
    tep2006: tep,
    subwayPairs: [...pairTotals].sort((a, c) => c[1] - a[1]).slice(0, 20).map(([k, v]) => ({ pair: k, rides: Math.round(v) })),
    bart,
  };
  const f = (x: number) => (100 * x).toFixed(1).padStart(5);
  console.log(`Metro rides (model, straight line): ${Math.round(allOn)} boardings, ${out.model.miPerBoardingStraight.toFixed(2)} mi per boarding; by band ${BANDS_MI.map((b2, k) => `≤${b2} ${f(out.model.bands[k])}%`).join(' ')}`);
  console.log('route  model: boardings  mi/boarding  on at subway  off at subway  inside subway | 2006–07: boardings  mi/boarding  on at subway  off at subway  inside subway');
  for (const r of METRO_ROUTES) {
    const m = byRoute[r], t = tep[r === 'K' ? 'KT' : r];
    console.log(`${r.padEnd(5)}  ${String(Math.round(m.boardings)).padStart(8)}  ${m.miPerBoarding.toFixed(2).padStart(6)}  ${f(m.subwayOn)}%  ${f(m.subwayOff)}%  ${f(m.insideSubway)}% | ${t ? `${String(t.boardings).padStart(8)}  ${t.miPerBoarding.toFixed(2).padStart(6)}  ${f(t.subwayOn)}%  ${f(t.subwayOff)}%  ${f(t.insideSubway)}%` : ''}`);
  }
  console.log(`getting on | off by miles from Embarcadero (${FROM_DOWNTOWN_MI.map((x) => `≤${x}`).join(' ')}), model / 2006–07:`);
  for (const r of METRO_ROUTES) {
    const m = byRoute[r], t = tep[r === 'K' ? 'KT' : r];
    const row = (a: number[]) => a.map((v) => (100 * v).toFixed(0).padStart(3)).join(' ');
    console.log(`${r.padEnd(3)} on ${row(m.onByDistance)}${t ? ` / ${row(t.onByDistance)}` : ''} | off ${row(m.offByDistance)}${t ? ` / ${row(t.offByDistance)}` : ''}`);
  }
  console.log(`subway pairs: ${out.subwayPairs.map((x) => `${x.pair} ${x.rides}`).join(', ')}`);
  console.log(`BART journeys (model/observed): among the four Market Street stations ${bart.downtown.model}/${bart.downtown.observed}; between them and 16th/24th ${bart.downtownMission.model}/${bart.downtownMission.observed}; all within the city ${bart.city.model}/${bart.city.observed}`);
  const jf = arg('--json', '');
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
}

if (process.argv[1]?.endsWith('diag-metro.ts')) main();
