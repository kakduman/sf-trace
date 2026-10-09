/**
 * Local flat coordinates for San Francisco: metres east (x) and north (y) of City Hall.
 * Over the city (about 12 km across) the equirectangular error is well under 0.1%.
 */
export const LAT0 = 37.7793;
export const LON0 = -122.4193;
const M_PER_DEG_LAT = 110_950; // at 37.8°N (WGS84)
const M_PER_DEG_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

export function toXY(lat: number, lon: number): [number, number] {
  return [(lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT];
}

export function toLatLon(x: number, y: number): [number, number] {
  return [LAT0 + y / M_PER_DEG_LAT, LON0 + x / M_PER_DEG_LON];
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Walking speed on a slope, after Tobler's hiking function, normalised so flat ground is
 * `flat` m/s. Steep San Francisco streets (20–30%) slow walkers to roughly half pace.
 */
export function walkSpeed(grade: number, flat = 1.34): number {
  return (flat / Math.exp(-3.5 * 0.05)) * Math.exp(-3.5 * Math.abs(grade + 0.05));
}

/**
 * Cycling speed on a slope (m/s): about 4.5 m/s (16 km/h) on the flat, falling steeply uphill
 * (a 10% climb is near walking pace for most riders) and capped downhill.
 */
export function bikeSpeed(grade: number, flat = 4.5): number {
  if (grade >= 0) return Math.max(1.2, flat / (1 + grade * 22));
  return Math.min(flat * 1.5, flat * (1 - grade * 4));
}
