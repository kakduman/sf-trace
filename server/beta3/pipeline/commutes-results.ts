/**
 * Collects the work on the missing commute trips (October 2026) into
 * server/beta3/reference/commutes-results.json for the article and METHOD: the runs before and after
 * (experiment.ts, od-checks.ts, diag-routes.ts, diag-commutes.ts) and the evidence checked on the way
 * (the ACS's years, BATS's commute frequency and diaries, the Travel Decision Survey, the 2017 Muni
 * on-board survey; commute-checks.json from commute_checks.py).
 * Run: npx tsx server/beta3/pipeline/commutes-results.ts <dir with exp0, od0, routes0, diag0 and exp1, od1, routes1, diag1 .json>
 */
import fs from 'node:fs';
import { REFERENCE } from './paths';
import { eraShift, purposeMix, shiftShare } from './od-checks';
import { residentLinkedShares } from './resident-targets';

const [dir] = process.argv.slice(2);
const read = (f: string) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
const has = (f: string) => fs.existsSync(`${dir}/${f}`);
const ref = (f: string) => JSON.parse(fs.readFileSync(`${REFERENCE}/${f}`, 'utf8'));
const FOCUS = ['T', '14', '14R', '49', '8', 'N', 'J', 'K', 'L', 'M', '38R', '22'];
const scaledRmse = (rs: { obs: number; mod: number }[]) => {
  const k = rs.reduce((a, r) => a + r.obs, 0) / rs.reduce((a, r) => a + r.mod, 0);
  const mo = rs.reduce((a, r) => a + r.obs, 0) / rs.length;
  return (100 * Math.sqrt(rs.reduce((a, r) => a + (k * r.mod - r.obs) ** 2, 0) / rs.length)) / mo;
};
const shift = eraShift(ref('acs-commute-era.json'));
const bats = residentLinkedShares(ref('sf-mode-by-area.json'));

type Row = { purpose: string; observed: number; model: number; modelSchoolDay: number; modelByTour: number; modelSurveyed: number; modelSurveyedByTour: number };
type Riders = { purposeMuniLightRail: Row[]; purposeMuniBus: Row[]; boardingsByMarket: Record<string, { lightRail: number; bus: number; t: number; byPeriod?: Record<string, number> }> };
type Diag = {
  commuters: { residentsAtWork: number; residentsAtWorkOutside: number; residentTransitShare: number; inCommutersAtWork: number; inCommuterTransitShare: number; residentTrips: number; inCommuterTrips: number };
  byPurpose: Record<string, Record<string, number>>;
  residentTrips: Record<string, number>;
  stopTransitByPurpose: Record<string, number>;
  transitByMarket: Record<string, Record<string, number>>;
  riders: Riders;
};

const side = (k: '0' | '1') => {
  const e = has(`exp${k}.json`) ? read(`exp${k}.json`) : null;
  const o = has(`od${k}.json`) ? read(`od${k}.json`) : null;
  const d: Diag | null = has(`diag${k}.json`) ? read(`diag${k}.json`) : null;
  const out: Record<string, unknown> = {};
  if (e) {
    const am = e.bartAm as { code: string; obs: number; mod: number }[];
    Object.assign(out, {
      muniRoutes: { r: e.muni.r, pctRmse: e.muni.pctRmse, pctRmseScaled: scaledRmse(e.routes), model: Math.round(e.muni.model), observed: e.muni.observed, within25: e.muni.within25 },
      routes: Object.fromEntries(FOCUS.map((r) => [r, (() => { const x = (e.routes as { route: string; obs: number; mod: number }[]).find((y) => y.route === r); return x ? { observed: x.obs, model: Math.round(x.mod) } : null; })()])),
      bartCityExits: { r: e.bart.r, pctRmse: e.bart.pctRmse, total: e.bart.total },
      bartAmDowntown: { model: Math.round(am.reduce((a, x) => a + x.mod, 0)), count: am.reduce((a, x) => a + x.obs, 0), stations: am.map((x) => ({ code: x.code, observed: x.obs, model: Math.round(x.mod) })) },
      caltrainArrivalsAM: { model: e.caltrainDirection.arrivalsAM[0], observed: e.caltrainDirection.arrivalsAM[1] },
      residentShares: e.residentShares,
      residentTrips: e.residentTrips,
      muniTimeOfDay: e.tod.muni,
      calib: e.calib,
    });
  }
  if (o?.commute) {
    const c = o.commute, dt = c.byDistrict.find((x: { district: string }) => x.district === 'Downtown');
    out.commute = {
      observed: c.totalTransitShare.observed, observed2024: shiftShare(c.totalTransitShare.observed, shift), model: c.totalTransitShare.model,
      downtown: { observed: dt.observedTransitShare, observed2024: shiftShare(dt.observedTransitShare, shift), model: dt.modelTransitShare, observedShareOfCommuters: dt.observedShareOfCommuters, modelShareOfCommuters: dt.modelShareOfCommuters },
    };
  }
  if (d) {
    const m = d.riders.boardingsByMarket;
    const tot = Object.values(m).reduce((a, v) => a + v.lightRail + v.bus, 0);
    const sumP = (r: Record<string, number>) => Object.values(r).reduce((a, v) => a + v, 0);
    // residents' transit trips, and those that are work trips as the Snapshot and the Travel Decision
    // Survey read them (to work or home from it; stop legs by their share going to work)
    const tm = d.transitByMarket;
    let res = 0, resWork = 0;
    const stopT = d.stopTransitByPurpose;
    for (const [k, byP] of Object.entries(tm)) {
      if (!k.startsWith('resident')) continue;
      const n = sumP(byP);
      res += n;
      resWork += n * (purposeMix(k, stopT, 'trip').Work ?? 0);
    }
    const work = d.byPurpose.work;
    Object.assign(out, {
      commuters: d.commuters,
      residentTransitTrips: res,
      residentWorkShareOfTransitTrips: resWork / res,
      workTrips: sumP(work),
      workTransitTrips: work.transit,
      muniBoardings: Math.round(tot),
      muniWorkBoardings: {
        residentsDirect: Math.round(['resident work', 'resident work return'].reduce((a, k) => a + (m[k] ? m[k].lightRail + m[k].bus : 0), 0)),
        inCommuters: Math.round(m['in-commuters'] ? m['in-commuters'].lightRail + m['in-commuters'].bus : 0),
        stopLegs: Math.round(m['resident stop legs'] ? m['resident stop legs'].lightRail + m['resident stop legs'].bus : 0),
      },
      muniNightShare: Object.values(m).reduce((a, v) => a + (v.byPeriod?.NT ?? 0), 0) / tot,
      purposeBus: d.riders.purposeMuniBus,
      purposeLightRail: d.riders.purposeMuniLightRail,
    });
  }
  if (has(`routes${k}.json`)) out.routeGroups = (read(`routes${k}.json`) as { group: string; counted: number; model: number }[]).map((g) => ({ group: g.group, counted: g.counted, model: g.model }));
  return out;
};

const acs = ref('acs-commute.json');
const a24 = acs.acs1yr2024;
const pumsIn = (() => {
  const t = ref('commute-by-county.json').toSF as Record<string, { total: number; wfh: number; transit: number }>;
  let n = 0, tr = 0;
  for (const [c, r] of Object.entries(t)) if (c !== 'San Francisco') (n += r.total - r.wfh), (tr += r.transit);
  return tr / n;
})();
const out = {
  description: "The missing commute trips (October 2026). Before: the model of muniarea-results.json's 'after' (transit tours' stop legs with constants of their own, six-iteration weekday calibration). After: residents' commutes leaving the city, in-commuters, and their transit shares on the ACS 2024 1-year tables (build.ts commuteSplit, calibrate.ts), on an eight-iteration weekday calibration from it. Experiment runs: two passes from the base run's crowding. Riders by market: each market assigned alone at the base crowding (od-checks.ts riders, diag-commutes.ts).",
  generated: new Date().toISOString().slice(0, 10),
  evidence: {
    acs: {
      fiveYear: {
        inCommuters: acs.workersWorkingInSF_B08604.totalWorkersAtSFWorkplaces - acs.residentsPlaceOfWork_B08007.workedInSFCounty.count,
        // as the model used it: the 5-year count working in the city, less 2024's working from home
        outShare: acs.residentsPlaceOfWork_B08007.workedOutsideSFCountyInCalifornia.count / (acs.residentsPlaceOfWork_B08007.workedOutsideSFCountyInCalifornia.count + acs.residentsPlaceOfWork_B08007.workedInSFCounty.count - (acs.residentsCommuteMode_B08301_ACS1yr2024.totalWorkers16plus - acs.residentsCommuteMode_B08301_ACS1yr2024.commutersExclWFH)),
        inTransitTarget: 0.31,
        inTransitPums: pumsIn,
        wfhResidents: acs.residentsCommuteMode_B08301.totalWorkers16plus - acs.residentsCommuteMode_B08301.commutersExclWFH,
      },
      oneYear2024: {
        inCommuters: a24.inCommuters.total,
        outShare: a24.residentsByPlaceOfWork_B08130.outShareOfCommuters,
        commutersOutside: a24.residentsByPlaceOfWork_B08130.commutersOutsideSF,
        commutersInside: a24.residentsByPlaceOfWork_B08130.commutersInSF,
        inTransit: a24.inCommuters.modes.transit / (a24.inCommuters.total - a24.inCommuters.modes.walk - a24.inCommuters.modes.other * (1 - 4017 / 6793)),
        outTransit: a24.residentsByPlaceOfWork_B08130.modesOutsideSF.transit / a24.residentsByPlaceOfWork_B08130.commutersOutsideSF,
        wfhResidents: a24.residentsByPlaceOfWork_B08130.workedFromHome,
        workersResidents: a24.residentsByPlaceOfWork_B08130.totalWorkers16plus,
        workplaceCommuters: a24.workersAtSFWorkplaces_B08604.commutersExclWFH,
      },
    },
    checks: ref('commute-checks.json'),
    commuteDays: ref('commute-days.json'),
    batsResidents: bats,
  },
  before: side('0'),
  after: side('1'),
};
fs.writeFileSync(`${REFERENCE}/commutes-results.json`, JSON.stringify(out, null, 1));
console.log(`written ${REFERENCE}/commutes-results.json`);
