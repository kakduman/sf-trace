/**
 * Collects the work on Muni's misses near home and its riders from outside the city (October 2026)
 * into server/beta3/reference/muniarea-results.json for the article and METHOD: the runs before and
 * after (experiment.ts, od-checks.ts, diag-routes.ts) and the evidence checked on the way (population
 * by neighborhood, ACS 2020–24 against the 2020 Census; the CTPP's year; who the Snapshot surveyed).
 * Run: npx tsx server/beta3/pipeline/muniarea-results.ts <dir with exp0, od0, routes0 and exp1, od1, routes1 .json> [calibration log]
 * (the log's first iteration gives the transit tours' trips back and stop legs on the model before,
 * whose experiment run predates their tally)
 */
import fs from 'node:fs';
import { RAW, REFERENCE, WORK } from './paths';
import { eraShift, shiftShare } from './od-checks';
import { residentLinkedShares } from './resident-targets';

const [dir, clog] = process.argv.slice(2);
const read = (f: string) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
const has = (f: string) => fs.existsSync(`${dir}/${f}`);
const FOCUS = ['T', '14', '14R', '49', '8', '8AX', '8BX', '9', '9R', '30', '45', '28', '29', '54', '38', '38R', '1', '5', '5R', 'N', 'J', 'K', 'L', 'M'];
const scaledRmse = (rs: { obs: number; mod: number }[]) => {
  const k = rs.reduce((a, r) => a + r.obs, 0) / rs.reduce((a, r) => a + r.mod, 0);
  const mo = rs.reduce((a, r) => a + r.obs, 0) / rs.length;
  return (100 * Math.sqrt(rs.reduce((a, r) => a + (k * r.mod - r.obs) ** 2, 0) / rs.length)) / mo;
};
const era = JSON.parse(fs.readFileSync(`${REFERENCE}/acs-commute-era.json`, 'utf8'));
const shift = eraShift(era);
const snap = JSON.parse(fs.readFileSync(`${REFERENCE}/od-validation.json`, 'utf8')).snapshot;
const modeByArea = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-mode-by-area.json`, 'utf8'));
const bats = residentLinkedShares(modeByArea);

type Exp = {
  muni: { r: number; pctRmse: number; model: number; observed: number; within25: number };
  bart: { r: number; pctRmse: number; total: number; stations: { code: string; obs: number; mod: number }[] };
  routes: { route: string; obs: number; mod: number }[];
  residentShares: Record<string, number>;
  tripMixBack?: Record<string, Record<string, number>>;
  tripMixStop?: Record<string, Record<string, number>>;
  tripMixTour: Record<string, Record<string, number>>;
  tripMiles: { bus: number; metro: number };
};
type Od = {
  riders: { purposeMuniLightRail: { purpose: string; observed: number; model: number; modelByTour: number }[]; purposeMuniBus: { purpose: string; observed: number; model: number; modelByTour: number }[]; boardingsByMarket: Record<string, { lightRail: number; bus: number; t: number }> };
  commute: { totalTransitShare: { observed: number; model: number }; byDistrict: { district: string; observedTransitShare: number; modelTransitShare: number }[] } | null;
};
type Group = { group: string; counted: number; model: number; byStopDistrict: { district: string; model: number; tep2006Scaled: number | null }[]; byMarket: { market: string; boardings: number }[] };

const exp = (e: Exp) => ({
  muniRoutes: { r: e.muni.r, pctRmse: e.muni.pctRmse, pctRmseScaled: scaledRmse(e.routes), model: Math.round(e.muni.model), observed: e.muni.observed, within25: e.muni.within25 },
  bartCityExits: { r: e.bart.r, pctRmse: e.bart.pctRmse, total: e.bart.total, stations: e.bart.stations.map((s) => ({ code: s.code, observed: s.obs, model: Math.round(s.mod) })) },
  routes: Object.fromEntries(FOCUS.map((r) => [r, (() => { const x = e.routes.find((y) => y.route === r); return x ? { observed: x.obs, model: Math.round(x.mod) } : null; })()])),
  residentShares: e.residentShares,
  // transit tours' trips back and stop legs (the NHTS's 81.1% and 28.4% by transit)
  transitTourBack: e.tripMixBack?.transit ?? null,
  transitTourStops: e.tripMixStop?.transit ?? null,
  transitTourOther: e.tripMixTour.transit,
  tripMiles: e.tripMiles,
});
/**
 * Muni's boardings by market (each market assigned alone at the base crowding): Bay Area residents
 * living outside the city are the in-commuters (their commutes and their trips during the day, the
 * 'nhb' market, which holds only theirs since hotel visitors' trips choose on their own), the regional
 * visitors, and college students living outside the city ('univ'); special-event crowds mix residents,
 * hotel guests, and the region, so they are left out of both sides
 */
const riders = (o: Od) => {
  const m = o.riders.boardingsByMarket;
  const tot = Object.values(m).reduce((a, v) => a + v.lightRail + v.bus, 0);
  const share = (f: (k: string) => boolean) => Object.entries(m).filter(([k]) => f(k)).reduce((a, [, v]) => a + v.lightRail + v.bus, 0) / tot;
  return {
    muniBoardings: Math.round(tot),
    residents: share((k) => k.startsWith('resident')),
    bayAreaNonResidents: share((k) => ['in-commuters', 'nhb', 'regional', 'univ'].includes(k)),
    bayAreaNonResidentsOld: share((k) => ['in-commuters', 'regional'].includes(k)),
    byMarket: Object.fromEntries(['in-commuters', 'nhb', 'regional', 'univ', 'visitor', 'airport', 'event', 'resident stop legs', 'resident subtours'].map((k) => [k, share((x) => x === k)])),
    purposeBus: o.riders.purposeMuniBus,
    purposeLightRail: o.riders.purposeMuniLightRail,
  };
};
const commute = (o: Od) => {
  const c = o.commute;
  if (!c) return null;
  const dt = c.byDistrict.find((x) => x.district === 'Downtown')!;
  return {
    observed: c.totalTransitShare.observed,
    observed2024: shiftShare(c.totalTransitShare.observed, shift),
    model: c.totalTransitShare.model,
    downtown: { observed: dt.observedTransitShare, observed2024: shiftShare(dt.observedTransitShare, shift), model: dt.modelTransitShare },
  };
};
const groups = (g: Group[]) => g.map((x) => ({ group: x.group, counted: x.counted, model: x.model, byStopDistrict: x.byStopDistrict, topMarkets: x.byMarket.slice(0, 6) }));
/** transit tours' trips back and stop legs by mode at the start of the calibration (its first iteration's fit) */
const atStart = (() => {
  if (!clog || !fs.existsSync(clog)) return null;
  const line = fs.readFileSync(clog, 'utf8').split('\n').find((l) => l.startsWith('iter 1:'));
  if (!line) return null;
  const part = (from: string, to: string) => line.slice(line.indexOf(from), line.indexOf(to, line.indexOf(from)));
  const mix = (seg: string) => {
    const m: Record<string, number> = {};
    for (const x of seg.matchAll(/transit>(walk|tnc|sr) ([\d.]+)\//g)) m[x[1]] = Number(x[2]) / 100;
    m.transit = 1 - Object.values(m).reduce((a, v) => a + v, 0);
    return m;
  };
  return { back: mix(part('trips by tour mode', '| stop legs')), stops: mix(part('| stop legs', '| by mode in')) };
})();
const side = (k: '0' | '1') => ({
  ...(has(`exp${k}.json`) ? exp(read(`exp${k}.json`)) : {}),
  riders: has(`od${k}.json`) ? riders(read(`od${k}.json`)) : null,
  commute: has(`od${k}.json`) ? commute(read(`od${k}.json`)) : null,
  routeGroups: has(`routes${k}.json`) ? groups(read(`routes${k}.json`)) : null,
  ...(k === '0' && atStart ? { transitTourBack: atStart.back, transitTourStops: atStart.stops } : {}),
});

// ---- evidence: population by neighborhood, ACS 2020–24 (the model's) against the 2020 Census ----
const population = (() => {
  const zf = `${WORK}/zones.json`, bf = `${RAW}/census/blocks2020.json`;
  if (!fs.existsSync(zf) || !fs.existsSync(bf)) return null;
  const zones = JSON.parse(fs.readFileSync(zf, 'utf8')).internal as { id: string; nhood: string; pop: number }[];
  const c20 = new Map<string, number>();
  for (const b of JSON.parse(fs.readFileSync(bf, 'utf8')) as { GEOID: string; POP100: number }[]) c20.set(b.GEOID.slice(0, 12), (c20.get(b.GEOID.slice(0, 12)) ?? 0) + b.POP100);
  const by = new Map<string, { acs: number; census2020: number }>();
  for (const z of zones) {
    const e = by.get(z.nhood) ?? { acs: 0, census2020: 0 };
    e.acs += z.pop;
    e.census2020 += c20.get(z.id) ?? 0;
    by.set(z.nhood, e);
  }
  const acs = zones.reduce((a, z) => a + z.pop, 0), census2020 = [...by.values()].reduce((a, v) => a + v.census2020, 0);
  const k = acs / census2020;
  const pick = ['Mission', 'Excelsior', 'Outer Mission', 'Visitacion Valley', 'Bayview Hunters Point', 'Portola', 'Chinatown', 'Tenderloin'];
  return { acs, census2020, byNeighborhood: Object.fromEntries(pick.map((n) => [n, { ...by.get(n)!, relative: by.get(n)!.acs / by.get(n)!.census2020 / k }])) };
})();

const flatWeight = (op: string) => {
  const rows = snap[op];
  return { n: rows.n.home_county as number };
};
const out = {
  description: "Muni's misses near home and its riders from outside the city (October 2026). Before: the integration model on its own calibration. After: transit tours' trips back and stop legs with constants of their own (params.ts TRIP_SWITCH_STOP), on a six-iteration weekday calibration from it. Experiment runs: two passes from the base run's crowding. Riders by market: each market assigned alone at the base crowding (od-checks.ts). Route groups by the district of the stop: diag-routes.ts against SFMTA's 2006–07 stop counts scaled to today's route totals.",
  generated: new Date().toISOString().slice(0, 10),
  evidence: {
    population,
    acsEra: { shift, byWorkplace: era.byWorkplace, byResidence: era.byResidence },
    snapshot: {
      note: "MTC's dashboard gives each Muni respondent the same weight (one per 286 weekday boardings, light rail and buses alike), so its Muni shares are those of the sample: no expansion by route or time of day. Paper questionnaires in English, Spanish, and Chinese (MTC, March 2025).",
      lightRail: { ...flatWeight('SFMTA (Muni) -- Light Rail'), otherBayArea: Object.entries(snap['SFMTA (Muni) -- Light Rail'].home_county as Record<string, number>).filter(([c]) => c !== 'San Francisco' && c !== 'Outside Bay Area').reduce((a, [, v]) => a + v, 0) },
      bus: { ...flatWeight('SFMTA (Muni) -- Local Bus'), otherBayArea: Object.entries(snap['SFMTA (Muni) -- Local Bus'].home_county as Record<string, number>).filter(([c]) => c !== 'San Francisco' && c !== 'Outside Bay Area').reduce((a, [, v]) => a + v, 0) },
    },
    batsResidents: bats,
    // the NHTS's transit tours: trips back and stop legs by transit, raw and over the modes a transit
    // tour's trips may use in the model (transit, walking, ride-hail, a ride; TRIP_SWITCH)
    nhtsTransitTours: (() => {
      const t = JSON.parse(fs.readFileSync(`${REFERENCE}/nhts-tripmode.json`, 'utf8')).byTourMode.transit;
      const over = (x: Record<string, number>) => x.transit / ['transit', 'walk', 'tnc', 'sr'].reduce((a, m) => a + (x[m] ?? 0), 0);
      return { back: t.returnLeg.transit, stops: t.stopLegs.transit, stopsWalk: t.stopLegs.walk, backAllowed: over(t.returnLeg), stopsAllowed: over(t.stopLegs), tours: t.tours_sample, stopLegs: t.stopLegs_sample };
    })(),
  },
  before: side('0'),
  after: side('1'),
};
fs.writeFileSync(`${REFERENCE}/muniarea-results.json`, JSON.stringify(out, null, 1));
console.log(`written ${REFERENCE}/muniarea-results.json`);
