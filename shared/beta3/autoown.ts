/**
 * Car ownership: how many cars each household keeps (0, 1, 2, 3, 4+), as MTC Travel Model One's
 * auto ownership model chooses it (model-files/model/AutoOwnership.xls; the same model as
 * ActivitySim's prototype_mtc auto_ownership.csv). A multinomial logit over the number of cars, on
 * the household's adults, children, workers, and income, the density where it lives, and how much
 * it can reach by car, by transit, and on foot.
 *
 * Households come as classes per zone (drivers × workers × income class, each with the mean of its
 * other attributes), built either from the ACS (each zone's households reweighted from the city's
 * PUMS records to its census tables, server/beta3/pipeline/autoown.ts) or from a synthetic
 * population's household records (aoClassesFromHouseholds). The utility is linear in every
 * attribute, so a class's utility at its mean attributes is its households' mean utility.
 *
 * In the base the model is not used to set the car segments: demand keeps each zone's ACS shares.
 * A long-run scenario (DemandContext.carOwnership) re-runs the model with the scenario's accessibility
 * and moves each zone's households between car segments by the ratio of the model's shares in the
 * scenario to its shares in the base (an incremental logit, pivoting on the observed shares), within
 * each income class.
 */
import { INCOME_CLASSES, SEGMENTS } from './params';
import type { Bundle, Calibration } from './types';
import type { Prep, TrnSkims } from './demand';

/** alternatives: 0, 1, 2, 3, and 4 or more cars */
export const AO_ALTS = 5;

/**
 * TM1's coefficients (AutoOwnership.xls, BayAreaMetro/travel-model-one master, with autonomous
 * vehicles off), for 1, 2, 3, and 4+ cars against none. Income is in thousands of 2000 dollars.
 * Accessibility terms are the same for every number of cars.
 */
export const TM1_AO = {
  drivers2: [0, 3.07730250432, 3.19618253206, 2.66160003793],
  drivers3: [0, 3.54012065488, 5.51313083872, 5.2080344851],
  drivers4: [2.01071697193, 6.36624538311, 8.5147651012, 9.58067334579],
  persons16to17: [0, -0.881009827046, -1.73134706307, -1.73134706307],
  persons18to24: [-0.408665938505, -1.00954734811, -1.01071553778, -1.01071553778],
  persons25to34: [0, -0.484880400528, -0.859621567176, -0.859621567176],
  children0to4: [0.3669, 0.7627, 0.7627, 0.7627],
  children5to17: [0.0158, 0.2936, 0.4769, 0.4769],
  workers: [0, 0.293646762176, 0.638857363058, 0.879726345464],
  income0to30: [0.038292703474, 0.0540158228943, 0.0559167379724, 0.0619480692735],
  income30to125: [0, 0.00828261231255, 0.0110160137895, 0.01466905833],
  density0to10: [0, -0.2028, -0.3654, -0.3654],
  density10up: [-0.0152, -0.1106, -0.1766, -0.1766],
  /** retail accessibility, 0.66 × peak + 0.34 × off-peak: by car and by transit, for households without and with workers */
  autoAccess: [0.0626, 0.1646],
  transitAccess: [-0.3053, -0.5117],
  walkAccess: -0.03,
  /** work auto time savings per worker (over walk or transit, round trip, 1 at 120 minutes) */
  autoSavings: [0.4707, 0.6142, 0.5705, 0.7693],
  constants: [1.0875889317307972, -1.2846127141946304, -3.4079299175706494, -5.375102009196325],
  sanFrancisco: [0.5890526288599115, 0.5836444263289985, 0.4159665747289747, -0.152306623880388],
};

/** TM1's accessibility measures (model-files/scripts/skims/Accessibility.job) */
export const AO_ACCESS = {
  /** per round-trip minute: car, transit; per round-trip mile on foot (within 3 miles) */
  dispAuto: -0.05,
  dispTransit: -0.05,
  dispWalk: -1.0,
  maxWalkMiles: 3,
  peakWeight: 0.66,
  /** walk speed for the work auto time savings (mph) */
  walkMph: 3,
};

/**
 * A household class in a zone (or one household, weight 1, from a synthetic population). Fields of
 * the flat array, AO_STRIDE per class: zone index, drivers (persons 16+: 0 = one or none, 1 = two,
 * 2 = three, 3 = four or more), workers (capped at 3), income class (INCOME_CLASSES), households,
 * then the class means: persons 16–17, 18–24, 25–34, share with a child 0–4, share with a child 5–17,
 * income up to $30k and income $30–125k (thousands of 2000 dollars, TM1's piecewise terms).
 */
export const AO_STRIDE = 12;
export const AO_F = { zone: 0, drivers: 1, workers: 2, incClass: 3, hh: 4, p16: 5, p18: 6, p25: 7, kid04: 8, kid517: 9, inc0: 10, inc30: 11 } as const;

/** one household as a synthetic population gives it */
export interface AoHousehold {
  zone: number;
  /** expansion weight (1 for a synthetic household) */
  weight: number;
  /** persons 16 and over, workers (employed persons), and persons by TM1's age groups */
  drivers: number;
  workers: number;
  persons16to17: number;
  persons18to24: number;
  persons25to34: number;
  children0to4: number;
  children5to17: number;
  /** household income, current (2024) dollars */
  income2024: number;
}

/** CPI-U, U.S. city average, annual: 2000 and 2024 (BLS series CUUR0000SA0) */
export const CPI_2000 = 172.2, CPI_2024 = 313.689;
const INCOME_CLASS_BREAK = 100_000;
const piece0 = (k2000: number) => Math.min(Math.max(k2000, 0), 30);
const piece30 = (k2000: number) => Math.min(Math.max(k2000 - 30, 0), 95);

/** Classes from household records (a synthetic population, or reweighted survey records). */
export function aoClassesFromHouseholds(hh: AoHousehold[], minShare = 0): Float32Array {
  const acc = new Map<string, number[]>();
  const zoneHh = new Map<number, number>();
  for (const h of hh) {
    if (!(h.weight > 0)) continue;
    const drv = h.drivers >= 4 ? 3 : h.drivers === 3 ? 2 : h.drivers === 2 ? 1 : 0;
    const wk = Math.min(3, h.workers);
    const ic = h.income2024 >= INCOME_CLASS_BREAK ? 1 : 0;
    const key = `${h.zone}|${drv}|${wk}|${ic}`;
    let r = acc.get(key);
    if (!r) acc.set(key, (r = [h.zone, drv, wk, ic, 0, 0, 0, 0, 0, 0, 0, 0]));
    const w = h.weight;
    const k2000 = (h.income2024 * CPI_2000) / CPI_2024 / 1000;
    r[AO_F.hh] += w;
    r[AO_F.p16] += w * h.persons16to17;
    r[AO_F.p18] += w * h.persons18to24;
    r[AO_F.p25] += w * h.persons25to34;
    r[AO_F.kid04] += w * (h.children0to4 > 0 ? 1 : 0);
    r[AO_F.kid517] += w * (h.children5to17 > 0 ? 1 : 0);
    r[AO_F.inc0] += w * piece0(k2000);
    r[AO_F.inc30] += w * piece30(k2000);
    zoneHh.set(h.zone, (zoneHh.get(h.zone) ?? 0) + w);
  }
  // classes holding less than minShare of their zone's households are dropped, and the rest scaled
  // back up to the zone's total
  const kept = [...acc.values()].filter((r) => r[AO_F.hh] >= minShare * (zoneHh.get(r[0]) ?? 0));
  const keptHh = new Map<number, number>();
  for (const r of kept) keptHh.set(r[0], (keptHh.get(r[0]) ?? 0) + r[AO_F.hh]);
  kept.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const out = new Float32Array(kept.length * AO_STRIDE);
  kept.forEach((r, i) => {
    const n = r[AO_F.hh];
    const o = i * AO_STRIDE;
    out[o] = r[0];
    out[o + 1] = r[1];
    out[o + 2] = r[2];
    out[o + 3] = r[3];
    out[o + AO_F.hh] = (n * (zoneHh.get(r[0]) ?? n)) / (keptHh.get(r[0]) ?? n);
    for (let f = AO_F.p16; f < AO_STRIDE; f++) out[o + f] = r[f] / n;
  });
  return out;
}

/** a zone's accessibility as the car ownership model sees it */
export interface AoAccess {
  /** ln(1 + retail jobs reached, decayed) at 0.66 × peak + 0.34 × off-peak: by car, by transit */
  auto: Float32Array;
  transit: Float32Array;
  /** ln(1 + retail jobs within 3 miles round trip on foot, decayed) */
  walk: Float32Array;
  /** mean over the zone's workers' jobs (census flows) of TM1's auto time savings ratio */
  savings: Float32Array;
}

/**
 * TM1's accessibility measures for each city zone, on this run's skims: retail jobs everywhere
 * (city zones by LODES retail, outside zones by MTC's 2023 retail employment, ExtZoneAttrs.retail),
 * decayed by round-trip time. Driving: the morning out and the evening back (peak), and midday both
 * ways (off-peak), as TM1. Transit: the model's perceived minutes (in-vehicle time at its mode
 * factors, waits and walks twice, as TM1's IVT + 2 × OVT), on the same periods; a round trip without
 * transit either way counts nothing. The auto time savings to work: for each of the zone's commuter
 * flows, the round trip at midday by the quicker of transit (door to door) and walking, less the
 * round trip by car, over 120 minutes and held within ±1; averaged over the zone's commuters.
 */
export function aoAccess(b: Bundle, sk: TrnSkims): AoAccess {
  const H = b.header, A = b.a;
  const NZ = H.zones.length, NX = H.ext.length, ZT = NZ + 2 * NX;
  const au = (p: string) => A[`autoSec_${p}`] as Uint16Array;
  const auAM = au('AM'), auMD = au('MD'), auPM = au('PM');
  const xo = (p: string) => A[`extAutoOut_${p}`] as Uint16Array, xi = (p: string) => A[`extAutoIn_${p}`] as Uint16Array;
  const xoAM = xo('AM'), xoMD = xo('MD'), xiMD = xi('MD'), xiPM = xi('PM');
  const walkM = A.walkM as Uint16Array;
  const retail = new Float64Array(NZ + NX);
  H.zones.forEach((z, i) => (retail[i] = z.jobsBy[6]));
  H.ext.forEach((x, e) => (retail[NZ + e] = x.retail ?? 0));
  const gAM = sk.AM.g, gMD = sk.MD.g, gPM = sk.PM.g, tMD = sk.MD.time;
  const ka = AO_ACCESS.dispAuto, kt = AO_ACCESS.dispTransit, kw = AO_ACCESS.dispWalk, pw = AO_ACCESS.peakWeight;
  const auto = new Float32Array(NZ), transit = new Float32Array(NZ), walk = new Float32Array(NZ), savings = new Float32Array(NZ);
  // transit index of a destination: city zones as they are, outside zones at their activity end
  const tz = (d: number) => (d < NZ ? d : d + NX);
  for (let o = 0; o < NZ; o++) {
    let aPk = 0, aOp = 0, tPk = 0, tOp = 0, nm = 0;
    for (let d = 0; d < NZ + NX; d++) {
      const r = retail[d];
      if (!(r > 0)) continue;
      let pk: number, op: number;
      if (d < NZ) {
        pk = (auAM[o * NZ + d] + auPM[d * NZ + o]) / 60;
        op = (auMD[o * NZ + d] + auMD[d * NZ + o]) / 60;
        const mi = (walkM[o * NZ + d] + walkM[d * NZ + o]) / 1609.34;
        if (mi <= AO_ACCESS.maxWalkMiles) nm += r * Math.exp(kw * mi);
      } else {
        const e = d - NZ;
        pk = (xoAM[e * NZ + o] + xiPM[e * NZ + o]) / 60;
        op = (xoMD[e * NZ + o] + xiMD[e * NZ + o]) / 60;
      }
      aPk += r * Math.exp(ka * pk);
      aOp += r * Math.exp(ka * op);
      const dt = tz(d);
      const po = gAM[o * ZT + dt], pr = gPM[dt * ZT + o];
      if (Number.isFinite(po) && Number.isFinite(pr)) tPk += r * Math.exp(kt * (po + pr));
      const mo = gMD[o * ZT + dt], mr = gMD[dt * ZT + o];
      if (Number.isFinite(mo) && Number.isFinite(mr)) tOp += r * Math.exp(kt * (mo + mr));
    }
    auto[o] = pw * Math.log1p(aPk) + (1 - pw) * Math.log1p(aOp);
    transit[o] = pw * Math.log1p(tPk) + (1 - pw) * Math.log1p(tOp);
    walk[o] = Math.log1p(nm);
  }
  // work auto time savings, over the census commuter flows
  const fh = A.flowH as Int32Array, fw = A.flowW as Int32Array, fn = A.flowN as Float32Array;
  const sw = new Float64Array(NZ), sn = new Float64Array(NZ);
  const walkMin = 60 / AO_ACCESS.walkMph / 1609.34;
  for (let i = 0; i < fh.length; i++) {
    const o = fh[i], d = fw[i], n = fn[i];
    if (!(n > 0)) continue;
    let car: number, walkRT = Infinity;
    if (d < NZ) {
      car = (auMD[o * NZ + d] + auMD[d * NZ + o]) / 60;
      const m = walkM[o * NZ + d] + walkM[d * NZ + o];
      if (m > 0 || o === d) walkRT = m * walkMin;
    } else car = (xoMD[(d - NZ) * NZ + o] + xiMD[(d - NZ) * NZ + o]) / 60;
    const dt = tz(d);
    const trRT = tMD[o * ZT + dt] + tMD[dt * ZT + o];
    // no walk or transit path counts as TM1's 999 minutes each way
    const alt = Math.min(Number.isFinite(trRT) ? trRT : 1998, Number.isFinite(walkRT) ? walkRT : 1998);
    const ratio = Math.max(-1, Math.min(1, (alt - car) / 120));
    sw[o] += n * ratio;
    sn[o] += n;
  }
  for (let o = 0; o < NZ; o++) savings[o] = sn[o] > 0 ? sw[o] / sn[o] : 0;
  return { auto, transit, walk, savings };
}

/** constants fitted to the ACS (calibrate-autoown.ts), and the base run's accessibility to pivot on */
export interface AoCalibration {
  /** constants for 1, 2, 3, and 4+ cars (TM1's constants plus its San Francisco terms, refitted) */
  asc: number[];
  /** by analysis neighborhood: constants on 1 car and on 2 or more */
  nhood: Record<string, [number, number]>;
  /** the base run's accessibility by zone (AoAccess, rounded) */
  base: { auto: number[]; transit: number[]; walk: number[]; savings: number[] };
  /** the fit, for the record: share by cars [model, ACS] citywide; %RMSE by zone and neighborhood */
  fit?: {
    city: [number, number][];
    zonePctRmse: number[];
    nhoodPctRmse: number[];
    /** the same with city-wide constants only, and for TM1 as published (its constants and San Francisco terms) */
    zoneCityOnly?: number[];
    nhoodCityOnly?: number[];
    zoneTM1?: number[];
    cityTM1?: number[];
    /** %RMSE by zone that the ACS's sampling error alone gives (0, 1, 2+) */
    samplingFloor?: number[];
    /** elasticity of the city's cars with respect to every zone's transit accessibility measure (per unit of its log) */
    elasticity?: number;
  };
}

/** the TM1 density index of each zone: hh density × job density ÷ their sum (per acre) */
export function aoDensity(b: Bundle): Float32Array {
  // ZoneAttrs.densityIndex is 2 · hh · jobs / (hh + jobs) per acre (a harmonic mean); TM1's is half that
  return Float32Array.from(b.header.zones, (z) => z.densityIndex / 2);
}

/**
 * Probabilities of 0–4+ cars for every class, written into `out` (AO_ALTS per class). `nh` gives
 * each zone's neighborhood constants (1 car, 2+ cars).
 */
export function aoProbabilities(classes: Float32Array, access: AoAccess, density: Float32Array, asc: number[], nh: (zone: number) => [number, number] | undefined, out = new Float64Array((classes.length / AO_STRIDE) * AO_ALTS)): Float64Array {
  const C = TM1_AO;
  const n = classes.length / AO_STRIDE;
  const u = new Float64Array(AO_ALTS);
  for (let i = 0; i < n; i++) {
    const o = i * AO_STRIDE;
    const z = classes[o], drv = classes[o + 1], wk = classes[o + 2];
    const hasW = wk > 0 ? 1 : 0;
    const di = density[z];
    const d10 = Math.min(di, 10), dx = Math.max(0, di - 10);
    const acc = C.autoAccess[hasW] * access.auto[z] + C.transitAccess[hasW] * access.transit[z] + C.walkAccess * access.walk[z];
    const k = nh(z);
    u[0] = 0;
    let max = 0;
    for (let a = 0; a < 4; a++) {
      let v = asc[a] + acc;
      if (drv === 1) v += C.drivers2[a];
      else if (drv === 2) v += C.drivers3[a];
      else if (drv === 3) v += C.drivers4[a];
      v += C.persons16to17[a] * classes[o + AO_F.p16] + C.persons18to24[a] * classes[o + AO_F.p18] + C.persons25to34[a] * classes[o + AO_F.p25];
      v += C.children0to4[a] * classes[o + AO_F.kid04] + C.children5to17[a] * classes[o + AO_F.kid517];
      v += C.workers[a] * wk + C.income0to30[a] * classes[o + AO_F.inc0] + C.income30to125[a] * classes[o + AO_F.inc30];
      v += C.density0to10[a] * d10 + C.density10up[a] * dx;
      if (hasW) v += C.autoSavings[a] * access.savings[z];
      if (k) v += a === 0 ? k[0] : k[1];
      u[a + 1] = v;
      if (v > max) max = v;
    }
    let s = 0;
    for (let a = 0; a < AO_ALTS; a++) s += u[a] = Math.exp(u[a] - max);
    for (let a = 0; a < AO_ALTS; a++) out[i * AO_ALTS + a] = u[a] / s;
  }
  return out;
}

/** households by zone, income class, and car segment (0, 1, 2+), [zone][class][segment], and cars */
export function aoZoneShares(classes: Float32Array, prob: Float64Array, NZ: number) {
  const NC = INCOME_CLASSES.length, NS = SEGMENTS.length;
  const hh = new Float64Array(NZ * NC * NS);
  const cars = new Float64Array(NZ);
  const n = classes.length / AO_STRIDE;
  for (let i = 0; i < n; i++) {
    const o = i * AO_STRIDE;
    const z = classes[o], c = classes[o + 3], w = classes[o + AO_F.hh];
    const p = (a: number) => prob[i * AO_ALTS + a];
    const base = (z * NC + c) * NS;
    hh[base] += w * p(0);
    hh[base + 1] += w * p(1);
    hh[base + 2] += w * (p(2) + p(3) + p(4));
    cars[z] += w * (p(1) + 2 * p(2) + 3 * p(3) + 4 * p(4));
  }
  return { hh, cars };
}

const accessOf = (a: AoCalibration['base']): AoAccess => ({ auto: Float32Array.from(a.auto), transit: Float32Array.from(a.transit), walk: Float32Array.from(a.walk), savings: Float32Array.from(a.savings) });

const prepCache = new WeakMap<object, { classes: Float32Array; density: Float32Array; base: ReturnType<typeof aoZoneShares>; key: string }>();

/**
 * The long-run car segments for a scenario: each zone's households by car segment and income class
 * (Prep.segInc) moved by the ratio of the model's shares at the scenario's accessibility to its
 * shares at the base run's, within each income class; Prep.seg follows. Returns a Prep sharing
 * everything else, and the households by segment and cars the model gives (for reporting).
 */
export function longRunPrep(b: Bundle, prep: Prep, sk: TrnSkims, calib: Calibration): { prep: Prep; access: AoAccess; cars: number; carsBase: number } | null {
  const ao = calib.autoOwn;
  const classes = b.a.aoClass as Float32Array | undefined;
  if (!ao || !classes) return null;
  const NZ = prep.NZ;
  const nhoods = b.header.zones.map((z) => ao.nhood[z.nhood]);
  const nh = (z: number) => nhoods[z];
  let c = prepCache.get(b.header);
  const key = JSON.stringify(ao.asc) + JSON.stringify(ao.nhood);
  if (!c || c.key !== key) {
    const density = aoDensity(b);
    const base = aoZoneShares(classes, aoProbabilities(classes, accessOf(ao.base), density, ao.asc, nh), NZ);
    prepCache.set(b.header, (c = { classes, density, base, key }));
  }
  const access = aoAccess(b, sk);
  const scen = aoZoneShares(classes, aoProbabilities(classes, access, c.density, ao.asc, nh), NZ);
  const NC = INCOME_CLASSES.length, NS = SEGMENTS.length;
  const seg = SEGMENTS.map(() => new Float32Array(NZ));
  const segInc = SEGMENTS.map(() => INCOME_CLASSES.map(() => new Float32Array(NZ)));
  let cars = 0, carsBase = 0;
  for (let z = 0; z < NZ; z++) {
    for (let k = 0; k < NC; k++) {
      const o = (z * NC + k) * NS;
      const r = new Float64Array(NS);
      let tot = 0, tot0 = 0;
      for (let s = 0; s < NS; s++) {
        const m0 = c.base.hh[o + s], m1 = scen.hh[o + s];
        const p = prep.segInc[s][k][z];
        r[s] = m0 > 1e-9 ? (p * m1) / m0 : p;
        tot += r[s];
        tot0 += p;
      }
      for (let s = 0; s < NS; s++) {
        const v = tot > 0 ? (r[s] * tot0) / tot : prep.segInc[s][k][z];
        segInc[s][k][z] = v;
        seg[s][z] += v;
      }
    }
    carsBase += c.base.cars[z];
    cars += scen.cars[z];
  }
  return { prep: { ...prep, seg, segInc }, access, cars, carsBase };
}
