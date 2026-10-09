import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle } from '../shared/beta3/bundle';
import { buildNet, C_BIAS, C_COST, C_FARE, C_TIME, LINK_ACCESS, LINK_EGRESS, NC } from '../shared/beta3/net';
import { skimColumns } from '../shared/beta3/model';
import { computeDemand, demandPart, finishDemand, prepare } from '../shared/beta3/demand';
import { MICRO, MicroDemand, isMicroAccess, microData, microLinks, rideSec, ridePrice } from '../shared/beta3/micromobility';
import { PATH, coeffsOf } from '../shared/beta3/params';
import { TPERIODS, type BLine, type BStop, type Bundle, type BundleHeader, type Calibration, type ZoneAttrs } from '../shared/beta3/types';

/**
 * Three zones in a row 1.5 km apart; a BART station in zone 2 with a Bay Wheels station beside it.
 * Zone 0 has a Bay Wheels station 2 minutes' walk away, zone 1 none within reach.
 */
function toy(): Bundle {
  const stops: BStop[] = [
    { id: 'bart:A', feed: 'bart', name: 'A', lat: 37.78, lon: -122.39, x: 3000, y: 0, station: true },
    { id: 'bart:B', feed: 'bart', name: 'B', lat: 37.8, lon: -122.27, x: 13000, y: 0, station: true },
  ];
  const zones = [0, 1, 2].map((i) => ({ id: `z${i}`, nhood: `N${i}`, lat: 37.78, lon: -122.42 + i * 0.017, x: i * 1500, y: 0, pop: 3000, jobs: 1000, land: 250_000, hh: 1000 }) as unknown as ZoneAttrs);
  const lines: BLine[] = [
    { id: 'l0', feed: 'bart', agency: 'BART', route: 'R', routeName: '', mode: 'bart', color: '#000', dir: 0, headsign: '', stops: [0, 1], periods: { AM: { trips: 24, hops: [600] } }, cap: 1000, seats: 500, path: [], stopAt: [] } as unknown as BLine,
  ];
  const NZ = 3;
  const bikeM = new Uint16Array(NZ * NZ), bikeSec = new Uint16Array(NZ * NZ), bikeUp = new Uint16Array(NZ * NZ), bikeFeel = new Uint8Array(NZ * NZ).fill(100);
  for (let o = 0; o < NZ; o++)
    for (let d = 0; d < NZ; d++) {
      const m = o === d ? 300 : Math.abs(o - d) * 1500;
      bikeM[o * NZ + d] = m;
      bikeSec[o * NZ + d] = Math.round(m / 4.5);
      // uphill eastward: 20 m a step
      bikeUp[o * NZ + d] = d > o ? (d - o) * 200 : 0;
    }
  // rides to and from the station (one place), by zone: length (10 m), climb (dm), weight (×100)
  const acc = new Uint16Array(NZ * 3), egr = new Uint16Array(NZ * 3);
  for (let z = 0; z < NZ; z++) {
    const m = Math.max(1, (2 - z) * 1500);
    acc.set([m / 10, (2 - z) * 200, 100], z * 3);
    egr.set([m / 10, 0, 100], z * 3);
  }
  const header = {
    version: 1, built: '', sources: [], zones, ext: [], stops, lines, fares: { bart: { board: 2, perKm: 0.1 } }, gateways: [], observed: {} as never, calibration: null,
    micro: { gbfs: 'test', places: [{ name: 'A', kinds: ['bart'], stops: [0], x: 3000, y: 0, dockSec: 30, zone: 2 }] },
  } as unknown as Omit<BundleHeader, 'arrays'>;
  return decodeBundle(
    encodeBundle(header, {
      // zone 2 walks to station A; zone 1 is beside station B (a stand-in for a far destination)
      connectors: Int32Array.from([2, 0, 60, 1, 1, 60, 0, 0, 1500]),
      extConnectors: new Int32Array(0),
      transfers: new Int32Array(0),
      zonePtStart: Int32Array.from([0, 1, 2, 3]),
      zonePtX: Float32Array.from([0, 1500, 3000]),
      zonePtY: new Float32Array(3),
      zonePtW: Float32Array.from([1, 1, 1]),
      bikeM, bikeSec, bikeUp, bikeFeel,
      mmPtDock: Uint16Array.from([120, 65535, 60]),
      mmAcc: acc,
      mmEgr: egr,
    }),
  );
}
const calib = { asc: {}, modeBias: {}, distCoef: {}, regionalRate: 0, outShare: 0, airportTrips: 0, iterations: 0, report: [] } as Calibration;
const cc = -0.03;

describe('beta3 shared micromobility: availability', () => {
  const b = toy();
  const x = microData(b)!;
  it('has no shared classic bike where no station is within reach, at either end', () => {
    expect(x.dockShare[1]).toBe(0);
    const m = new MicroDemand(x, calib, new Float32Array(3).fill(19));
    m.at(1, 2, 'shop', 2, false);
    m.bikeUtility(-1, cc);
    expect(m.sub[0]).toBe(0);
    m.at(2, 1, 'nhb', 1, false);
    m.bikeUtility(-1, cc);
    expect(m.sub[0]).toBe(0);
    m.at(0, 2, 'shop', 2, false);
    m.bikeUtility(-1, cc);
    expect(m.sub[0]).toBeGreaterThan(0);
  });
  it('rents nothing to persons under 18', () => {
    const m = new MicroDemand(x, calib, new Float32Array(3).fill(19));
    m.at(0, 2, 'shop', 2, true);
    expect(m.active).toBe(false);
    expect(m.bikeUtility(-1.5, cc)).toBe(-1.5);
  });
  it('has no Bay Wheels without stations, and no scooters without a fleet', () => {
    const m = new MicroDemand(microData(b, { docks: 0 })!, calib, new Float32Array(3).fill(19));
    m.at(0, 2, 'shop', 2, false);
    m.bikeUtility(-1, cc);
    expect(m.sub[0] + m.sub[1]).toBe(0);
    expect(m.sub[2]).toBeGreaterThan(0);
    const n = new MicroDemand(microData(b, { fleet: 0 })!, calib, new Float32Array(3).fill(19));
    n.at(0, 2, 'shop', 2, false);
    n.bikeUtility(-1, cc);
    expect(n.sub[2]).toBe(0);
    expect(microLinks(b, { docks: 0, fleet: 0 })).toHaveLength(0);
  });
  it('only raises the bike nest, and more stations nearer raise it more', () => {
    const at = (s?: { docks: number }) => {
      const m = new MicroDemand(microData(b, s)!, calib, new Float32Array(3).fill(19));
      m.at(0, 2, 'work', 2, false);
      return m.bikeUtility(-2, cc);
    };
    expect(at()).toBeGreaterThan(-2);
    expect(at({ docks: 4 })).toBeGreaterThan(at());
  });
});

describe('beta3 shared micromobility: time and cost', () => {
  it('e-bikes beat classic bikes, most on hills; scooters ride slower than e-bikes', () => {
    expect(rideSec('ebike', 2000, 0)).toBeLessThan(rideSec('classic', 2000, 0));
    const hill = (k: 'classic' | 'ebike') => rideSec(k, 2000, 60) - rideSec(k, 2000, 0);
    expect(hill('ebike')).toBeLessThan(hill('classic') / 3);
    expect(rideSec('scooter', 2000, 30)).toBeGreaterThan(rideSec('ebike', 2000, 30));
    // a flat 2 km on a classic bike: 6–12 minutes
    expect(rideSec('classic', 2000, 0) / 60).toBeGreaterThan(6);
    expect(rideSec('classic', 2000, 0) / 60).toBeLessThan(12);
  });
  it("prices rides as riders pay them: members' classic rides free under 45 minutes, e-bikes by the minute", () => {
    const s = microData(toy())!.settings;
    const casual = MICRO.riders.casual;
    expect(ridePrice('classic', 10, s)).toBeCloseTo(casual * (MICRO.price.unlock + 10 * MICRO.price.casualPerMin.classic), 9);
    expect(ridePrice('ebike', 10, s)).toBeGreaterThan(ridePrice('classic', 10, s));
    expect(ridePrice('ebike', 10, s, true) - ridePrice('ebike', 10, s)).toBeCloseTo(MICRO.price.rackFee, 9);
    expect(ridePrice('scooter', 10, s)).toBeCloseTo(MICRO.price.scooterUnlock + 10 * MICRO.price.scooterPerMin, 9);
    expect(ridePrice('scooter', 10, { ...s, scooterPrice: 0.5 })).toBeCloseTo(ridePrice('scooter', 10, s) / 2, 9);
    expect(ridePrice('classic', 50, s)).toBeGreaterThan(ridePrice('classic', 40, s));
  });
  it('makes a shared vehicle less attractive the more its money matters', () => {
    const m = new MicroDemand(microData(toy())!, calib, new Float32Array(3).fill(19));
    m.at(0, 2, 'shop', 2, false);
    const rich = m.bikeUtility(-1, -0.01), poor = m.bikeUtility(-1, -0.2);
    expect(rich).toBeGreaterThan(poor);
    void coeffsOf;
  });
});

describe('beta3 shared micromobility: climbing', () => {
  const b = toy();
  const x = microData(b)!;
  const cal = (climb: Record<string, number>) => ({ ...calib, micro: { asc: { bayWheels: 0, ebike: 0, scooter: 0 }, accessBias: 0, climb } }) as Calibration;
  it('charges an own bike its effort per metre climbed on the route', () => {
    const m = new MicroDemand(x, cal({ own: -0.01 }), new Float32Array(3).fill(19));
    // zone 0 → 2 climbs 40 m (east is uphill), 2 → 0 none
    expect(m.ownClimb(0 * 3 + 2)).toBeCloseTo(-0.4, 9);
    expect(m.ownClimb(2 * 3 + 0)).toBeCloseTo(0, 12);
  });
  it('charges the classic bike more for a climb than the e-bike, and the scooter nothing beyond its time', () => {
    expect(MICRO.climbEquiv.classic).toBeGreaterThan(MICRO.climbEquiv.ebike);
    expect(MICRO.climbEquiv.ebike).toBeGreaterThan(0);
    expect(MICRO.climbEquiv.scooter).toBe(0);
    // with an own bike's effort charged too, its shares within the bike alternative go to the shared vehicles uphill only
    const up = (climb: Record<string, number>) => {
      const m = new MicroDemand(x, cal(climb), new Float32Array(3).fill(19));
      m.at(0, 2, 'nhb', 1, false);
      m.bikeUtility(-1 + m.ownClimb(0 * 3 + 2), cc);
      const s = 1 - m.sub[3];
      m.at(2, 0, 'nhb', 1, false);
      m.bikeUtility(-1 + m.ownClimb(2 * 3 + 0), cc);
      return [s, 1 - m.sub[3]];
    };
    const [u0, d0] = up({});
    const [u1, d1] = up({ own: -0.02 });
    expect(u1).toBeGreaterThan(u0);
    expect(d1).toBeCloseTo(d0, 9);
  });
});

describe('beta3 shared micromobility: rides to stations', () => {
  const b = toy();
  it('adds a network link for each station link, or folds an egress into the walking one by the logit', () => {
    const L = microLinks(b);
    const net = buildNet(b, { name: 't', edits: [] }, 'AM', null);
    expect(net.mmLink).toHaveLength(L.length);
    // zone 0 walks from station A too, so its egress by shared vehicle is folded into that walk
    expect([...net.mmShare!].some((v) => v < 1)).toBe(true);
    L.forEach((l, j) => {
      const a = net.mmLink![j], sh = net.mmShare![j];
      expect(net.type[a]).toBe(isMicroAccess(l.kind) ? LINK_ACCESS : LINK_EGRESS);
      const plat = net.platMin[l.s];
      const fare = isMicroAccess(l.kind) ? 2 : 0;
      const own = PATH.walkWeight * (plat + l.walk) + MICRO.rideWeight * l.ridePerceived + (fare + l.price) / PATH.votPerMin;
      if (sh === 1) {
        // a link of its own: its time is the ride and the walks (access: the blocks' walk comes from the block arrays)
        expect(net.mmKind![a]).toBe(l.kind);
        expect(net.comp[a * NC + C_TIME]).toBeCloseTo(plat + l.walk + l.ride, 4);
        expect(net.comp[a * NC + C_BIAS]).toBeCloseTo(MICRO.rideWeight * l.ridePerceived, 4);
        // the transit fare is a fare; the shared vehicle's price is other money (no person type's discount)
        expect(net.comp[a * NC + C_FARE]).toBeCloseTo(fare, 4);
        expect(net.comp[a * NC + C_COST]).toBeCloseTo(l.price, 4);
        expect(net.cost[a]).toBeCloseTo(own, 3);
      } else {
        // folded into the walking egress link: a share by the logit, and the link costs no more than either
        expect(sh).toBeGreaterThan(0);
        expect(sh).toBeLessThan(1);
        expect(net.mmKind![a]).toBe(-1);
        expect(net.cost[a]).toBeLessThanOrEqual(own + 1e-6);
        expect(sh).toBeCloseTo(Math.exp(-PATH.accessTheta * (own - net.cost[a])), 4);
      }
    });
  });
  it('skims the shared vehicle\'s price apart from the fare, so fare discounts leave it alone', () => {
    const net = buildNet(b, { name: 't', edits: [] }, 'AM', null);
    const Z = net.nZones;
    const out = { g: new Float32Array(Z * Z), boards: new Float32Array(Z * Z), fare: new Float32Array(Z * Z), cost: new Float32Array(Z * Z), time: new Float32Array(Z * Z) };
    skimColumns(net, [1], out, Z);
    // zone 0 to zone 1: some ride a shared vehicle to station A, all pay BART's fare
    const k = 0 * Z + 1;
    expect(out.cost[k]).toBeGreaterThan(0);
    expect(out.fare[k]).toBeGreaterThan(0);
    // the fare is BART's alone (boarding $2 and $0.10 a km over 10 km), with no shared-vehicle price in it
    expect(out.fare[k]).toBeCloseTo(2 + 0.1 * 10, 3);
  });

  it('reaches the station from a zone with a Bay Wheels station only by a docked bike from there; never from the station zone itself', () => {
    const L = microLinks(b);
    expect(L.some((l) => l.z === 0 && l.kind === 0)).toBe(true);
    expect(L.some((l) => l.z === 1 && (l.kind === 0 || l.kind === 3))).toBe(false);
    // zone 2 holds the station: too near to ride (MICRO.accessMinM)
    expect(L.some((l) => l.z === 2)).toBe(false);
  });
  it('puts the egress bias on the way from a station and the access bias on the way to it', () => {
    const c = { ...calib, micro: { asc: { bayWheels: 0, ebike: 0, scooter: 0 }, accessBias: 3, egressBias: 7 } } as Calibration;
    const net = buildNet(b, { name: 't', edits: [] }, 'AM', c);
    microLinks(b).forEach((l, j) => {
      const a = net.mmLink![j];
      if (net.mmShare![j] !== 1) return;
      expect(net.comp[a * NC + C_BIAS]).toBeCloseTo(MICRO.rideWeight * l.ridePerceived + (isMicroAccess(l.kind) ? 3 : 7), 4);
    });
  });

  it('lets a zone beyond walking reach ride to the station, and riders use it', async () => {
    const { StrategySolver } = await import('../shared/beta3/strategy');
    const net = buildNet(b, { name: 't', edits: [] }, 'AM', null);
    const s = new StrategySolver(net);
    // zone 0 to zone 1 (beside station B): zone 0 is a 25-minute walk from station A, so most ride to it
    s.solve(1);
    s.resetVolumes();
    s.load((o) => (o === 0 ? 100 : 0));
    let mm = 0;
    net.mmLink!.forEach((a, j) => net.tail[a] === 0 && (mm += s.linkVol[a] * net.mmShare![j]));
    expect(s.label(0)).toBeLessThan(Infinity);
    expect(mm).toBeGreaterThan(50);
    expect(mm).toBeLessThan(100);
  });
});

// the app's bundle, or another (BETA3_SF_BUNDLE) that has the shared-vehicle data
const BUNDLE = process.env.BETA3_SF_BUNDLE ?? 'client/beta3/model/sf.bin.gz';
const real = (() => {
  try {
    const b = decodeBundle(zlib.gunzipSync(fs.readFileSync(BUNDLE)));
    return b.a.mmPtDock ? b : null;
  } catch {
    return null;
  }
})();

describe('beta3 shared micromobility: demand split by origin', () => {
  it.skipIf(!real)('gives the same shared trips and bike trips split over parts as in one pass', () => {
    const b = real!;
    const ZT = b.header.zones.length + 2 * b.header.ext.length;
    // no transit (the split is what is checked): every skim unavailable
    const sk = Object.fromEntries(TPERIODS.map((p) => [p, { g: new Float32Array(ZT * ZT).fill(Infinity), boards: new Float32Array(ZT * ZT), fare: new Float32Array(ZT * ZT), time: new Float32Array(ZT * ZT).fill(Infinity) }]));
    const prep = prepare(b);
    const cal = b.header.calibration!;
    const whole = computeDemand(b, prep, sk as never, cal);
    const parts = [0, 1, 2].map((i) => demandPart(b, prep, sk as never, cal, 'wkd', 1, { index: i, count: 3 }));
    const split = finishDemand(b, cal, parts);
    const rel = (a: number, c: number) => Math.abs(a - c) / Math.max(1e-9, Math.abs(c));
    for (let k = 0; k < 3; k++) expect(rel(split.micro!.trips[k], whole.micro!.trips[k])).toBeLessThan(1e-9);
    expect(rel(split.trips.bike, whole.trips.bike)).toBeLessThan(1e-9);
    const so = split.micro!.od, wo = whole.micro!.od;
    let worst = 0;
    for (let i = 0; i < wo.length; i++) if (wo[i] > 1e-6) worst = Math.max(worst, rel(so[i], wo[i]));
    expect(worst).toBeLessThan(1e-9);
    expect(whole.micro!.trips.reduce((a, v) => a + v, 0)).toBeGreaterThan(0);
  }, 900_000);
});
