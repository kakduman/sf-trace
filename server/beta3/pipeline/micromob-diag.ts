/**
 * Shared micromobility against what was counted (calibrate.ts fits to these; experiment.ts and
 * micromob-validate.ts report them):
 *  - Bay Wheels trips with both ends in the city on an average weekday, October 2025 to September 2026
 *    (trip data, bikeshare.ts), and the e-bikes' share of them;
 *  - scooter trips on an average weekday (SFMTA's monthly counts for the same months, bikeshare.ts);
 *  - Bay Wheels' mean trip length: rides between two stations, on the route the model's bikes take
 *    (bikeshare.ts), for the term per km ridden;
 *  - rides to stations: Bay Wheels rides ending in the morning peak (6–10am) at stations within 150 m
 *    of the four BART stations outside downtown (16th Street, 24th Street, Glen Park, Balboa Park),
 *    scaled up by the share of rides that end at a station rather than at a rack. Downtown, a ride
 *    ending beside a station is as likely to be going to an office as to a train, so those stations
 *    are compared, not fitted.
 * The model's shared trips are its mode choice's (DemandResult.micro) plus its rides to and from
 * stations (the volumes on the shared-vehicle access and egress links).
 */
import fs from 'node:fs';
import { MICRO, MICRO_TYPES, isMicroAccess, microData, microLinks, microSettingsOf, type MicroCalib, type MicroLink, type MicroResult } from '../../../shared/beta3/micromobility';
import type { TransitNet } from '../../../shared/beta3/net';
import type { Bundle, Calibration, Scenario, TPeriod } from '../../../shared/beta3/types';
import { PATH } from '../../../shared/beta3/params';
import { REFERENCE } from './paths';

const BW = JSON.parse(fs.readFileSync(`${REFERENCE}/bay-wheels-sf.json`, 'utf8'));
export const BAY_WHEELS = BW;
/** the BART stations outside downtown whose morning Bay Wheels arrivals stand for rides to the train */
export const ACCESS_STATIONS = ['16th Street / Mission', '24th Street / Mission', 'Glen Park', 'Balboa Park'];
/** the downtown BART and Muni Metro stations, whose morning Bay Wheels departures stand for rides from the train */
export const DOWNTOWN_STATIONS = ['Embarcadero', 'Montgomery Street', 'Powell Street', 'Civic Center / UN Plaza'];
export const MICRO_TARGETS = (() => {
  const w = BW.weekday;
  const ends = w.ends as Record<string, number>;
  // the share of rides that end at a station (the rest at a rack: e-bikes only)
  const atStation = ((ends['station-station'] ?? 0) + (ends['away-station'] ?? 0)) / w.trips;
  const st = (BW.nearStations.stations as { name: string; endsAM: number }[]).filter((s) => ACCESS_STATIONS.includes(s.name));
  return {
    bayWheels: w.trips as number,
    ebikeShare: w.byType.electric_bike / w.trips,
    scooter: BW.sfmtaCounts.scootersPerWeekday as number,
    accessAM: st.reduce((a, s) => a + s.endsAM, 0) / atStation,
    egressAM: (BW.nearStations.stations as { name: string; startsAM: number }[]).filter((s) => DOWNTOWN_STATIONS.includes(s.name)).reduce((a, s) => a + s.startsAM, 0) / atStation,
    atStation,
    // the mean route length of rides between two stations, the two bikes weighted by their trips
    meanKm: (w.meanRouteKmBetweenStations.classic_bike * w.byType.classic_bike + w.meanRouteKmBetweenStations.electric_bike * w.byType.electric_bike) / w.trips,
  };
})();

export interface MicroAccess {
  /** riders by vehicle (classic, e-bike, scooter) to and from stations, all day and in the morning peak */
  access: number[];
  egress: number[];
  accessAM: number[];
  /** the morning's Bay Wheels rides to the four stations outside downtown, and from the four downtown (the fitted counts) */
  bayWheelsAccessAM: number;
  bayWheelsEgressAM: number;
  /** by station: riders reaching it by shared vehicle and all riders from city zones, all day */
  byPlace: { name: string; kinds: string[]; access: number[]; egress: number[]; accessAM: number[]; egressAM: number[]; fromZones: number; bart: { access: number[]; fromZones: number } }[];
}

/** volumes on the shared-vehicle links, matched to microLinks (net.ts adds one link per entry, in order) */
export function microAccess(b: Bundle, scenario: Scenario, nets: Record<TPeriod, TransitNet>, vols: Record<TPeriod, Float64Array>): MicroAccess {
  const L: MicroLink[] = microLinks(b, microSettingsOf(scenario));
  const P = b.header.micro?.places ?? [];
  const NZ = b.header.zones.length;
  const out: MicroAccess = { access: [0, 0, 0], egress: [0, 0, 0], accessAM: [0, 0, 0], bayWheelsAccessAM: 0, bayWheelsEgressAM: 0, byPlace: P.map((p) => ({ name: p.name, kinds: p.kinds, access: [0, 0, 0], egress: [0, 0, 0], accessAM: [0, 0, 0], egressAM: [0, 0, 0], fromZones: 0, bart: { access: [0, 0, 0], fromZones: 0 } })) };
  const isBart = (s: number) => b.header.stops[s]?.feed === 'bart';
  const placeOfStop = new Map<number, number>();
  P.forEach((p, i) => p.stops.forEach((s) => placeOfStop.set(s, i)));
  for (const p of ['AM', 'MD', 'PM', 'NT'] as TPeriod[]) {
    const net = nets[p], vol = vols[p];
    if (!net || !vol) continue;
    const B0 = net.nZones + net.nStops;
    // every access link from a city zone into a station: its riders from the zones
    for (let a = 0; a < net.nLinks; a++) {
      if ((net.mmKind?.[a] ?? -1) >= 0 || net.type[a] !== 0 || net.tail[a] >= NZ || !vol[a]) continue;
      const st = net.head[a] - B0, pl = placeOfStop.get(st);
      if (pl === undefined) continue;
      out.byPlace[pl].fromZones += vol[a];
      if (isBart(st)) out.byPlace[pl].bart.fromZones += vol[a];
    }
    if (!net.mmLink || net.mmLink.length !== L.length) throw new Error(`shared-vehicle links: ${net.mmLink?.length ?? 0} in the ${p} network, ${L.length} expected`);
    for (let j = 0; j < L.length; j++) {
      const l = L[j];
      const v = vol[net.mmLink[j]] * net.mmShare![j];
      if (!v) continue;
      const k = l.kind;
      const t = MICRO_TYPES.indexOf(l.vehicle);
      const pl = out.byPlace[l.place];
      if (isMicroAccess(k)) {
        out.access[t] += v;
        pl.access[t] += v;
        pl.fromZones += v;
        if (isBart(l.s)) (pl.bart.access[t] += v), (pl.bart.fromZones += v);
        if (p === 'AM') {
          out.accessAM[t] += v;
          pl.accessAM[t] += v;
          if (t < 2 && ACCESS_STATIONS.includes(pl.name)) out.bayWheelsAccessAM += v;
        }
      } else {
        out.egress[t] += v;
        pl.egress[t] += v;
        if (p === 'AM') {
          pl.egressAM[t] += v;
          if (t < 2 && DOWNTOWN_STATIONS.includes(pl.name)) out.bayWheelsEgressAM += v;
        }
      }
    }
  }
  return out;
}

/** each neighborhood's hills: the mean climb (m) on the bike routes of 1–4 km leaving its zones */
export function nhoodClimb(b: Bundle): { nhoods: string[]; climb: Float64Array } {
  const x = microData(b)!;
  const NZ = x.NZ, NH = x.nhoods.length;
  const climb = new Float64Array(NH), n = new Float64Array(NH);
  for (let o = 0; o < NZ; o++)
    for (let d = 0; d < NZ; d++) {
      const m = x.bikeM[o * NZ + d];
      if (m < 1000 || m > 4000) continue;
      climb[x.nh[o]] += x.bikeUp[o * NZ + d] / 10;
      n[x.nh[o]]++;
    }
  for (let i = 0; i < NH; i++) climb[i] = n[i] ? climb[i] / n[i] : NaN;
  return { nhoods: x.nhoods, climb };
}

/** weighted least squares of y on x: slope (per metre of climb), intercept, and r */
function wls(rows: { x: number; y: number; w: number }[]) {
  const W = rows.reduce((a, r) => a + r.w, 0);
  const mx = rows.reduce((a, r) => a + r.w * r.x, 0) / W, my = rows.reduce((a, r) => a + r.w * r.y, 0) / W;
  let sxy = 0, sxx = 0, syy = 0;
  for (const r of rows) (sxy += r.w * (r.x - mx) * (r.y - my)), (sxx += r.w * (r.x - mx) ** 2), (syy += r.w * (r.y - my) ** 2);
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r: sxy / Math.sqrt(sxx * syy), n: rows.length };
}

/**
 * Whether the model's errors follow the hills, by neighborhood: the log of the model's share over the
 * observed share against the neighborhood's mean climb (nhoodClimb), weighted by the observed:
 *  - Bay Wheels trip ends, classic bikes and e-bikes apart (the trip records; neighborhoods with 20+ a day);
 *  - residents' commutes by bike, own and shared, against the ACS 2020–24 by block group (neighborhoods
 *    with 50+ bike commuters).
 * A positive slope is a model too fond of the hills.
 */
export function hills(b: Bundle, m: MicroResult, zoneWork: Float64Array) {
  const { nhoods, climb } = nhoodClimb(b);
  const NH = nhoods.length;
  const names = BW.byNeighborhood.neighborhoods as string[];
  const idx = names.map((n) => nhoods.indexOf(n));
  const ends = (pairs: [number, number, number][]) => {
    const e = new Float64Array(NH);
    for (const [i, j, v] of pairs) if (idx[i] >= 0 && idx[j] >= 0) (e[idx[i]] += v), (e[idx[j]] += v);
    return e;
  };
  const modEnds = (M: Float64Array) => {
    const e = new Float64Array(NH);
    for (let i = 0; i < NH; i++) for (let j = 0; j < NH; j++) (e[i] += M[i * NH + j]), (e[j] += M[i * NH + j]);
    return e;
  };
  const oC = ends(BW.byNeighborhood.odClassic), oA = ends(BW.byNeighborhood.od);
  const oE = oA.map((v, i) => v - oC[i]);
  const mC = modEnds(m.odClassic), mA = modEnds(m.od);
  const mE = mA.map((v, i) => v - mC[i]);
  const fit = (obs: Float64Array, mod: Float64Array, min: number) => {
    const so = obs.reduce((a, v) => a + v, 0), sm = mod.reduce((a, v) => a + v, 0);
    const rows = [...obs.keys()].filter((i) => obs[i] >= min && mod[i] > 0 && Number.isFinite(climb[i])).map((i) => ({ x: climb[i], y: Math.log(mod[i] / sm / (obs[i] / so)), w: obs[i], name: nhoods[i] }));
    return { ...wls(rows), rows: rows.map((r) => ({ name: r.name, climb: +r.x.toFixed(1), logRatio: +r.y.toFixed(3) })) };
  };
  // own and shared bikes: residents' commutes, against the ACS by block group
  const H = b.header;
  const acsBike = new Float64Array(NH), acsAll = new Float64Array(NH), modBike = new Float64Array(NH), modAll = new Float64Array(NH);
  const x = microData(b)!;
  H.zones.forEach((z, i) => {
    const c = z.commute;
    if (!c?.length) return;
    acsBike[x.nh[i]] += c[9];
    acsAll[x.nh[i]] += c.reduce((a, v) => a + v, 0) - c[12];
    modBike[x.nh[i]] += m.bikeWorkHome[i];
    modAll[x.nh[i]] += zoneWork[i];
  });
  const ownRows = [...acsBike.keys()].filter((i) => acsBike[i] >= 50 && modBike[i] > 0 && modAll[i] > 0).map((i) => ({ x: climb[i], y: Math.log(modBike[i] / modAll[i] / (acsBike[i] / acsAll[i])), w: acsBike[i], name: nhoods[i] }));
  return {
    classic: fit(oC, mC, 20),
    ebike: fit(oE, mE, 20),
    own: { ...wls(ownRows), rows: ownRows.map((r) => ({ name: r.name, climb: +r.x.toFixed(1), logRatio: +r.y.toFixed(3) })) },
  };
}

/**
 * Fit the two biases on riding to and from stations (calib.micro.accessBias and egressBias, perceived
 * minutes) on the morning's transit trips as they stand, a few morning assignments, each moving a bias by
 * the log ratio over the access logit's θ:
 *  - riding to a station: the Bay Wheels rides that end at the four BART stations outside downtown;
 *  - riding away from one: the Bay Wheels rides that start at the four downtown stations (Embarcadero,
 *    Montgomery, Powell, Civic Center), where in the morning a ride starting beside a station mostly
 *    leaves a train; an upper bound, since some start from the offices and homes around them.
 */
export async function fitMicroAccess(b: Bundle, scenario: Scenario, calib: Calibration, exec: { net: (p: TPeriod, crowd?: Float32Array[], lot?: Float32Array) => TransitNet; assign: (p: TPeriod, od: Float32Array, crowd: Float32Array[] | undefined, lot?: Float32Array) => Promise<Float64Array> }, odAM: Float32Array, crowdAM?: Float32Array[], lot?: Float32Array, rounds = 5): Promise<string> {
  const c: MicroCalib = (calib.micro ??= { asc: { bayWheels: 0, ebike: 0, scooter: 0 }, accessBias: 0 });
  c.egressBias ??= c.accessBias;
  const T = MICRO_TARGETS;
  const steps: string[] = [];
  for (let r = 0; r < rounds; r++) {
    const net = exec.net('AM', crowdAM, lot);
    const vol = await exec.assign('AM', odAM, crowdAM, lot);
    const acc = microAccess(b, scenario, { AM: net } as Record<TPeriod, TransitNet>, { AM: vol } as Record<TPeriod, Float64Array>);
    const ma = Math.max(0.5, acc.bayWheelsAccessAM), me = Math.max(0.5, acc.bayWheelsEgressAM);
    steps.push(`${Math.round(ma)}/${Math.round(me)} at ${c.accessBias.toFixed(1)}/${c.egressBias.toFixed(1)}`);
    const ra = Math.log(T.accessAM / ma), re = Math.log(T.egressAM / me);
    if (Math.abs(ra) < 0.1 && Math.abs(re) < 0.1) break;
    c.accessBias = Math.max(-20, Math.min(90, c.accessBias - ra / PATH.accessTheta));
    c.egressBias = Math.max(-20, Math.min(90, c.egressBias - re / PATH.accessTheta));
  }
  return `station rides AM, to 4 BART / from 4 downtown (targets ${Math.round(T.accessAM)}/${Math.round(T.egressAM)}): ${steps.join(' → ')} → biases ${c.accessBias.toFixed(1)}/${c.egressBias.toFixed(1)}`;
}

/**
 * One step of fitting the shared vehicles' constants and the access bias. Mode choice's shared trips
 * are fitted to the counts less the model's rides to and from stations (the counts include them).
 * Returns a line for the log.
 */
export function fitMicro(calib: Calibration, m: MicroResult | undefined, acc: MicroAccess | null, damp = 1, hill?: { b: Bundle; zoneWork: Float64Array }): string {
  if (!m) return '';
  const c: MicroCalib = (calib.micro ??= { asc: { bayWheels: 0, ebike: 0, scooter: 0 }, accessBias: 0 });
  const T = MICRO_TARGETS;
  const a = acc ? MICRO_TYPES.map((_, k) => acc.access[k] + acc.egress[k]) : [0, 0, 0];
  const bwMode = m.trips[0] + m.trips[1], bwAll = bwMode + a[0] + a[1];
  const scAll = m.trips[2] + a[2];
  const eShare = (m.trips[1] + a[1]) / Math.max(1, bwAll);
  const logit = (p: number) => Math.log(p / (1 - p));
  // within the non-motorized nest (coefficient MICRO.nest), a constant moves a small alternative's log
  // share by about 1/nest; step by nest × the log ratio
  const g = MICRO.nest * damp;
  // (while the station rides are far off, mode choice is fitted to no less than a quarter of the count)
  c.asc.bayWheels = Math.max(-8, Math.min(8, c.asc.bayWheels + g * Math.log(Math.max(0.25 * T.bayWheels, T.bayWheels - a[0] - a[1]) / Math.max(1, bwMode))));
  c.asc.ebike = Math.max(-5, Math.min(5, c.asc.ebike + g * (logit(T.ebikeShare) - logit(Math.min(0.99, Math.max(0.01, eShare))))));
  c.asc.scooter = Math.max(-8, Math.min(8, c.asc.scooter + g * Math.log(Math.max(0.25 * T.scooter, T.scooter - a[2]) / Math.max(1, m.trips[2]))));
  // the term per km ridden, to Bay Wheels' mean trip length (mode choice's Bay Wheels trips)
  const km = (m.km[0] + m.km[1]) / Math.max(1e-9, bwMode);
  c.kmCoef = Math.max(-3, Math.min(0, (c.kmCoef ?? 0) + 0.6 * damp * Math.log(T.meanKm / km)));
  // the own bike's effort of climbing, against the slope of its errors by neighborhood on their climb
  // (hills); a tour climbs both ways, so a utility per metre moves the log share by about 2/μ per metre
  // of the neighborhood's climb, and the step is μ/2 times the slope. The shared vehicles' come from the
  // literature (MICRO.climbEquiv); their slopes are reported.
  let hillLine = '';
  if (hill) {
    const h = hills(hill.b, m, hill.zoneWork);
    c.climb ??= {};
    c.climb.own = Math.max(-0.2, Math.min(0, (c.climb.own ?? 0) - (MICRO.nest / 2) * damp * h.own.slope));
    hillLine = ` | hills slope (per 10 m) own ${(10 * h.own.slope).toFixed(3)} classic ${(10 * h.classic.slope).toFixed(3)} e-bike ${(10 * h.ebike.slope).toFixed(3)} → own climb ${c.climb.own.toFixed(4)}`;
  }
  c.fit = { bayWheels: [bwAll, T.bayWheels], ebikeShare: [eShare, T.ebikeShare], scooter: [scAll, T.scooter], meanKm: [km, T.meanKm], ...(acc ? { accessAM: [acc.bayWheelsAccessAM, T.accessAM] as [number, number], egressAM: [acc.bayWheelsEgressAM, T.egressAM] as [number, number] } : {}) };
  return `shared: Bay Wheels ${Math.round(bwAll)}/${Math.round(T.bayWheels)} (e-bike ${(100 * eShare).toFixed(0)}/${(100 * T.ebikeShare).toFixed(0)}%), scooters ${Math.round(scAll)}/${T.scooter}, km ${km.toFixed(2)}/${T.meanKm.toFixed(2)}${acc ? `, station rides ${Math.round(a.reduce((x, y) => x + y, 0))} (AM to 4 BART ${Math.round(acc.bayWheelsAccessAM)}/${Math.round(T.accessAM)}, from 4 downtown ${Math.round(acc.bayWheelsEgressAM)}/${Math.round(T.egressAM)})` : ''} | asc ${JSON.stringify(Object.fromEntries(Object.entries(c.asc).map(([k, v]) => [k, +v.toFixed(2)])))} km ${c.kmCoef.toFixed(3)} biases ${c.accessBias.toFixed(1)}/${(c.egressBias ?? c.accessBias).toFixed(1)}${hillLine}`;
}
