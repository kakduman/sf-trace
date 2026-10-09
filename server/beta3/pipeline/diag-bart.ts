/**
 * Diagnostic: where the model's riders go after leaving BART at each city-area station, and where
 * they came from on the way in. Exits split into walking to a zone (by neighborhood and distance),
 * walking over to another operator's stop (by route boarded), and changing BART trains. Entries
 * are split the same way. Compared with BART's average weekday exits and entries.
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/diag-bart.ts [CODE ...]
 */
import { computeDemand } from '../../../shared/beta3/demand';
import { LocalExecutor, prepare, SKIM_PERIODS } from '../../../shared/beta3/model';
import { LINK_ACCESS, LINK_ALIGHT, LINK_BOARD, LINK_CHANGE, LINK_EGRESS, LINK_WALK, boardStop } from '../../../shared/beta3/net';
import type { TPeriod } from '../../../shared/beta3/types';
import { loadBundle } from './run-base';

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.hypot((a.lat - b.lat) * 111.2, (a.lon - b.lon) * 88.0);

async function main() {
  const b = loadBundle();
  const H = b.header;
  const calib = H.calibration!;
  const exec = new LocalExecutor(b, { name: 'Today', edits: [] }, calib);
  const sk: Record<string, unknown> = {};
  for (const p of SKIM_PERIODS) sk[p] = await exec.skim(p, undefined);
  const d = computeDemand(b, prepare(b), sk as never, calib);
  const only = new Set(process.argv.slice(2));
  // named stations may be anywhere; otherwise the city's nine
  const stations = H.observed.bartStations.filter((st) => st.stop !== null && (only.size ? only.has(st.code) : H.stops[st.stop].lat > 37.7 && H.stops[st.stop].lon < -122.38));
  const byStop = new Map(stations.map((st) => [st.stop as number, st]));
  type Tally = { zone: Map<string, number>; dist: number[]; xfer: Map<string, number>; xferSum: number; change: number; total: number };
  const blank = (): Tally => ({ zone: new Map(), dist: [0, 0, 0, 0], xfer: new Map(), xferSum: 0, change: 0, total: 0 });
  const exitsT = new Map<number, Tally>(), entriesT = new Map<number, Tally>();
  for (const s of byStop.keys()) exitsT.set(s, blank()), entriesT.set(s, blank());
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const band = (x: number) => (x < 0.4 ? 0 : x < 0.8 ? 1 : x < 1.6 ? 2 : 3);
  const byPeriod: string[] = [];
  const xferByPeriod: string[] = [];
  // the Market Street subway's downtown stations (both platforms), for the same symmetry check
  const METRO = ['Embarcadero', 'Montgomery', 'Powell', 'Civic Center'];
  const metroOf = (s: number) => METRO.findIndex((m) => H.stops[s]?.feed === 'muni' && H.stops[s].name.startsWith(`Metro ${m}`));
  const metroByPeriod: string[] = [];
  const DOWNTOWN = ['EMBR', 'MONT', 'POWL', 'CIVC'];
  const woak = H.stops.findIndex((st) => st.feed === 'bart' && st.name === 'West Oakland');
  // [exits, entries][station][East Bay, south]
  const sideTally = [0, 1].map(() => DOWNTOWN.map(() => [0, 0]));
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const vol = await exec.assign(p, d.transitOD[p], undefined);
    const before = [...byStop.keys()].map((st) => [exitsT.get(st)!.total, entriesT.get(st)!.total, exitsT.get(st)!.xferSum, entriesT.get(st)!.xferSum]);
    const net = exec.net(p);
    const Z = net.nZones, S = net.nStops, A0 = Z, B0 = Z + S;
    // the stop of every boarding node: B, and the separate node that riders changing lines board
    // from at a stop with a long headway (net.ts), so transfers into it count as entries
    const boardNodeStop = new Map<number, number>();
    for (let a = 0; a < net.nLinks; a++) if (net.type[a] === LINK_BOARD) boardNodeStop.set(net.tail[a], boardStop(net, a));
    // walk transfers are named by the stop walked to (or from)
    const routeAt = new Map<number, string>();
    const routeName = (stopNode: number) => {
      if (!routeAt.has(stopNode)) {
        const k = boardNodeStop.get(stopNode) ?? (stopNode >= A0 && stopNode < B0 ? stopNode - A0 : -1);
        const st = H.stops[k];
        routeAt.set(stopNode, st ? `${st.feed}:${st.name.slice(0, 28)}` : `new stop ${stopNode}`);
      }
      return routeAt.get(stopNode)!;
    };
    for (let a = 0; a < net.nLinks; a++) {
      const v = vol[a];
      if (!v) continue;
      const t = net.type[a], tail = net.tail[a], head = net.head[a];
      // leaving the station: from its alighting node
      if (tail >= A0 && tail < B0 && byStop.has(tail - A0)) {
        const T = exitsT.get(tail - A0)!;
        if (t === LINK_EGRESS) {
          if (head >= H.zones.length) bump(T.zone, 'outside the city', v);
          else bump(T.zone, H.zones[head].nhood, v), (T.dist[band(km(H.zones[head], H.stops[tail - A0]))] += v);
        } else if (t === LINK_WALK) bump(T.xfer, routeName(head), v), (T.xferSum += v);
        else if (t === LINK_CHANGE) T.change += v;
        T.total += v;
      }
      // entering it: into its boarding node
      const hs = t === LINK_BOARD ? undefined : boardNodeStop.get(head);
      if (hs !== undefined && byStop.has(hs)) {
        const T = entriesT.get(hs)!;
        if (t === LINK_ACCESS) {
          if (tail >= H.zones.length) bump(T.zone, 'outside the city', v);
          else bump(T.zone, H.zones[tail].nhood, v), (T.dist[band(km(H.zones[tail], H.stops[head - B0]))] += v);
        } else if (t === LINK_WALK) bump(T.xfer, routeName(tail), v), (T.xferSum += v);
        else if (t === LINK_CHANGE) T.change += v;
        T.total += v;
      }
    }
    // BART riders getting off and on at the downtown stations by the side of the bay the train
    // comes from or goes to (through West Oakland, or from the south), as BART's hourly OD gives them
    for (let a = 0; a < net.nLinks; a++) {
      const t = net.type[a];
      if (!vol[a] || (t !== LINK_BOARD && t !== LINK_ALIGHT)) continue;
      const l = net.lines[net.line[a]];
      if (l.mode !== 'bart') continue;
      const st = l.stops[net.pos[a]], i = DOWNTOWN.indexOf(byStop.get(st)?.code ?? '');
      if (i < 0) continue;
      const w = l.stops.indexOf(woak);
      const east = w >= 0 && (t === LINK_ALIGHT ? w < net.pos[a] : w > net.pos[a]);
      sideTally[t === LINK_ALIGHT ? 0 : 1][i][east ? 0 : 1] += vol[a];
    }
    const mOn = METRO.map(() => 0), mOff = METRO.map(() => 0);
    for (let a = 0; a < net.nLinks; a++) {
      const t = net.type[a];
      if (!vol[a] || (t !== LINK_BOARD && t !== LINK_ALIGHT) || net.lines[net.line[a]].mode !== 'lightrail') continue;
      const m = metroOf(net.lines[net.line[a]].stops[net.pos[a]]);
      if (m >= 0) (t === LINK_BOARD ? mOn : mOff)[m] += vol[a];
    }
    metroByPeriod.push(`${p}: ` + METRO.map((m, i) => `${m} ${(mOff[i] / 1000).toFixed(1)}/${(mOn[i] / 1000).toFixed(1)}`).join(' '));
    byPeriod.push(`${p}: ` + [...byStop].map(([st, o], i) => `${o.code} ${((exitsT.get(st)!.total - before[i][0]) / 1000).toFixed(1)}/${((entriesT.get(st)!.total - before[i][1]) / 1000).toFixed(1)}`).join(' '));
    // of which, walking over from or to another operator's stop (Muni Metro, buses)
    xferByPeriod.push(`${p}: ` + [...byStop].map(([st, o], i) => `${o.code} ${((exitsT.get(st)!.xferSum - before[i][2]) / 1000).toFixed(1)}/${((entriesT.get(st)!.xferSum - before[i][3]) / 1000).toFixed(1)}`).join(' '));
  }
  console.log('exits/entries by period (k):\n  ' + byPeriod.join('\n  '));
  console.log('of which changes to/from other operators (BART→other / other→BART, k):\n  ' + xferByPeriod.join('\n  '));
  console.log('Muni Metro subway, riders off/on by period (k):\n  ' + metroByPeriod.join('\n  '));
  const k = (x: number) => `${(x / 1000).toFixed(1)}k`;
  // BART's average weekday OD for August 2026 (data/beta3/raw/obs/bart_Ridership_202608.xlsx), for
  // comparison, East Bay / south (trips between the four downtown stations left out): exits EMBR
  // 17.9k/4.6k, MONT 12.3k/5.5k, POWL 7.7k/4.9k, CIVC 7.2k/3.3k; entries EMBR 15.4k/4.3k, MONT
  // 11.5k/4.8k, POWL 8.5k/5.0k, CIVC 8.3k/3.3k
  console.log('downtown BART riders by the side the train comes from or goes to (East Bay / south):\n  ' + ['exits', 'entries'].map((w, x) => `${w}: ` + DOWNTOWN.map((c, i) => `${c} ${k(sideTally[x][i][0])}/${k(sideTally[x][i][1])}`).join(' ')).join('\n  '));
  const top = (m: Map<string, number>, n: number) => [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, v]) => `${name} ${k(v)}`).join(', ');
  for (const [s, st] of byStop) {
    for (const [what, T, obs] of [['exits', exitsT.get(s)!, st.exits], ['entries', entriesT.get(s)!, st.entries]] as const) {
      const walk = [...T.zone.values()].reduce((x, y) => x + y, 0), xfer = [...T.xfer.values()].reduce((x, y) => x + y, 0);
      console.log(`${st.code} ${what}: model ${k(T.total)}${obs ? ` vs count ${k(obs)}` : ''} | walk ${k(walk)} (<0.4 km ${k(T.dist[0])}, 0.4–0.8 ${k(T.dist[1])}, 0.8–1.6 ${k(T.dist[2])}, >1.6 ${k(T.dist[3])}) | transfer ${k(xfer)} | change trains ${k(T.change)}`);
      console.log(`   walk to: ${top(T.zone, 6)}`);
      if (xfer > 50) console.log(`   transfer at: ${top(T.xfer, 6)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
