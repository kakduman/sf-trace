/**
 * The test scenarios for the run modes (runmodes.ts): no change, fare-free Muni, bus lanes on 19th
 * Avenue, a Geary subway, the 14 Mission at half its frequency, the $8 downtown peak charge, and
 * the Portal (Caltrain to the Salesforce Transit Center).
 * They are the app's examples (client/beta3/scenario.ts), made here without the page's modules.
 */
import fs from 'node:fs';
import type { Bundle, Edit, Scenario } from '../../../shared/beta3/types';
import { BUNDLE } from './paths';

/** SFCTA's Downtown Congestion Pricing Study zone (client/beta3/scenario.ts DOWNTOWN_RING) */
export const DOWNTOWN_RING: [number, number][] = [
  [37.8058, -122.4239], [37.8091, -122.4152], [37.8088, -122.4098], [37.806, -122.404], [37.7956, -122.3918], [37.787, -122.387], [37.778, -122.3858], [37.764, -122.3855],
  [37.7638, -122.3958], [37.7718, -122.4021], [37.7699, -122.4046], [37.7695, -122.4198], [37.7681, -122.4199], [37.7678, -122.4288], [37.7718, -122.4248], [37.7784, -122.4262], [37.7791, -122.4196], [37.8058, -122.4239],
];

const M_LAT = 110_950,
  M_LON = 111_320 * Math.cos((37.78 * Math.PI) / 180);
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** the app's Geary subway example: light rail in a tunnel at 11 of the 38R's stops, every 4 minutes at peak (scenario.ts PROFILES.subway) */
export function gearySubway(b: Bundle): Edit {
  const H = b.header;
  const want = ['Transit Center', 'Market St & Montgomery', 'Geary St & Powell', 'Van Ness', 'Fillmore', 'Divisadero', 'Arguello', 'Park Presidio', '25th Ave', '33rd Ave', '48th Ave'];
  // the 38R's busiest pattern that starts downtown
  const pats = H.lines.filter((l) => l.feed === 'muni' && l.route === '38R' && H.stops[l.stops[0]].name.includes('Transit Center'));
  const pat = pats.sort((x, y) => (y.periods.AM?.trips ?? 0) - (x.periods.AM?.trips ?? 0))[0] ?? H.lines.filter((l) => l.feed === 'muni' && l.route === '38R').sort((x, y) => (y.periods.AM?.trips ?? 0) - (x.periods.AM?.trips ?? 0))[0];
  const stops: number[] = [];
  for (const w of want) {
    const i = pat.stops.find((s) => H.stops[s].name.includes(w));
    if (i !== undefined && !stops.includes(i)) stops.push(i);
  }
  const path: number[] = [],
    stopAt: number[] = [],
    hops: number[] = [];
  stops.forEach((s, k) => {
    const st = H.stops[s];
    if (k > 0) {
      const a = H.stops[stops[k - 1]];
      const m = Math.hypot((st.lat - a.lat) * M_LAT, (st.lon - a.lon) * M_LON) * 1.15;
      hops.push(Math.max(30, Math.round(m / (32 / 3.6))));
    }
    path.push(round5(st.lat), round5(st.lon));
    stopAt.push(k);
  });
  return { kind: 'newLine', id: 'subway-geary', name: 'Geary subway', mode: 'lightrail', color: '#c2410c', stops: stops.map((stop) => ({ stop })), path, stopAt, headway: { AM: 4, MD: 6, PM: 4, NT: 10 }, hops, bothDirections: true } as Edit;
}

export function testScenarios(b: Bundle): Record<string, Scenario> {
  return {
    today: { name: 'No change', edits: [] },
    free: { name: 'Fare-free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }] },
    bus19: { name: '19th Avenue bus lanes', edits: [{ kind: 'road', id: '19thbus', name: '19th Avenue bus lanes', street: '19th Avenue', from: { lat: 37.7656, lon: -122.4772 }, to: { lat: 37.7347, lon: -122.4751 }, lanes: -1, busLane: true }] },
    geary: { name: 'A Geary subway', edits: [gearySubway(b)] },
    cut14: { name: 'The 14 Mission at half its frequency', edits: [{ kind: 'frequency', route: '14', feed: 'muni', factor: { AM: 0.5, MD: 0.5, PM: 0.5, NT: 0.5 } }] },
    cordon: { name: 'Downtown congestion charge', edits: [{ kind: 'cordon', id: 'downtown', name: 'Downtown congestion charge', ring: DOWNTOWN_RING, toll: { AM: 8, PM: 8 } }] },
    portal: JSON.parse(fs.readFileSync(`${BUNDLE}/portal-scenario.json`, 'utf8')) as Scenario,
  };
}
