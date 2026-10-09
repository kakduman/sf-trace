import { REF, V, VX } from '../data';
import { SCHOOL_DAY } from '../../../../shared/beta3/params';
import { muniLevel } from './calibration';
import { commutesWork } from './commutes';
import { hotelVisitors } from './metro';
import { underreportWork } from './muniarea';
import { shortTrips } from './shorttrips';
import { cite, fx, int, nw, pc, sec, section, spc, tab, table } from '../doc';

type PRow = { purpose: string; observed: number; model: number; modelSchoolDay?: number; modelSurveyedByTour?: number };
const PURPOSE: Record<string, string> = { Work: 'work', School: 'school and college', 'Social/Recreation/Shopping': 'social, recreation, and shopping', 'Other Purposes': 'other purposes' };

/** Muni riders' purposes: the current validation's (od-checks.ts), else the commute check's run read as surveyed */
function purposes(): { bus: PRow[]; lr: PRow[]; surveyed: boolean } | null {
  const R = VX.od?.riders;
  if (R?.purposeMuniBus?.length) return { bus: R.purposeMuniBus, lr: R.purposeMuniLightRail, surveyed: false };
  const A = (REF.commutesResults as unknown as { after?: { purposeBus?: PRow[]; purposeLightRail?: PRow[] } }).after;
  return A?.purposeBus?.length && A.purposeLightRail?.length ? { bus: A.purposeBus, lr: A.purposeLightRail, surveyed: true } : null;
}
/** the work share of Muni's riders, [model, survey], buses and light rail (for the text and Limitations) */
export function workShare(): { bus: [number, number]; lightRail: [number, number] } | null {
  const P = purposes();
  const w = (rs: PRow[]) => rs.find((r) => r.purpose === 'Work');
  const b = P && w(P.bus), l = P && w(P.lr);
  if (!P || !b || !l) return null;
  const m = (r: PRow) => (P.surveyed ? r.modelSurveyedByTour ?? r.model : r.model);
  return { bus: [m(b), b.observed], lightRail: [m(l), l.observed] };
}

/** the T Third's riders in the model, for the route misses (od-checks.ts) */
export function tThird(): string {
  const tT = VX.od?.riders?.tThird;
  if (!tT) return '';
  const endOf = (d: string) => tT.tripEndsByDistrict.find((x) => x.district === d)?.daily ?? 0;
  return ` No stop-level or origin–destination data on the T are published. In the model its riders are mostly not Bayview residents: ${pc(endOf('Downtown'))} of their trips end downtown, ${pc(endOf('Mission Bay–Potrero'))} in Mission Bay and Potrero Hill, ${pc(endOf('Outside the city (home end)'))} outside the city (Caltrain riders changing at 4th and King), and only ${pc(endOf('Bayview–Hunters Point'))} in Bayview–Hunters Point, and its Central Subway stations board ${int(tT.byStop.filter((s) => /Chinatown|Union Square|Yerba Buena/.test(s.stop)).reduce((a, s) => a + s.boardings, 0))} riders against about 9,500 that SFMTA reported in early 2025. The deficit is on both parts of the line.`;
}

/** Section 5: travel markets, origin to destination, and who rides (od-checks.ts) */
export function markets(): string {
  const O = VX.od;
  const B = O?.bart ?? null, C = O?.commute ?? null, I = O?.inCommuters ?? null, R = O?.riders ?? null;
  const MBR = muniLevel();
  const MA = (REF.muniareaResults as unknown as { evidence?: { snapshot?: { lightRail: { n: number }; bus: { n: number } } }; after?: { commute?: { observed: number; observed2024: number; model: number; downtown: { observed2024: number; model: number } } } });
  const snapN = MA.evidence?.snapshot, ctpp24 = MA.after?.commute;
  const P = purposes(), WS = workShare();
  const tb = R?.transfersBefore;
  const bs = R?.bartStations ?? [];
  const bartPara = B ? (() => {
    const g = (name: string, dir: string) => B.byGroup.find((r) => r.key === `${name}|${dir}`);
    const both = (name: string) => {
      const t = g(name, 'toCity'), f = g(name, 'fromCity');
      return { observed: (t?.observed ?? 0) + (f?.observed ?? 0), model: (t?.model ?? 0) + (f?.model ?? 0) };
    };
    const sum = (xs: { observed: number; model: number }[]) => xs.reduce((a, x) => ({ observed: a.observed + x.observed, model: a.model + x.model }), { observed: 0, model: 0 });
    const inn = sum(['Oakland & Berkeley', 'Richmond line'].map(both)), out = sum(['Fremont–Berryessa line', 'Dublin line', 'Concord–Antioch line'].map(both));
    const pp = B.perPeriod;
    return `<p>BART's fare gates record every journey from entry to exit, and the model's journeys between the same stations are recovered exactly from its assignment. Across the ${nw(B.daily.n)} cells of ${tab('bart-od')} (each city station against each group of outside stations, by direction, and journeys within the city), the correlation was ${fx(B.daily.r, 2)} and the %RMSE ${fx(B.daily.pctRmse, 0)}%, with the total ${spc(B.daily.totalRatio - 1, 0)}; toward the city in the morning peak the correlation was ${fx(pp.toCityAM.r, 2)}, and the reverse commute fits worse (${fx(pp.fromCityAM.r, 2)} from the city in the morning). Journeys to and from Oakland, Berkeley, and the Richmond line are ${spc(inn.model / inn.observed - 1, 0)} against the counts, and those to and from the Fremont, Dublin, and Concord lines ${spc(out.model / out.observed - 1, 0)}. Oakland's and Berkeley's riders to the city also travel for leisure, school, and visits, which the model carries only as regional visitors spread by population.</p>
${table(
  'bart-od',
  "BART journeys on an average weekday between the city's eight stations and groups of stations outside it: model against BART's counts.",
  ['Other end', 'To the city, counted', 'Modeled', 'From the city, counted', 'Modeled'],
  B.kinds.map((k) => k.group).map((name) => {
    const t = g(name, 'toCity')!, f = g(name, 'fromCity');
    return [name, int(t.observed), `${int(t.model)} (${spc(t.model / t.observed - 1, 0)})`, f ? int(f.observed) : '–', f ? `${int(f.model)} (${spc(f.model / f.observed - 1, 0)})` : '–'];
  }),
  { numeric: [1, 2, 3, 4], notes: `Counted: BART's August 2026 average-weekday station-to-station matrix ${cite('bartRidership')}. Modeled: journeys without a change of train. Within the city, each journey is counted once, at its exit station. Daly City is outside the city.` },
)}`;
  })() : '';
  const commutePara = C || I ? `<p>${I ? `The ACS microdata give commuters to San Francisco by home PUMA ${cite('acsPums')}; across the ${nw(I.distribution.n)} PUMAs of the other Bay Area counties with at least 1,000 of them, the model's share of in-commuters from each correlates with the ACS at r = ${fx(I.distribution.r, 2)}, a test of where they live, which comes from the census commuting flows (their transit share by PUMA is a calibration target). ` : ''}${C ? `The CTPP 2017–2021 tabulates workers by the tract where they work and how they get there ${cite('ctpp2021')}. The model's commute constants are fitted by where commuters live, never by where they work, so the transit share by workplace tests destination and mode choice together: across the ${nw(C.districtTransit.n)} districts it correlates at ${fx(C.districtTransit.r, 2)}, and across the ${nw(C.tracts.transit.n)} tracts with at least 2,000 commuters at ${fx(C.tracts.transit.r, 2)}. ` : ''}${ctpp24 ? `The CTPP pools years before and during the pandemic; moved to 2024 by the change in the ACS's workplace transit share for the whole city ${cite('acsEra')}, its ${pc(ctpp24.observed, 1)} of commuters to the city's jobs arriving by transit becomes ${pc(ctpp24.observed2024, 1)}, against the model's ${pc(ctpp24.model, 1)}, and downtown's becomes ${pc(ctpp24.downtown.observed2024, 1)}, against ${pc(ctpp24.downtown.model, 1)}.` : ''}</p>` : '';
  const ridersPara = `<p>Who rides Muni. ${R ? `MTC's 2023–24 Snapshot survey ${cite('mtcSnapshot')} found ${pc(R.residentShare.lightRail.observed ?? 0)} of light rail riders and ${pc(R.residentShare.bus.observed ?? 0)} of bus riders living in San Francisco; in the model, ${pc(R.residentShare.lightRail.model)} and ${pc(R.residentShare.bus.model)} of the boardings are residents'. ` : ''}${MBR ? `Calibration fits residents' and non-residents' boardings on the counted routes apart (${sec('calib-targets')}): residents make ${int(MBR.residents[0])} against a target of ${int(MBR.residents[1])} (${spc(MBR.residents[0] / MBR.residents[1] - 1, 0)}), and non-residents ${int(MBR.nonResidents[0])} against ${int(MBR.nonResidents[1])} (${spc(MBR.nonResidents[0] / MBR.nonResidents[1] - 1, 0)}). ` : ''}${P && WS ? `Work trips are ${pc(WS.bus[1])} of bus riders' trips and ${pc(WS.lightRail[1])} of light rail riders' in the survey, against ${pc(WS.bus[0])} and ${pc(WS.lightRail[0])} in the model${P.surveyed ? ', read as the survey asked (the main purpose of the trip, with a stop on a tour given the tour\'s purpose, over the surveyed hours on a school day)' : ''}; social, recreation, and shopping trips are correspondingly too many. ${snapN ? `The survey's shares are those of ${int(snapN.bus.n)} bus and ${int(snapN.lightRail.n)} light rail questionnaires without expansion by route or time of day ${cite('mtcSnapshotDeck')}, so the gap is uncertain, but it is large. ` : ''}` : ''}${R ? (() => {
    const lrS = R.purposeMuniLightRail.find((r) => r.purpose === 'School'), busS = R.purposeMuniBus.find((r) => r.purpose === 'School');
    return lrS && busS ? `School and college trips are ${pc(lrS.observed)} and ${pc(busS.observed)} of light rail and bus riders' trips in the survey, taken while schools were in session, against ${pc(lrS.modelSchoolDay ?? lrS.model)} and ${pc(busS.modelSchoolDay ?? busS.model)} in the model on a school day (${fx(SCHOOL_DAY.k12, 2)} times the year's average K–12 trips). ` : '';
  })() : ''}${tb?.system.observed ? `The 2017 Muni on-board survey implies that about ${pc(tb.system.observed)} of boardings follow another vehicle on the same trip ${cite('muniObs2017')}, a calibration target (the model has ${pc(tb.system.model)})${tb.system.observedByOperator && tb.system.modelFromMuni !== undefined ? `; by the vehicle before, the survey splits it into ${pc(tb.system.observedByOperator.muni)} after another Muni line, ${pc(tb.system.observedByOperator.bart)} after BART, and ${pc(tb.system.observedByOperator.caltrain)} after Caltrain ${cite('mtcDecomposition')}, against ${pc(tb.system.modelFromMuni)}, ${pc(tb.system.modelFromBart)}, and ${pc(tb.system.modelFromCaltrain)} in the model, which the split is not fitted to` : ''}. ` : ''}${hotelVisitors()}</p>`;
  const ridersTable = R ? table(
    'riders',
    'Who rides, and how they reach the train: model against on-board surveys, average weekday.',
    ['Measure', 'Survey', 'Model'],
    [
      ['Muni light rail riders living in the city', R.residentShare.lightRail.observed != null ? pc(R.residentShare.lightRail.observed) : '–', pc(R.residentShare.lightRail.model)],
      ['Muni bus riders living in the city', R.residentShare.bus.observed != null ? pc(R.residentShare.bus.observed) : '–', pc(R.residentShare.bus.model)],
      ...R.purposeMuniLightRail.map((r) => [`Muni light rail: ${(PURPOSE[r.purpose] ?? r.purpose.toLowerCase())} trips`, pc(r.observed), pc(r.model)]),
      ...R.purposeMuniBus.map((r) => [`Muni buses: ${(PURPOSE[r.purpose] ?? r.purpose.toLowerCase())} trips`, pc(r.observed), pc(r.model)]),
      ...(tb?.system.observed ? [['Muni boardings after another vehicle (2017, derived)', pc(tb.system.observed), pc(tb.system.model)]] : []),
      ...bs.map((s) => [`BART ${s.code}: entries from home`, s.homeOriginShare.observed != null ? pc(s.homeOriginShare.observed) : '–', pc(s.homeOriginShare.model)]),
    ],
    { numeric: [1, 2], notes: `Surveys: MTC 2023–24 Snapshot ${cite('mtcSnapshot')} (residence and purpose; school includes college), 2017 Muni on-board survey ${cite('muniObs2017')}, BART 2024 station profile ${cite('bartProfile2024')}. Model purposes: the purpose of a trip's end away from home, as in the survey.` },
  ) : '';
  return section('val-markets', 'Travel markets', `
<p>Boardings by route and station can be matched with the wrong riders: too many from one place making up for too few from another, or too many changes of vehicle making up for too few trips. Transit forecasting practice therefore checks the markets a model carries, origin to destination, normally against on-board surveys ${cite(['stopsGuide', '§2.3'])}. None of the data below was used in calibration except where stated.</p>
${bartPara}
${commutePara}
${ridersPara}
${ridersTable}
${commutesWork()}
${shortTrips()}
${underreportWork()}
`);
}

/** the downtown BART stations' exits, model over count (validation.json), for the text and Limitations */
export function bartDowntown(): { name: string; code: string; ratio: number }[] {
  return V.bart.wkd.exits.filter((e) => ['EMBR', 'MONT', 'POWL', 'CIVC'].includes(e.code)).map((e) => ({ name: e.name, code: e.code, ratio: e.model / e.observed }));
}
