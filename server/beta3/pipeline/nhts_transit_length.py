"""
How far transit trips go, and how the choice between walking, transit, and driving changes with
distance, for residents of dense neighborhoods of the San Francisco–Oakland metro, weekdays, from the
2017 NHTS public microdata (with the California add-on sample). These are the checks behind
diag-length.ts: the model's trips inside the city by road distance and mode against these.

Sample: households in the SF–Oakland–Hayward CBSA (HH_CBSA 41860) whose home tract has 10,000 or more
people per square mile (HTPPOPDN category 17000 or 30000, the NHTS's top two density classes), trips
on Monday to Friday whose origin and destination tracts are also in those classes (OTPPOPDN,
DTPPOPDN), of 0–12 road miles (TRPMILES, the NHTS's shortest-path distance; the city's longest trip by
road is about 12 miles). Transit is TRPTRANS 11 (public or commuter bus) and 16 (subway, elevated,
light rail, streetcar); an NHTS trip is a linked trip (its changes of vehicle are inside it). Car is
TRPTRANS 3–6, 8, 18; ride-hail and taxi 17. Weighted by WTTRDFIN.
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-transit-length.json
Run: python3 server/beta3/pipeline/nhts_transit_length.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
ZIP = os.path.join(os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw')), 'params/nhts2017/csv.zip')
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-transit-length.json')
CBSA, DENSE, CAP_MI = '41860', 17000, 12.0
BANDS = [0.5, 1, 1.5, 2, 3, 5, 8, 12]
MODES = ['walk', 'transit', 'car', 'tnc', 'bike', 'other']

def band(mi):
    for i, b in enumerate(BANDS):
        if mi <= b: return i

def mode(t):
    t = int(t)
    if t == 1: return 'walk'
    if t == 2: return 'bike'
    if t in (11, 16): return 'transit'
    if t in (3, 4, 5, 6, 8, 18): return 'car'
    if t == 17: return 'tnc'
    return 'other'

z = zipfile.ZipFile(ZIP)
rd = lambda name: csv.DictReader(io.TextIOWrapper(z.open(name), 'utf-8'))
hh = {r['HOUSEID']: r for r in rd('hhpub.csv') if r['HH_CBSA'] == CBSA}
per = {(r['HOUSEID'], r['PERSONID']): r for r in rd('perpub.csv') if r['HOUSEID'] in hh}
trips = []
for r in rd('trippub.csv'):
    if r['HH_CBSA'] != CBSA or int(r['TRAVDAY']) in (1, 7): continue
    if int(hh[r['HOUSEID']]['HTPPOPDN']) < DENSE: continue
    try:
        ends = int(r['OTPPOPDN']) >= DENSE and int(r['DTPPOPDN']) >= DENSE
    except ValueError:
        ends = False
    mi = float(r['TRPMILES'])
    if mi <= 0 or mi > CAP_MI: continue
    h, p = hh[r['HOUSEID']], per[(r['HOUSEID'], r['PERSONID'])]
    trips.append({'m': mode(r['TRPTRANS']), 'w': float(r['WTTRDFIN']), 'b': band(mi), 'mi': mi, 'hb': r['TRIPPURP'].startswith('HB'),
                  'purp': r['TRIPPURP'], 'veh': int(h['HHVEHCNT']), 'age': int(r['R_AGE']), 'inc': int(h['HHFAMINC']), 'med': p['MEDCOND'] == '01',
                  'rail': r['TRPTRANS'] == '16', 'ends': ends})
# trips with a home end in any tract, for the distance checks (homeBasedAnyEnd); the rest keep both ends dense
allEnds = trips
trips = [t for t in trips if t['ends']]

def table(sel, src=None):
    acc = defaultdict(lambda: [0.0] * len(BANDS)); n = defaultdict(lambda: [0] * len(BANDS))
    for t in (trips if src is None else src):
        if sel(t): acc[t['m']][t['b']] += t['w']; n[t['m']][t['b']] += 1
    tot = [sum(acc[m][i] for m in MODES) for i in range(len(BANDS))]
    W = sum(tot)
    out = {'dist': [v / W for v in tot], 'sample': [sum(n[m][i] for m in MODES) for i in range(len(BANDS))]}
    for m in MODES:
        out[m] = [acc[m][i] / tot[i] if tot[i] else 0 for i in range(len(BANDS))]
        out[m + 'Total'] = sum(acc[m]) / W
    if src is not None:
        # the mean road miles of the trips of up to 5 miles (trip-lengths.ts)
        s5 = [t for t in src if sel(t) and t['mi'] <= 5]
        out['meanMiUpTo5'] = sum(t['w'] * t['mi'] for t in s5) / sum(t['w'] for t in s5)
    T = sum(acc['transit'])
    out['transitDist'] = [v / T for v in acc['transit']] if T else None
    out['transitSample'] = n['transit']
    return out

# mode shares by household vehicles (0, 1, 2+) for adults' commutes (HBW) and adults' other trips,
# residents of the same dense tracts, all distances and destinations (the shares the model's car
# segments are fitted to; calibrate.ts)
byveh = {g: [defaultdict(float) for _ in range(3)] for g in ('work', 'nonwork')}
nveh = {g: [defaultdict(int) for _ in range(3)] for g in ('work', 'nonwork')}
for r in rd('trippub.csv'):
    if r['HH_CBSA'] != CBSA or int(r['TRAVDAY']) in (1, 7) or int(r['R_AGE']) < 18: continue
    h = hh[r['HOUSEID']]
    if int(h['HTPPOPDN']) < DENSE or int(r['TRPTRANS']) < 0: continue
    g = 'work' if r['TRIPPURP'] == 'HBW' else 'nonwork'
    v, m, w = min(2, int(h['HHVEHCNT'])), mode(r['TRPTRANS']), float(r['WTTRDFIN'])
    byveh[g][v][m] += w; byveh[g][v]['all'] += w; nveh[g][v][m] += 1; nveh[g][v]['all'] += 1
byVehicles = {g: [{**{m: byveh[g][v][m] / byveh[g][v]['all'] for m in MODES}, 'sample': nveh[g][v]['all'], 'transitSample': nveh[g][v]['transit']} for v in range(3)] for g in byveh}

tr = [t for t in trips if t['m'] == 'transit']
W = sum(t['w'] for t in tr)
mean = lambda ts: sum(t['w'] * t['mi'] for t in ts) / sum(t['w'] for t in ts)
segments = {}
all_w = sum(t['w'] for t in trips)
for name, f in [('zeroCar', lambda t: t['veh'] == 0), ('age65plus', lambda t: t['age'] >= 65), ('incomeUnder50k', lambda t: 0 < t['inc'] <= 5),
                ('incomeUnder100k', lambda t: 0 < t['inc'] <= 7), ('medicalCondition', lambda t: t['med'])]:
    s = [t for t in tr if f(t)]
    segments[name] = {'shareOfTransitTrips': sum(t['w'] for t in s) / W, 'shareOfAllTrips': sum(t['w'] for t in trips if f(t)) / all_w,
                      'transitMeanMi': mean(s), 'transitSample': len(s)}
out = {
    'source': 'NHTS 2017 public microdata (FHWA, with the California add-on sample), computed by server/beta3/pipeline/nhts_transit_length.py',
    'url': 'https://nhts.ornl.gov/',
    'sample': 'Weekday trips of 0–12 road miles by residents of the SF–Oakland–Hayward CBSA living in tracts of 10,000+ people per square mile, between tracts of that density (the NHTS density classes 10,000–24,999 and 25,000+).',
    'bandsMi': BANDS,
    'note': 'Shares by distance band are the mode shares of all trips in the band; dist is the band\'s share of all trips; transitDist the band\'s share of transit trips. Bands with fewer than about 30 sampled trips of a mode are noisy.',
    'allTrips': table(lambda t: True),
    'homeBased': {'byBand': table(lambda t: t['hb'])},
    'notHomeBased': {'byBand': table(lambda t: not t['hb'])},
    'anyEnd': {'note': 'As above, but trips to and from tracts of any density (still from dense homes, up to 12 miles). Leaving out the trips with an end in a less dense tract (downtown offices, parks, the Presidio, the suburbs) shortens the distribution: these are the trips the city\'s destinations include.',
               'all': table(lambda t: True, allEnds), 'homeBased': table(lambda t: t['hb'], allEnds), 'notHomeBased': table(lambda t: not t['hb'], allEnds)},
    'zeroCar': {'byBand': table(lambda t: t['veh'] == 0)},
    'withCar': {'byBand': table(lambda t: t['veh'] > 0)},
    'transitTrips': {'n': len(tr), 'meanMi': mean(tr), 'dist': table(lambda t: True)['transitDist'],
                     'meanMiBus': mean([t for t in tr if not t['rail']]), 'meanMiRail': mean([t for t in tr if t['rail']]),
                     'meanMiByPurpose': {p: mean([t for t in tr if t['purp'] == p]) for p in sorted({t['purp'] for t in tr}) if sum(1 for t in tr if t['purp'] == p) >= 20}},
    'segments': segments,
    'byVehicles': {'note': 'Adults (18+) in households with 0, 1, and 2+ vehicles: mode shares of their weekday commutes (HBW) and of their other trips, residents of the same dense tracts, trips of any length and destination.', **byVehicles},
}
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps({k: out[k] for k in ('transitTrips', 'segments', 'byVehicles')}, indent=1))
