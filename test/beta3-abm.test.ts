import { describe, expect, it } from 'vitest';
import { compile, factor } from '../shared/beta3/abm-expr';
import { buildAbm, cdapZone, newCdapOut, segmentTours, type SegTours } from '../shared/beta3/abm';
import { packPerson, type PType, type SynPop } from '../shared/beta3/synpop';

/** a one-zone population: households as lists of [age, ptype, employed, wfh, female, student] */
function pop(hhs: { veh: number; incK: number; persons: [number, PType, boolean, boolean, boolean, number][] }[]): SynPop {
  const size: number[] = [], veh: number[] = [], inc: number[] = [], kind: number[] = [], age: number[] = [], flags: number[] = [];
  for (const h of hhs) {
    size.push(h.persons.length), veh.push(h.veh), inc.push(h.incK), kind.push(0);
    for (const [a, ptype, employed, wfh, female, student] of h.persons) (age.push(a), flags.push(packPerson({ ptype, employed, wfh, female, student })));
  }
  return { zoneStart: Int32Array.from([0, hhs.length]), size: Uint8Array.from(size), veh: Uint8Array.from(veh), inc: Uint16Array.from(inc), kind: Uint8Array.from(kind), age: Uint8Array.from(age), flags: Uint8Array.from(flags) };
}
const acc = { auPkTotal: 10, auOpRetail: 8, trOpRetail: 6, nmRetail: 5 };

describe('beta3 ActivitySim expressions', () => {
  it("keeps Python's precedence: comparisons bind more loosely than & and |", () => {
    expect(compile('(ptype == 1) & (age < 40)')({ ptype: 1, age: 30 })).toBe(1);
    expect(compile('(ptype == 1) & (age < 40)')({ ptype: 2, age: 30 })).toBe(0);
    expect(compile('~(workplace_zone_id > -1)')({ workplace_zone_id: -1 })).toBe(1);
    expect(compile('num_mand*(tot_tours == 0)')({ num_mand: 2, tot_tours: 0 })).toBe(2);
  });
  it('reads flags as shares: & a product, | the union, ~ the complement', () => {
    expect(compile('a & b')({ a: 0.5, b: 0.4 })).toBeCloseTo(0.2);
    expect(compile('a | b')({ a: 0.5, b: 0.4 })).toBeCloseTo(0.7);
    expect(compile('~a')({ a: 0.25 })).toBeCloseTo(0.75);
    // a comparison given as a probability
    expect(compile('(ptype == 1) & (distance_to_work < 3)')({ ptype: 1, 'distance_to_work<3': 0.3 })).toBeCloseTo(0.3);
  });
  it('splits a term into its alternative part and the rest', () => {
    const f = factor('~no_cars & (car_sufficiency < 0) & (tot_tours == 1)', new Set(['tot_tours']));
    expect(compile(f.left)({ tot_tours: 1 })).toBe(1);
    expect(compile(f.right)({ no_cars: 0, car_sufficiency: -1 })).toBe(1);
    expect(() => factor('(tot_tours == 1) | female', new Set(['tot_tours']))).toThrow();
  });
});

describe('beta3 coordinated daily activity pattern', () => {
  const P = pop([
    // a full-time worker who works from home and a retiree
    { veh: 1, incK: 120, persons: [[45, 1, true, true, false, 0], [70, 5, false, false, true, 0]] },
    // two full-time workers and a schoolchild
    { veh: 0, incK: 60, persons: [[38, 1, true, false, true, 0], [40, 1, true, false, false, 0], [9, 7, false, false, false, 1]] },
  ]);
  const A = buildAbm(P, 1);
  const out = newCdapOut(A.segW.length);
  cdapZone(A, 0, acc, undefined, out);
  it('gives each person probabilities of M, N, and H summing to one', () => {
    for (let s = 0; s < A.segW.length; s++) expect(out.M[s] + out.N[s] + out.H[s]).toBeCloseTo(A.segW[s], 9);
  });
  it('gives no mandatory day to retirees or to workers working from home', () => {
    for (let s = 0; s < A.segW.length; s++) if (A.segPtype[s] === 5 || A.segWfh[s]) expect(out.M[s]).toBe(0);
  });
  it('lets household members do the same thing together (the interaction terms)', () => {
    // with the household terms the two commuters' patterns are positively correlated; their M is
    // higher than for a lone worker otherwise alike
    const lone = buildAbm(pop([{ veh: 0, incK: 60, persons: [[38, 1, true, false, true, 0]] }]), 1);
    const o2 = newCdapOut(1);
    cdapZone(lone, 0, acc, undefined, o2);
    const s = [...A.segPtype].findIndex((t, i) => t === 1 && !A.segWfh[i] && A.segW[i] === 1);
    expect(out.M[s]).not.toBeCloseTo(o2.M[0], 3);
  });
  it('makes tours: work tours only on M days, schoolchildren school tours', () => {
    const st: SegTours = { pat: [0, 0, 0], work: 0, school: 0, nm: new Float64Array(6), nmOnM: 0, nmOnN: 0 };
    for (let s = 0; s < A.segW.length; s++) {
      const w = A.segW[s];
      segmentTours(A, s, [out.M[s] / w, out.N[s] / w, out.H[s] / w], { 'distance_to_work<3': 0.5, roundtrip_auto_time_to_work: 40, 'distance_to_school<3': 0.8, roundtrip_auto_time_to_school: 20 }, acc, undefined, st);
      expect(st.work).toBeLessThanOrEqual(2 * out.M[s] / w + 1e-12);
      if (A.segPtype[s] === 7) expect(st.school).toBeGreaterThan(0.5 * out.M[s] / w);
      if (A.segPtype[s] === 5) expect(st.work + st.school).toBe(0);
      for (const v of st.nm) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
