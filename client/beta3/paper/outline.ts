/**
 * The article's sections in reading order. Section numbers are derived from this list, so a
 * cross-reference (`sec('backcast')`) always names the right number. Level 2 is a numbered
 * section (1, 2, ...), level 3 a subsection (1.1, 1.2, ...).
 */
export interface OutlineItem {
  id: string;
  level: 2 | 3;
}
const s = (id: string, level: 2 | 3 = 3): OutlineItem => ({ id, level });

export const OUTLINE: OutlineItem[] = [
  // ---- front ----
  s('intro', 2),
  s('compare'),
  s('related'),
  s('data', 2),
  // ---- model structure ----
  s('model', 2),
  s('zones'),
  s('fares'),
  s('population'),
  s('tours'),
  s('destination'),
  s('mode'),
  s('tod'),
  s('assignment'),
  s('roads'),
  s('micromobility'),
  s('special'),
  s('abm'),
  s('iteration'),
  s('runmodes'),
  s('weekend-model'),
  // ---- calibration ----
  s('calibration', 2),
  s('calib-targets'),
  s('calib-method'),
  s('calib-fit'),
  // ---- validation ----
  s('validation', 2),
  s('val-framework'),
  s('val-muni'),
  s('val-rail'),
  s('val-markets'),
  s('val-other'),
  s('val-sensitivity'),
  s('val-backcast'),
  s('val-weekend'),
  s('val-scorecard'),
  // ---- scenarios ----
  s('scenarios', 2),
  s('scen-method'),
  s('scen-portal'),
  s('scen-fare'),
  s('scen-charge'),
  s('scen-buslanes'),
  s('scen-uncertainty'),
  // ---- closing ----
  s('limitations', 2),
  s('reproducibility', 2),
  s('cite', 2),
];
