/**
 * Hotel visitors' mode shares, the calibration's target for their trips: SF Planning's 2017 door
 * surveys at hotels (reference/visitor-travel.json), by place type, weighted by the hotel rooms the
 * model has in each. Person trips by car are split as surveyed (driving alone; drivers and passengers
 * with others); private shuttles (hotel and airport vans) are left out and the rest renormalized, as
 * SF Planning leaves them out of its analysis. Nobody biked in the survey.
 */
import fs from 'node:fs';
import type { Mode } from '../../../shared/beta3/params';
import { REFERENCE } from './paths';

type Row = Record<'drive_alone' | 'hov_driver' | 'hov_pass' | 'walk' | 'tnc_taxi' | 'bike' | 'bus' | 'light_rail' | 'heavy_rail' | 'pvt_shuttle', number>;
export interface VisitorRef {
  hotelDoorSurvey: { byPlaceType: Record<string, Row>; placeTypeOfNeighborhood: Record<string, string[] | string> };
}
export const readVisitorRef = (): VisitorRef => JSON.parse(fs.readFileSync(`${REFERENCE}/visitor-travel.json`, 'utf8'));

/** a survey row as the model's modes (shuttles left out) */
export function rowShares(r: Row): Partial<Record<Mode, number>> {
  const s: Partial<Record<Mode, number>> = { da: r.drive_alone, sr: r.hov_driver + r.hov_pass, walk: r.walk, tnc: r.tnc_taxi, bike: r.bike, transit: r.bus + r.light_rail + r.heavy_rail };
  const t = Object.values(s).reduce((a: number, v) => a + (v ?? 0), 0);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (v ?? 0) / t]));
}

/** the target and each place type's share of the rooms; zones without a listed neighborhood count as type 2 */
export function visitorTarget(zones: readonly { nhood: string; hotelRooms: number }[], ref: VisitorRef = readVisitorRef()) {
  const typeOf = new Map<string, string>();
  for (const [t, ns] of Object.entries(ref.hotelDoorSurvey.placeTypeOfNeighborhood)) if (Array.isArray(ns)) for (const n of ns) typeOf.set(n, t);
  const rooms: Record<string, number> = {};
  for (const z of zones) if (z.hotelRooms > 0) rooms[typeOf.get(z.nhood) ?? '2'] = (rooms[typeOf.get(z.nhood) ?? '2'] ?? 0) + z.hotelRooms;
  const R = Object.values(rooms).reduce((a, v) => a + v, 0);
  const target: Partial<Record<Mode, number>> = {};
  for (const [t, r] of Object.entries(ref.hotelDoorSurvey.byPlaceType)) {
    const w = (rooms[t] ?? 0) / R;
    for (const [m, v] of Object.entries(rowShares(r))) target[m as Mode] = (target[m as Mode] ?? 0) + w * (v ?? 0);
  }
  return { target, roomShare: Object.fromEntries(Object.entries(rooms).map(([t, v]) => [t, v / R])) };
}
