/**
 * The regional side of a run, against BART's station-to-station counts: entries at each station
 * outside the city on trips toward San Francisco, exits there on trips from it, by station and by
 * corridor, and how the model's riders reach those stations (on foot, by car to a lot, by bus).
 * Model entries are what enters a station from the street (access links, and walking over from
 * another operator's stop), so changing BART trains at MacArthur or Bay Fair is not counted twice.
 * Used by experiment.ts.
 */
import fs from 'node:fs';
import { EXT_BUS, EXT_CONNECTOR_FIELDS, EXT_DRIVE, LINK_ACCESS, LINK_CHANGE, LINK_EGRESS, LINK_WALK, type TransitNet } from '../../../shared/beta3/net';
import type { Bundle, TPeriod } from '../../../shared/beta3/types';
import { REFERENCE } from './paths';

export const SF_CODES = ['EMBR', 'MONT', 'POWL', 'CIVC', '16TH', '24TH', 'GLEN', 'BALB', 'DALY'];
/** BART corridors outside the city (by line, beyond the trunk) */
export const CORRIDOR: Record<string, string> = {
  RICH: 'Richmond', DELN: 'Richmond', PLZA: 'Richmond', NBRK: 'Richmond', DBRK: 'Richmond', ASHB: 'Richmond',
  MCAR: 'Oakland core', '19TH': 'Oakland core', '12TH': 'Oakland core', WOAK: 'Oakland core', LAKE: 'Oakland core',
  ROCK: 'Concord', ORIN: 'Concord', LAFY: 'Concord', WCRK: 'Concord', PHIL: 'Concord', CONC: 'Concord', NCON: 'Concord', PITT: 'Concord', PCTR: 'Concord', ANTC: 'Concord',
  FTVL: 'Fremont', COLS: 'Fremont', SANL: 'Fremont', BAYF: 'Fremont', HAYW: 'Fremont', SHAY: 'Fremont', UCTY: 'Fremont', FRMT: 'Fremont', WARM: 'Fremont', MLPT: 'Fremont', BERY: 'Fremont', OAKL: 'Fremont',
  CAST: 'Dublin', WDUB: 'Dublin', DUBL: 'Dublin',
  COLM: 'Peninsula', SSAN: 'Peninsula', SBRN: 'Peninsula', SFIA: 'Peninsula', MLBR: 'Peninsula',
};

export function stats(pairs: { obs: number; mod: number }[]) {
  const n = pairs.length, mo = pairs.reduce((a, p) => a + p.obs, 0) / n, mm = pairs.reduce((a, p) => a + p.mod, 0) / n;
  let cov = 0, vo = 0, vm = 0, se = 0, w25 = 0;
  for (const p of pairs) {
    cov += (p.obs - mo) * (p.mod - mm);
    vo += (p.obs - mo) ** 2;
    vm += (p.mod - mm) ** 2;
    se += (p.mod - p.obs) ** 2;
    if (Math.abs(p.mod / p.obs - 1) <= 0.25) w25++;
  }
  return { n, total: mm / mo, r: cov / Math.sqrt(vo * vm), pctRmse: (100 * Math.sqrt(se / n)) / mo, within25: w25 / n };
}

export function regionalDiag(b: Bundle, nets: Record<TPeriod, TransitNet>, vols: Record<TPeriod, Float64Array>) {
  const H = b.header;
  const NZ = H.zones.length, NX = H.ext.length;
  const bart = JSON.parse(fs.readFileSync(`${REFERENCE}/bart-ridership.json`, 'utf8'));
  const codes: string[] = bart.od.codes;
  const M: number[][] = bart.od.matrix;
  const sfIdx = codes.map((c, i) => (SF_CODES.includes(c) ? i : -1)).filter((i) => i >= 0);
  const stopOf = new Map(H.observed.bartStations.filter((s) => s.stop !== null).map((s) => [s.code, s.stop as number]));
  const codeOf = new Map([...stopOf].map(([c, s]) => [s, c]));
  const xconn = b.a.extConnectors as Int32Array;
  const XS = EXT_CONNECTOR_FIELDS;
  // per BART stop: entries and exits by how they reach the street (walk / drive / bus / transfer), and by period
  type T = { walk: number; drive: number; bus: number; xfer: number; act: number; byP: Record<string, number> };
  const blank = (): T => ({ walk: 0, drive: 0, bus: 0, xfer: 0, act: 0, byP: { AM: 0, MD: 0, PM: 0, NT: 0 } });
  const ent = new Map<number, T>(), ex = new Map<number, T>();
  for (const s of stopOf.values()) ent.set(s, blank()), ex.set(s, blank());
  // and the other regional stations and terminals outside the city (ferries, Caltrain, SMART)
  const outside = (st: { lat: number; lon: number }) => !(st.lat > 37.705 && st.lat < 37.835 && st.lon > -122.52 && st.lon < -122.355);
  const ferryStop = new Set(H.lines.filter((l) => l.mode === 'ferry').flatMap((l) => l.stops));
  const terminals = H.stops.map((st, k) => k).filter((k) => outside(H.stops[k]) && (ferryStop.has(k) || ['caltrain', 'smart'].includes(H.stops[k].feed)));
  for (const k of terminals) ent.set(k, blank()), ex.set(k, blank());
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const net = nets[p], vol = vols[p];
    const Z = net.nZones, S = net.nStops, A0 = Z, B0 = Z + S;
    // the stop a transfer boards at: its boarding node, or the node riders changing lines board from
    // where a line has a long headway (net.ts X), found from the stop's change link
    const xStop = new Map<number, number>();
    for (let a = 0; a < net.nLinks; a++) if (net.type[a] === LINK_CHANGE) xStop.set(net.head[a], net.tail[a] - A0);
    const boardAt = (node: number) => (node >= B0 && node < B0 + S ? node - B0 : (xStop.get(node) ?? -1));
    for (let a = 0; a < net.nLinks; a++) {
      const v = vol[a];
      if (!v) continue;
      const t = net.type[a];
      let st = -1, into = true;
      if (t === LINK_ACCESS && net.head[a] >= B0 && net.head[a] < B0 + S) st = net.head[a] - B0;
      else if (t === LINK_EGRESS && net.tail[a] >= A0 && net.tail[a] < B0) (st = net.tail[a] - A0), (into = false);
      else if (t === LINK_WALK) {
        // walking over from (or to) another operator's stop
        const from = net.tail[a] - A0, to = boardAt(net.head[a]);
        if (ent.has(to) && H.stops[from]?.feed !== H.stops[to]?.feed) st = to;
        else if (ex.has(from) && H.stops[to]?.feed !== H.stops[from]?.feed) (st = from), (into = false);
      }
      if (st < 0 || !ent.has(st)) continue;
      const tally = (into ? ent : ex).get(st)!;
      tally.byP[p] += v;
      if (t === LINK_WALK) {
        tally.xfer += v;
        continue;
      }
      const zone = into ? net.tail[a] : net.head[a];
      if (zone < NZ) {
        tally.walk += v;
        continue;
      }
      // outside: the access record's kind, and which end (the activity end's zones follow the home ends)
      const rec = net.extRec[a];
      if (rec < 0) continue;
      const kind = xconn[rec * XS + 5];
      if (zone >= NZ + NX) tally.act += v;
      else if (kind === EXT_DRIVE) tally.drive += v;
      else if (kind === EXT_BUS) tally.bus += v;
      else tally.walk += v;
    }
  }
  const sum = (x: T) => x.walk + x.drive + x.bus + x.xfer + x.act;
  const rows = codes
    .map((c, i) => {
      const s = stopOf.get(c);
      const toSF = sfIdx.reduce((a, j) => a + (M[i]?.[j] ?? 0), 0);
      const fromSF = sfIdx.reduce((a, j) => a + (M[j]?.[i] ?? 0), 0);
      const e = s !== undefined ? ent.get(s)! : blank(), x = s !== undefined ? ex.get(s)! : blank();
      return { code: c, corridor: CORRIDOR[c] ?? 'SF', obsIn: Math.round(toSF), modIn: Math.round(sum(e)), obsOut: Math.round(fromSF), modOut: Math.round(sum(x)), inBy: { walk: Math.round(e.walk), drive: Math.round(e.drive), bus: Math.round(e.bus), xfer: Math.round(e.xfer), act: Math.round(e.act) }, inByP: Object.fromEntries(Object.entries(e.byP).map(([k, v]) => [k, Math.round(v)])), outByP: Object.fromEntries(Object.entries(x.byP).map(([k, v]) => [k, Math.round(v)])) };
    })
    .filter((r) => !SF_CODES.includes(r.code));
  const keep = rows.filter((r) => r.obsIn > 300);
  const corridors = new Map<string, { obsIn: number; modIn: number; obsOut: number; modOut: number }>();
  for (const r of rows) {
    const c = corridors.get(r.corridor) ?? { obsIn: 0, modIn: 0, obsOut: 0, modOut: 0 };
    c.obsIn += r.obsIn, c.modIn += r.modIn, c.obsOut += r.obsOut, c.modOut += r.modOut;
    corridors.set(r.corridor, c);
  }
  void codeOf;
  const terminalRows = terminals.map((k) => {
    const e = ent.get(k)!, x = ex.get(k)!;
    return { name: H.stops[k].name, feed: H.stops[k].feed, entries: Math.round(sum(e)), exits: Math.round(sum(x)), inBy: { walk: Math.round(e.walk), drive: Math.round(e.drive), bus: Math.round(e.bus), xfer: Math.round(e.xfer), act: Math.round(e.act) } };
  }).filter((r) => r.entries + r.exits > 50).sort((a, b) => b.entries - a.entries);
  return {
    outsideEntries: { ...stats(keep.map((r) => ({ obs: r.obsIn, mod: r.modIn }))) },
    outsideExits: { ...stats(rows.filter((r) => r.obsOut > 300).map((r) => ({ obs: r.obsOut, mod: r.modOut }))) },
    corridors: Object.fromEntries(corridors),
    rows,
    terminals: terminalRows,
  };
}

/**
 * How riders from home reach BART's stations outside the city: the model's home-end entries there by
 * way in (on foot, by bus, by car), against BART's 2024 Station Profile Study (home origins; walk
 * counts bicycles and scooters, car counts parking, drop-off, and ride-hail), both summed over the
 * stations outside the city's nine. Used by calibration (extAccessBias) and the experiment report.
 */
export function accessShares(b: Bundle, nets: Record<TPeriod, TransitNet>, vols: Record<TPeriod, Float64Array>) {
  const H = b.header;
  const NZ = H.zones.length, NX = H.ext.length;
  const xconn = b.a.extConnectors as Int32Array;
  const prof = JSON.parse(fs.readFileSync(`${REFERENCE}/bart-station-access-2024.json`, 'utf8')).stations as Record<string, number | string | null>[];
  const key = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/STREET|ST(?=[A-Z0-9])/g, 'ST');
  const stopByKey = new Map<string, { stop: number; code: string }>();
  for (const s of H.observed.bartStations) if (s.stop !== null && !SF_CODES.includes(s.code)) stopByKey.set(key(s.name).slice(0, 12), { stop: s.stop, code: s.code });
  const target = { walk: 0, bus: 0, drive: 0 }, model = { walk: 0, bus: 0, drive: 0 };
  const stations = new Set<number>();
  const perStation = new Map<number, { code: string; obs: { walk: number; bus: number; drive: number }; mod: { walk: number; bus: number; drive: number } }>();
  for (const r of prof) {
    const hit = stopByKey.get(key(String(r.station)).slice(0, 12));
    if (!hit || typeof r.walk !== 'number' || !r.homeOriginEntries) continue;
    const h = r.homeOriginEntries as number;
    const o = { walk: (r.walk as number) + (r.bike as number) + (r.scooter as number), bus: r.busTransit as number, drive: (r.driveParkCarpool as number) + (r.dropOff as number) + (r.tnc as number) };
    target.walk += h * o.walk, target.bus += h * o.bus, target.drive += h * o.drive;
    stations.add(hit.stop);
    perStation.set(hit.stop, { code: hit.code, obs: o, mod: { walk: 0, bus: 0, drive: 0 } });
  }
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const net = nets[p], vol = vols[p];
    if (!net || !vol) continue;
    const B0 = net.nZones + net.nStops;
    for (let a = 0; a < net.nLinks; a++) {
      const rec = net.extRec[a];
      if (rec < 0 || !vol[a] || net.type[a] !== LINK_ACCESS || net.tail[a] >= NZ + NX) continue;
      const st = net.head[a] - B0;
      if (!stations.has(st)) continue;
      const kind = ['walk', 'bus', 'drive'][xconn[rec * EXT_CONNECTOR_FIELDS + 5]] as 'walk' | 'bus' | 'drive';
      model[kind] += vol[a];
      perStation.get(st)!.mod[kind] += vol[a];
    }
  }
  const norm = (x: { walk: number; bus: number; drive: number }) => {
    const t = x.walk + x.bus + x.drive || 1;
    return { walk: x.walk / t, bus: x.bus / t, drive: x.drive / t };
  };
  const rows = [...perStation.values()].map((s) => ({ code: s.code, obs: s.obs, mod: norm(s.mod) }));
  return { target: norm(target), model: norm(model), driveShareFit: stats(rows.map((r) => ({ obs: r.obs.drive, mod: r.mod.drive }))), rows };
}
