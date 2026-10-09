"""
Tours from the 2017 NHTS: each weekday person-day of a resident of the San Francisco–Oakland metro
(HH_CBSA 41860) is cut into home-based tours (home → ... → home). A tour's primary activity is work if
any, else school (K-12 under 18, else college), else the longest stay; the other activities on the
way out and back are stops. Gives, by tour purpose: the share of half-tours with a stop and stops per
half-tour with one; the stops' purposes; the share of stops nearer home than the primary destination
(the shorter of its two legs); and work-based subtours (work → … → work) per work tour. For residents
of dense tracts (10,000+ people per square mile), the distance from home to the primary destination
and the detour to a stop are also given as shares by road-distance band (BANDS_MI, up to 12 miles),
and as means over the trips of up to 5 miles: the distributions destination choice and stop placement
are fitted to (trip-lengths.ts).
Purposes: shop = buying goods or services (11, 12); social = meals, recreation, exercise, visiting,
religious or community (13, 15–17, 19); other = everything else (errands, escorting, care, health).
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-tours.json
Run: python3 server/beta3/pipeline/nhts_tours.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-tours.json')
HOME = {'01', '02'}

def act(why, age):
    w = int(why) if why.lstrip('-').isdigit() else -1
    if w in (3, 4): return 'work'
    if w == 8: return 'school' if age < 18 else 'univ'
    if w in (11, 12): return 'shop'
    if w in (13, 15, 16, 17, 19): return 'social'
    if w == 7: return None  # changing mode is not an activity
    return 'other'

PRIORITY = {'work': 0, 'school': 1, 'univ': 1}
z = zipfile.ZipFile(os.path.join(os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw')), 'params/nhts2017/csv.zip'))
BANDS_MI = [0.5, 1, 1.5, 2, 3, 5, 8, 12]
band = lambda mi: next(i for i, b in enumerate(BANDS_MI) if mi <= b)
# persons (all ages in the person file) for tours per person
persons = 0.0
with z.open('perpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] == '41860': persons += float(r['WTPERFIN'])
# home tract density, for the dense-neighborhood distances (as in nhts_triplength.py)
hdens = {}
with z.open('hhpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] == '41860': hdens[r['HOUSEID']] = int(r['HTPPOPDN']) if r['HTPPOPDN'].lstrip('-').isdigit() else -1
days = defaultdict(list)
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != '41860' or int(r['TRAVDAY']) in (1, 7): continue
        days[(r['HOUSEID'], r['PERSONID'])].append(r)

def mode_class(t):
    m = t['TRPTRANS']
    if m == '01': return 'walk'
    if m == '02': return 'bike'
    if m in ('11', '15', '16', '12', '14'): return 'transit'
    return 'car'

# by the tour's mode (that of the trip reaching the primary destination): stops per half, detour length
MC = defaultdict(lambda: {'halves': 0.0, 'stops': 0.0, 'detourMi': 0.0, 'detourW': 0.0, 'n': 0, 'bands': [0.0] * len(BANDS_MI), 'nDense': 0, 'detour5': [0.0, 0.0]})
T = defaultdict(lambda: {'n': 0, 'w': 0.0, 'halves': 0.0, 'halvesWithStop': 0.0, 'stops': 0.0, 'nearHome': 0.0, 'stopPurpose': defaultdict(float), 'subtours': 0.0, 'detourMi': 0.0, 'detourW': 0.0, 'directMi': 0.0, 'directW': 0.0, 'detourDenseMi': 0.0, 'detourDenseW': 0.0, 'bands': [0.0] * len(BANDS_MI), 'nDirect': 0, 'stopBands': [0.0] * len(BANDS_MI), 'direct5': [0.0, 0.0]})
for trips in days.values():
    trips.sort(key=lambda r: int(r['TDTRPNUM']))
    age = int(trips[0]['R_AGE']) if trips[0]['R_AGE'].lstrip('-').isdigit() else 30
    w = float(trips[0]['WTTRDFIN'])
    # split into tours: start at a departure from home, end at the next arrival home
    tour = []
    for r in trips:
        if r['WHYFROM'] in HOME and tour: tour = []
        tour.append(r)
        if r['WHYTO'] in HOME and tour and tour[0]['WHYFROM'] in HOME:
            acts = []  # (index of the trip arriving there, activity, dwell, miles in, miles out)
            for i, t in enumerate(tour[:-1]):
                a = act(t['WHYTO'], age)
                if a is None: continue
                dwell = float(t['DWELTIME']) if t['DWELTIME'].lstrip('-').replace('.', '').isdigit() else 0
                acts.append((i, a, dwell, float(tour[i]['TRPMILES']), float(tour[i + 1]['TRPMILES'])))
            if not acts:
                tour = []; continue
            # primary: work, then school, then the longest stay
            prim = min(range(len(acts)), key=lambda k: (PRIORITY.get(acts[k][1], 2), -acts[k][2]))
            p = acts[prim][1]
            s = T[p]; s['n'] += 1; s['w'] += w
            for half in (acts[:prim], acts[prim + 1:]):
                s['halves'] += w
                stops = [x for x in half if not (p == 'work' and x[1] == 'work')]
                if stops: s['halvesWithStop'] += w; s['stops'] += w * len(stops)
                for x in stops: s['stopPurpose'][x[1]] += w
            # nearer home: for the first stop out and the last stop back, the leg to/from home is the shorter
            out, back = acts[:prim], acts[prim + 1:]
            dense = hdens.get(tour[0]['HOUSEID'], -1) >= 17000
            mc = MC[mode_class(tour[acts[prim][0]])]
            mc['n'] += 1
            for half in (acts[:prim], acts[prim + 1:]):
                mc['halves'] += w
                mc['stops'] += w * len([x for x in half if not (p == 'work' and x[1] == 'work')])
            if dense:
                for x in acts[:prim] + acts[prim + 1:]:
                    if 0 < min(x[3], x[4]) <= 12:
                        mc['detourMi'] += w * min(x[3], x[4]); mc['detourW'] += w
                        mc['bands'][band(min(x[3], x[4]))] += w; mc['nDense'] += 1
                        if min(x[3], x[4]) <= 5: mc['detour5'][0] += w * min(x[3], x[4]); mc['detour5'][1] += w
            # the detour leg: the shorter of a stop's two legs (miles), for the stop-location distance decay
            for x in out + back:
                if min(x[3], x[4]) > 0:
                    s['detourMi'] += w * min(x[3], x[4]); s['detourW'] += w
                    if dense and min(x[3], x[4]) <= 12:
                        s['detourDenseMi'] += w * min(x[3], x[4]); s['detourDenseW'] += w
                        s['stopBands'][band(min(x[3], x[4]))] += w
            # home to the primary destination, on tours with no stop on the way out (dense tracts, up to 12 miles)
            if not out and dense:
                mi = float(tour[acts[prim][0]]['TRPMILES'])
                if 0 < mi <= 12:
                    s['directMi'] += w * mi; s['directW'] += w
                    s['bands'][band(mi)] += w; s['nDirect'] += 1
                    if mi <= 5: s['direct5'][0] += w * mi; s['direct5'][1] += w
            if out:
                x = out[0]; s['nearHome'] += w * (x[3] <= x[4]); s.setdefault('nearDen', 0.0); s['nearDen'] += w
            if back:
                x = back[-1]; s['nearHome'] += w * (x[4] <= x[3]); s.setdefault('nearDen', 0.0); s['nearDen'] += w
            # work-based subtours: work → other activities → work, within the tour
            if p == 'work':
                ws = [k for k, x in enumerate(acts) if x[1] == 'work']
                for a_, b_ in zip(ws, ws[1:]):
                    if b_ > a_ + 1: s['subtours'] += w
            tour = []

out = {'source': 'NHTS 2017 public microdata (FHWA), weekday person-days of residents of the San Francisco–Oakland–Hayward CBSA (41860); server/beta3/pipeline/nhts_tours.py', 'url': 'https://nhts.ornl.gov/', 'byTourPurpose': {}}
for p, s in T.items():
    sp = sum(s['stopPurpose'].values()) or 1
    out['byTourPurpose'][p] = {
        'tours_sample': s['n'],
        'toursPerPersonWeekday': s['w'] / (365 * 5 / 7) / persons,
        'meanDetourLegKm': s['detourMi'] / s['detourW'] * 1.609344 if s['detourW'] else None,
        'meanDetourLegKmDense': s['detourDenseMi'] / s['detourDenseW'] * 1.609344 if s['detourDenseW'] else None,
        'meanPrimaryKmDense': s['directMi'] / s['directW'] * 1.609344 if s['directW'] else None,
        'primaryBandsDense': [v / s['directW'] for v in s['bands']] if s['directW'] else None,
        'primarySampleDense': s['nDirect'],
        'meanPrimaryKmDenseUpTo5mi': s['direct5'][0] / s['direct5'][1] * 1.609344 if s['direct5'][1] else None,
        'detourBandsDense': [v / s['detourDenseW'] for v in s['stopBands']] if s['detourDenseW'] else None,
        'halfToursWithStop': s['halvesWithStop'] / s['halves'],
        'stopsPerHalfWithStop': s['stops'] / s['halvesWithStop'] if s['halvesWithStop'] else 0,
        'stopPurpose': {k: v / sp for k, v in s['stopPurpose'].items()},
        'stopNearHomeShare': s['nearHome'] / s.get('nearDen', 1),
        'workSubtoursPerTour': s['subtours'] / s['w'] if p == 'work' else None,
    }
out['byTourMode'] = {k: {'tours_sample': v['n'], 'stopsPerHalf': v['stops'] / v['halves'], 'meanDetourLegKmDense': v['detourMi'] / v['detourW'] * 1.609344 if v['detourW'] else None,
                          'detourBandsDense': [x / v['detourW'] for x in v['bands']] if v['detourW'] else None, 'detourSampleDense': v['nDense'],
                          'meanDetourLegKmDenseUpTo5mi': v['detour5'][0] / v['detour5'][1] * 1.609344 if v['detour5'][1] else None} for k, v in MC.items()}
out['bandsMi'] = BANDS_MI
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps(out['byTourMode'], indent=1))
for p, d in out['byTourPurpose'].items():
    print(p, d['tours_sample'], f"tours/person {d['toursPerPersonWeekday']:.3f} detour km {d['meanDetourLegKm']:.2f} dense {d['meanDetourLegKmDense'] or 0:.2f} primary dense {d['meanPrimaryKmDense'] or 0:.2f}", f"stop share {d['halfToursWithStop']:.2f}, stops/half {d['stopsPerHalfWithStop']:.2f}, near home {d['stopNearHomeShare']:.2f}", {k: round(v, 2) for k, v in d['stopPurpose'].items()}, d['workSubtoursPerTour'])
