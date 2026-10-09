/**
 * The model day, in the five periods MTC's Travel Model One uses for the Bay Area.
 * Hours are clock hours; EV runs past midnight to 3am.
 */
export const PERIODS = ['EA', 'AM', 'MD', 'PM', 'EV'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_BOUNDS: Record<Period, [number, number]> = {
  EA: [3, 6],
  AM: [6, 10],
  MD: [10, 15],
  PM: [15, 19],
  EV: [19, 3],
};

export const PERIOD_HOURS: Record<Period, number> = { EA: 3, AM: 4, MD: 5, PM: 4, EV: 8 };

export const PERIOD_LABEL: Record<Period, string> = {
  EA: 'Early (3–6am)',
  AM: 'Morning peak (6–10am)',
  MD: 'Midday (10am–3pm)',
  PM: 'Evening peak (3–7pm)',
  EV: 'Evening & night (7pm–3am)',
};
