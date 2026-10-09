/**
 * The synthetic population as the bundle carries it (built by server/beta3/pipeline/synpop.ts).
 *
 * Households are sorted by zone; `popZoneStart[z]..popZoneStart[z+1]` are zone z's. Persons follow
 * their households in order, `popHhSize[h]` of them each, so a household's first person is the
 * running sum of the sizes before it. A few bytes each:
 *   households: popHhSize (u8), popHhVeh (u8, vehicles, 6 = six or more), popHhInc (u16, income in
 *               thousands of 2024 dollars; a group-quarters resident's own income), popHhKind (u8,
 *               GQ_KINDS);
 *   persons:    popAge (u8), popFlags (u8: PF bits, person type and student level).
 * A household's random seed (for draws such as its value of time) is hhSeed(index), so it needn't be
 * stored.
 */
import type { Bundle } from "./types";

/** person types as in ActivitySim and Travel Model One */
export const PTYPES = [
  "full-time worker",
  "part-time worker",
  "university student",
  "non-worker",
  "retired",
  "driving-age student",
  "child 6–15",
  "child under 6",
] as const;
export type PType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** what a household record is: a household, or one resident of group quarters */
export const GQ_KINDS = ["household", "institutional group quarters", "college housing", "other group quarters"] as const;

/** student level: none, preschool to grade 12, undergraduate, graduate or professional */
export const STUDENT = ["none", "school", "undergraduate", "graduate"] as const;

/** person flag bits */
export const PF = { female: 1, employed: 2, wfh: 4 } as const;

export interface PersonRec {
  female: boolean;
  employed: boolean;
  /** works from home (employed persons; drawn at 2024 rates) */
  wfh: boolean;
  ptype: PType;
  /** index into STUDENT */
  student: number;
}

export function packPerson(p: PersonRec): number {
  return (p.female ? PF.female : 0) | (p.employed ? PF.employed : 0) | (p.wfh ? PF.wfh : 0) | ((p.ptype - 1) << 3) | (p.student << 6);
}
export function unpackPerson(f: number): PersonRec {
  return {
    female: (f & PF.female) !== 0,
    employed: (f & PF.employed) !== 0,
    wfh: (f & PF.wfh) !== 0,
    ptype: (((f >> 3) & 7) + 1) as PType,
    student: (f >> 6) & 3,
  };
}

/** a household's 32-bit random seed: a hash of its index (lowbias32) */
export function hhSeed(i: number): number {
  let x = (i + 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** BATS 2023's income bands (params INCOME_BANDS) from income in thousands */
export function incomeBand(incK: number): number {
  return incK < 50 ? 0 : incK < 100 ? 1 : incK < 200 ? 2 : 3;
}

export interface SynPop {
  zoneStart: Int32Array;
  size: Uint8Array;
  veh: Uint8Array;
  inc: Uint16Array;
  kind: Uint8Array;
  age: Uint8Array;
  flags: Uint8Array;
}

export function synpopOf(b: Bundle): SynPop | null {
  const a = b.a;
  if (!a.popZoneStart) return null;
  return {
    zoneStart: a.popZoneStart as Int32Array,
    size: a.popHhSize as Uint8Array,
    veh: a.popHhVeh as Uint8Array,
    inc: a.popHhInc as Uint16Array,
    kind: a.popHhKind as Uint8Array,
    age: a.popAge as Uint8Array,
    flags: a.popFlags as Uint8Array,
  };
}

/**
 * Households and persons of each zone by car segment (0, 1, 2+ vehicles) and income band, as the
 * aggregate demand model groups them. Counts are [segment][band] arrays over zones. Group-quarters
 * residents have no household car (segment 0) and are banded by their own income; they count as
 * persons but not as households.
 */
export interface SegmentTables {
  households: Float32Array[][];
  persons: Float32Array[][];
  /** aged 5–17 */
  youth: Float32Array[][];
  /** aged 65 and over */
  seniors: Float32Array[][];
  /** enrolled in college or graduate school */
  college: Float32Array[][];
  /** employed */
  workers: Float32Array[][];
  /** employed and not working from home */
  commuters: Float32Array[][];
}

export function segmentTables(pop: SynPop, NZ: number): SegmentTables {
  const mk = () => [0, 1, 2].map(() => [0, 1, 2, 3].map(() => new Float32Array(NZ)));
  const t: SegmentTables = { households: mk(), persons: mk(), youth: mk(), seniors: mk(), college: mk(), workers: mk(), commuters: mk() };
  let p = 0;
  for (let z = 0; z < NZ; z++)
    for (let h = pop.zoneStart[z]; h < pop.zoneStart[z + 1]; h++) {
      const s = Math.min(2, pop.veh[h]),
        c = incomeBand(pop.inc[h]);
      if (pop.kind[h] === 0) t.households[s][c][z]++;
      for (let k = 0; k < pop.size[h]; k++, p++) {
        const age = pop.age[p],
          f = pop.flags[p];
        t.persons[s][c][z]++;
        if (age >= 5 && age <= 17) t.youth[s][c][z]++;
        if (age >= 65) t.seniors[s][c][z]++;
        if ((f >> 6) >= 2) t.college[s][c][z]++;
        if (f & PF.employed) {
          t.workers[s][c][z]++;
          if (!(f & PF.wfh)) t.commuters[s][c][z]++;
        }
      }
    }
  return t;
}
