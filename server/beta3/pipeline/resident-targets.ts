/**
 * San Francisco residents' weekday trips by mode, as calibration targets (calibrate.ts), from BATS 2023.
 *
 * MTC publishes BATS 2023 two ways. The consultant's report (Table 36) counts unlinked trips: every
 * leg of a transit trip, the walks to and from the stop and each vehicle, is a trip of its own. MTC's
 * dashboard extract (sf-mode-by-area.json, batsDashboardSF) counts linked trips, with walk-to-transit
 * trips as WALKTRAN, as the model counts them. The shares come from the dashboard, persons of all ages
 * weighted by their trips; the total from the report, since a car trip is one trip linked or unlinked:
 * the report's car trips over the dashboard's linked car share.
 *
 * Before October 2026 the shares were set by hand from the report (transit 12%, walk 34%, car 48.5%
 * split 55/45). The dashboard has transit at 13.8% of adults' linked trips and 10.4% of under-18s',
 * 13.8% of residents' trips in the model's modes. Against the report's 425,000 unlinked transit trips
 * (each vehicle a trip), and at the model's 1.16 vehicles a linked transit trip, the old targets gave
 * 377,000 transit rides (11% fewer) and these give 456,000 (7% more).
 */
import type { Mode } from '../../../shared/beta3/params';

type Shares = Partial<Record<Mode, number>>;
interface DashRow {
  totalWeightedTrips: number;
  modes: Record<string, { weightedShare: number }>;
}

/** the dashboard's linked modes as the model's (OTHER and school buses, which the model doesn't have, left out) */
const MAP: Record<string, Mode | null> = {
  DA: 'da',
  HOV2: 'sr',
  HOV3: 'sr',
  TNC: 'tnc',
  WALK: 'walk',
  BIKE: 'bike',
  WALKTRAN: 'transit',
  DRIVETRAN: 'transit',
  OTHER: null,
  SCHBUS: null,
};

/** residents' linked shares by the model's modes: adults' and under-18s' rows weighted by their trips */
export function residentLinkedShares(modeByArea: { batsDashboardSF: { tables: { mode_label: Record<string, DashRow> } } }): Shares {
  const t = modeByArea.batsDashboardSF.tables.mode_label;
  const rows = [t['2023 | 18 and over | All Income Levels'], t['2023 | Under 18 | All Income Levels']];
  const acc: Record<string, number> = {};
  for (const r of rows)
    for (const [k, v] of Object.entries(r.modes)) {
      const m = MAP[k];
      if (m === undefined) throw new Error(`BATS dashboard mode ${k} has no model mode`);
      if (m) acc[m] = (acc[m] ?? 0) + v.weightedShare * r.totalWeightedTrips;
    }
  const tot = Object.values(acc).reduce((a, v) => a + v, 0);
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v / tot]));
}

/** residents' linked trips a weekday: the report's unlinked car trips (car and carshare) over the linked car share */
export function residentLinkedTrips(table36: { weightedTrips: number; sharesPercent: Record<string, number> }, shares: Shares): number {
  const car = (table36.sharesPercent.Car + (table36.sharesPercent.Carshare ?? 0)) / 100;
  return (table36.weightedTrips * car) / ((shares.da ?? 0) + (shares.sr ?? 0));
}
