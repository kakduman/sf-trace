"""
The modes of a tour's trips, from the 2017 NHTS: how often a tour's trips use a mode other than its
own (transit out and walk back, walk out and the bus back, a ride-hail home), the targets of the
model's trip mode choice conditional on tour mode (demand.ts, calibrate.ts).

Weekday person-days of residents of the San Francisco–Oakland metro (HH_CBSA 41860) living in tracts
of 17,000 or more persons per square mile (HTPPOPDN, as in nhts_tours.py's dense-tract distances), cut
into home-based tours as in nhts_tours.py (primary activity: work, else school, else the longest
stay). NHTS records a change of mode on the way (WHYTO 07) as a place of its own: the segments between
two activities are linked into one trip, whose mode is the highest of its segments' in the order
transit, ride-hail, shared ride, drive alone, bike, walk (a walk to the bus is a transit trip, a
ride-hail to BART too, since the model's transit includes driving to it).
Modes (TRPTRANS): walk 01; bike 02; car 03–06, 08, 18, shared ride when NUMONTRP > 1; ride-hail and
taxi 17; transit 11, 13–16, 20. Tours with a trip by any other mode (school bus, paratransit, plane,
...) are left out.
The tour's mode is that of its primary outbound leg (the trip into its primary destination), as in
nhts_tours.py. It gives, by that mode (also counting only the trips under 3 miles): the modes of the return primary leg (also by its period) and
of the stop legs, and the share of tours with at least one trip by each other mode; and the joint
modes of the two primary legs over all tours. The model's statistics are computed by the same rule
(demand.ts tripMix), so its latent tour mode never has to be read off the survey.
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-tripmode.json
Run: python3 server/beta3/pipeline/nhts_tripmode.py
"""
import csv, io, json, math, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-tripmode.json')
HOME = {'01', '02'}
MODES = ['da', 'sr', 'tnc', 'transit', 'walk', 'bike']
RANK = {'transit': 6, 'tnc': 5, 'sr': 4, 'da': 3, 'bike': 2, 'walk': 1}
PERIODS = ['EA', 'AM', 'MD', 'PM', 'EV']


def act(why, age):
    w = int(why) if why.lstrip('-').isdigit() else -1
    if w in (3, 4): return 'work'
    if w == 8: return 'school' if age < 18 else 'univ'
    if w in (11, 12): return 'shop'
    if w in (13, 15, 16, 17, 19): return 'social'
    if w == 7: return None  # changing mode is not an activity
    return 'other'


def seg_mode(t):
    m = t['TRPTRANS']
    if m == '01': return 'walk'
    if m == '02': return 'bike'
    if m in ('03', '04', '05', '06', '08', '18'):
        n = int(t['NUMONTRP']) if t['NUMONTRP'].lstrip('-').isdigit() else 1
        return 'sr' if n > 1 else 'da'
    if m == '17': return 'tnc'
    if m in ('11', '13', '14', '15', '16', '20'): return 'transit'
    return None


def period(hhmm):
    h = int(hhmm) // 100
    return 'EA' if 3 <= h < 6 else 'AM' if 6 <= h < 10 else 'MD' if 10 <= h < 15 else 'PM' if 15 <= h < 19 else 'EV'


PRIORITY = {'work': 0, 'school': 1, 'univ': 1}
# stop legs by their length (miles, as the NHTS reports trip miles): the model fits transit tours' stop
# legs band by band, so the walk share is not fitted on legs of the wrong length
STOP_BAND_MI = [0.5, 1.5, float('inf')]
STOP_BANDS = ['upTo0.5mi', '0.5to1.5mi', 'over1.5mi']
z = zipfile.ZipFile(os.path.join(RAW, 'params/nhts2017/csv.zip'))
hdens = {}
with z.open('hhpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] == '41860': hdens[r['HOUSEID']] = int(r['HTPPOPDN']) if r['HTPPOPDN'].lstrip('-').isdigit() else -1
days = defaultdict(list)
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != '41860' or int(r['TRAVDAY']) in (1, 7): continue
        if hdens.get(r['HOUSEID'], -1) < 17000: continue
        days[(r['HOUSEID'], r['PERSONID'])].append(r)


def acc():
    return {'n': 0, 'w': 0.0, 'mixed': 0.0, 'otherShort': defaultdict(float), 'stopBand': defaultdict(lambda: defaultdict(float)), 'stopBandN': defaultdict(int), 'ret': defaultdict(float), 'retN': defaultdict(int), 'stop': defaultdict(float), 'stopN': 0, 'stopOut': defaultdict(float), 'stopBack': defaultdict(float),
            'all': defaultdict(float), 'anyOther': defaultdict(float), 'retByPeriod': defaultdict(lambda: defaultdict(float)), 'retByPeriodN': defaultdict(int)}


BY = defaultdict(acc)       # by the mode of the primary outbound leg
BYP = defaultdict(lambda: defaultdict(acc))  # and by tour purpose group (work and school, other)
HIER = defaultdict(lambda: {'n': 0, 'w': 0.0, 'all': defaultdict(float)})  # by the highest mode of any trip
JOINT = defaultdict(float)  # (out primary, return primary)
JOINT_N = defaultdict(int)
skipped = {'otherMode': 0, 'noActivity': 0}
for trips in days.values():
    trips.sort(key=lambda r: int(r['TDTRPNUM']))
    age = int(trips[0]['R_AGE']) if trips[0]['R_AGE'].lstrip('-').isdigit() else 30
    w = float(trips[0]['WTTRDFIN'])
    tour = []
    for r in trips:
        if r['WHYFROM'] in HOME and tour: tour = []
        tour.append(r)
        if not (r['WHYTO'] in HOME and tour[0]['WHYFROM'] in HOME): continue
        # link segments into trips between activities (or home)
        legs = []  # [mode, start period, activity at the end or None for home, dwell, miles]
        cur = None
        for i, t in enumerate(tour):
            m = seg_mode(t)
            if cur is None: cur = [m, period(t['STRTTIME']), 0.0]
            elif m is None or cur[0] is None: cur[0] = None
            elif RANK[m] > RANK[cur[0]]: cur[0] = m
            cur[2] += max(0.0, float(t['TRPMILES']))
            a = None if t['WHYTO'] in HOME else act(t['WHYTO'], age)
            if i == len(tour) - 1 or a is not None:
                dwell = float(t['DWELTIME']) if t['DWELTIME'].lstrip('-').replace('.', '').isdigit() else 0
                legs.append((cur[0], cur[1], a, dwell, cur[2]))
                cur = None
        tour = []
        acts = [k for k, l in enumerate(legs[:-1]) if l[2] is not None]
        if not acts:
            skipped['noActivity'] += 1; continue
        if any(l[0] is None for l in legs):
            skipped['otherMode'] += 1; continue
        k = min(acts, key=lambda j: (PRIORITY.get(legs[j][2], 2), -legs[j][3]))
        out, back = legs[k], legs[k + 1]
        M = out[0]
        grp = 'mandatory' if legs[k][2] in ('work', 'school', 'univ') else 'nonMandatory'
        for S in (BY[M], BYP[grp][M]):
            S['n'] += 1; S['w'] += w
            S['ret'][back[0]] += w; S['retN'][back[0]] += 1
            S['retByPeriod'][back[1]][back[0]] += w; S['retByPeriodN'][back[1]] += 1
            for j, l in enumerate(legs):
                S['all'][l[0]] += w
                if j != k and l[4] < 3: S['otherShort'][l[0]] += w
                if j not in (k, k + 1):
                    S['stop'][l[0]] += w; S['stopN'] += 1
                    b = STOP_BANDS[min(k2 for k2, hi in enumerate(STOP_BAND_MI) if l[4] <= hi)]
                    S['stopBand'][b][l[0]] += w; S['stopBandN'][b] += 1
                    (S['stopOut'] if j < k else S['stopBack'])[l[0]] += w
            for m in set(l[0] for l in legs) - {M}: S['anyOther'][m] += w
            if any(l[0] != M for l in legs): S['mixed'] += w
        JOINT[(out[0], back[0])] += w; JOINT_N[(out[0], back[0])] += 1
        H = max((l[0] for l in legs), key=lambda m: RANK[m])
        HIER[H]['n'] += 1; HIER[H]['w'] += w
        for l in legs: HIER[H]['all'][l[0]] += w


def norm(d):
    s = sum(d.values())
    return {m: round(d[m] / s, 4) for m in MODES if d.get(m)} if s else {}


def summary(S):
    o = {'tours_sample': S['n'], 'returnLeg': norm(S['ret']), 'returnLeg_sample': {m: S['retN'][m] for m in MODES if S['retN'].get(m)},
         'stopLegs': norm(S['stop']), 'stopLegs_sample': S['stopN'],
         'stopLegsByLength': {b: {'sample': S['stopBandN'][b], 'weight': round(sum(S['stopBand'][b].values()) / max(1e-9, sum(S['stop'].values())), 4), **norm(S['stopBand'][b])} for b in STOP_BANDS if S['stopBandN'].get(b)}, 'stopLegsOut': norm(S['stopOut']), 'stopLegsBack': norm(S['stopBack']),
         'allTrips': norm(S['all']), 'toursWithATripBy': {m: round(S['anyOther'][m] / S['w'], 4) for m in MODES if S['anyOther'].get(m)},
         'toursWithAnotherMode': round(S['mixed'] / S['w'], 4)}
    # other trips (the return leg and the stops): what the model's targets are
    oth = defaultdict(float)
    for m, v in S['ret'].items(): oth[m] += v
    for m, v in S['stop'].items(): oth[m] += v
    o['otherTrips'] = norm(oth)
    # the same, counting only trips under 3 miles (the model's walk tours stay within walking range)
    o['otherTripsUnder3mi'] = norm(S['otherShort'])
    # the return leg by its period (NT: evening and early morning), where there are 30 or more tours
    rp = {}
    for p in ('AM', 'MD', 'PM', 'NT'):
        ps = ('EV', 'EA') if p == 'NT' else (p,)
        d = defaultdict(float)
        n = sum(S['retByPeriodN'][q] for q in ps)
        for q in ps:
            for m, v in S['retByPeriod'][q].items(): d[m] += v
        if n >= 30: rp[p] = {'sample': n, **norm(d)}
    o['returnLegByPeriod'] = rp
    return o


tot = sum(JOINT.values())
out = {
    'source': 'NHTS 2017 public microdata (FHWA), weekday person-days of residents of the San Francisco–Oakland–Hayward CBSA (41860) in tracts of 17,000+ persons per square mile; server/beta3/pipeline/nhts_tripmode.py',
    'url': 'https://nhts.ornl.gov/',
    'definition': 'tour mode = mode of the linked trip into the primary destination; linked trip mode = highest of its segments: transit > tnc > sr > da > bike > walk',
    'skipped_tours': skipped,
    'byTourMode': {M: summary(S) for M, S in BY.items()},
    'byPurposeGroup': {g: {M: summary(S) for M, S in v.items()} for g, v in BYP.items()},
    'byHighestMode': {H: {'tours_sample': v['n'], 'allTrips': norm(v['all'])} for H, v in HIER.items()},
    'primaryLegs': {f'{a}>{b}': {'share': round(v / tot, 5), 'sample': JOINT_N[(a, b)]} for (a, b), v in sorted(JOINT.items(), key=lambda x: -x[1])},
}
json.dump(out, open(OUT, 'w'), indent=1)
for M in MODES:
    if M in out['byTourMode']:
        s = out['byTourMode'][M]
        print(M, s['tours_sample'], 'return', s['returnLeg'], '| stops', s['stopLegs'], s['stopLegs_sample'], '| other', s['otherTrips'], '| any', s['toursWithATripBy'], 'mixed', s['toursWithAnotherMode'])
        print('   return by period', s['returnLegByPeriod'])
print('skipped', skipped)
print('primary legs', {k: v for k, v in list(out['primaryLegs'].items())[:16]})
