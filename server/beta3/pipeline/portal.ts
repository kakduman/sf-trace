/**
 * Case study: The Portal (Caltrain Downtown Rail Extension) as a scenario, compared with the
 * official forecasts recorded in server/beta3/reference/portal.json.
 *
 * Representation: every Caltrain train continues past the surface 4th & King station through the
 * tunnel, stopping at a new underground 4th & Townsend station and ending at the Salesforce Transit
 * Center (the TJPA/FTA forecast assumes 4 of 6 peak trains per hour per direction; running all of
 * them is noted as a difference). Extended trains no longer call at surface 4th & King.
 * Run times are not published: 60 s from 4th & King to 4th & Townsend (the stations are ~100 m
 * apart; the surface stop's lost time is saved) and 180 s for the 1.3 mi to the Transit Center
 * (about 30 mph with acceleration and braking). Station positions: OSM (portal.json).
 *
 * Writes client/beta3/model/portal-scenario.json (the edit list the app's example uses) and
 * server/beta3/reference/portal-results.json (+ a copy for the article).
 * Run: NODE_OPTIONS=--max-old-space-size=3072 npx tsx server/beta3/pipeline/portal.ts [--scenario-only]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalExecutor, prepare, runModel } from '../../../shared/beta3/model';
import { decodeResult } from '../../../shared/beta3/results';
import type { Edit, Scenario } from '../../../shared/beta3/types';
import { BUNDLE, REFERENCE } from './paths';
import { loadBundle } from './run-base';

const TOWNSEND = { lat: 37.7770727, lon: -122.3950705, name: '4th & Townsend (underground)' };
const TRANSIT_CENTER = { lat: 37.7891641, lon: -122.3967838, name: 'Salesforce Transit Center' };

async function main() {
  const b = loadBundle();
  const H = b.header;
  const sf = H.stops.findIndex((s) => s.feed === 'caltrain' && /^San Francisco/.test(s.name));
  if (sf < 0) throw new Error('Caltrain San Francisco station not found');
  const routes = [...new Set(H.lines.filter((l) => l.feed === 'caltrain' && (l.stops[0] === sf || l.stops[l.stops.length - 1] === sf)).map((l) => l.route))];
  const edits: Edit[] = [];
  for (const route of routes) edits.push({ kind: 'extend', id: `portal-${route}`, route, feed: 'caltrain', from: sf, stops: [TOWNSEND, TRANSIT_CENTER], hops: [60, 180] });
  for (const route of routes) edits.push({ kind: 'removeStop', route, feed: 'caltrain', stop: sf });
  const scenario: Scenario = { name: 'The Portal: Caltrain to the Salesforce Transit Center', edits };
  if (!edits.length) throw new Error('no Caltrain patterns end at San Francisco: the Portal scenario would be empty');
  fs.writeFileSync(`${BUNDLE}/portal-scenario.json`, JSON.stringify(scenario, null, 1));
  console.log(`scenario: ${edits.length} edits on ${routes.length} routes`);
  // --scenario-only: write the app's example and stop (no model run)
  if (process.argv.includes('--scenario-only')) return;

  const calib = H.calibration!;
  const base = decodeResult(zlib.gunzipSync(fs.readFileSync(`${BUNDLE}/base.bin.gz`)));
  // the Portal and an unchanged run, each three passes from today's crowding (the new trains start
  // empty and fill over the passes)
  const prep = prepare(b);
  const today: Scenario = { name: 'Today', edits: [] };
  const run = (sc: Scenario) => runModel(b, sc, calib, new LocalExecutor(b, sc, calib), { iterations: 3, warmCrowd: base.finalCrowd }, prep);
  const r = await run(scenario);
  const ref = await run(today);
  const S = H.stops.length;
  // the new stops are numbered after the bundle's, in edit order (shared between routes)
  const townsend = S, center = S + 1;
  const onOff = (st: number) => Math.round(r.stopOn[st] + r.stopOff[st]);
  // riders through the tunnel: load on the hop between 4th & Townsend and the Transit Center
  let tunnel = 0;
  for (const l of r.lines) {
    if (!l.stops) continue;
    for (const loads of Object.values(l.loads)) for (let k = 0; k + 1 < l.stops.length; k++) {
      const a = l.stops[k], c = l.stops[k + 1];
      if ((a === townsend && c === center) || (a === center && c === townsend)) tunnel += loads[k];
    }
  }
  const caltrain = (x: typeof base) => x.summary.boardings.caltrain ?? 0;
  const portal = JSON.parse(fs.readFileSync(`${REFERENCE}/portal.json`, 'utf8'));
  const out = {
    description: scenario.name,
    assumptions: 'All Caltrain trains extended (FTA forecast: 4 of 6 peak trains per hour per direction); 60 s + 180 s run times (not published); weekday; today’s population and jobs.',
    model: {
      tunnelRidersPerDay: Math.round(tunnel),
      transitCenterOnOff: onOff(center),
      townsendOnOff: onOff(townsend),
      caltrainBoardingsChange: Math.round(caltrain(r) - caltrain(ref)),
      caltrainBoardingsBase: Math.round(caltrain(ref)),
      transitTripsChange: Math.round(r.summary.transitTrips - ref.summary.transitTrips),
      travelerMinutesSavedPerDay: Math.round(r.summary.logsum - ref.summary.logsum),
      operatingCostChangePerDay: Math.round(r.summary.opCost - ref.summary.opCost),
    },
    official: {
      ftaCurrentYear2023DailyLinkedTrips: 16500,
      ftaHorizon2045DailyLinkedTrips: 48000,
      feis2020TransitCenterOnOff: 29307,
      feisMinutesSavedPerPeninsulaDowntownTrip: [13, 15],
      source: 'server/beta3/reference/portal.json (FTA CIG profiles 2024–2025; 2004 FEIS/EIR Table 3.1-16)',
    },
    officialRecordKeys: Object.keys(portal),
  };
  fs.writeFileSync(`${REFERENCE}/portal-results.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`${BUNDLE}/portal.json`, JSON.stringify(out));
  console.log(JSON.stringify(out.model, null, 1));
  console.log(`routes extended: ${routes.join(', ')}; ran in ${(r.ms / 1000).toFixed(0)} s`);
}

main();
