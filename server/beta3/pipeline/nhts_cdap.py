"""
Day patterns and tour rates by ActivitySim / Travel Model One person type, from the 2017 NHTS:
weekday person-days of residents of the San Francisco–Oakland metro (HH_CBSA 41860), persons 5 and
over (NHTS records no trips for younger children).
- Person type (TM1): under 6 → 8, 6–15 → 7, full-time worker (WORKER 1, WKFTPT 1) → 1, 16–19 in
  K-12 (SCHTYP 1, 2) → 6, primary activity going to school (PRMACT 5) → 3, other workers → 2,
  65+ → 5, others → 4.
- Day pattern (CDAP): M if the day has a work activity (WHYTO 3, 4) or school (8); else N if it has
  any trip; else H (stayed home).
- Tours (as nhts_tours.py): home → ... → home; the primary activity is work if any, else school,
  else the longest stay. Non-mandatory purposes as ActivitySim's: escort (6, 9, 10), shopping (11),
  othmaint (12, 14, 18), eatout (13), social (17), othdiscr (5, 15, 16, 19, 97).
Person-days are weighted by WTPERFIN (the person weight; NHTS spreads travel days evenly over the
week). Trips are NHTS's (unlinked at changes of mode; 'change mode' trips, WHYTO 7, dropped).
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-cdap.json
Run: python3 server/beta3/pipeline/nhts_cdap.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-cdap.json')
HOME = {'01', '02'}
NM = {6: 'escort', 9: 'escort', 10: 'escort', 11: 'shopping', 12: 'othmaint', 14: 'othmaint', 18: 'othmaint', 13: 'eatout', 17: 'social'}

def act(why, age):
    w = int(why) if why.lstrip('-').isdigit() else -1
    if w in (3, 4): return 'work'
    if w == 8: return 'school' if age < 18 else 'univ'
    if w == 7: return None
    return NM.get(w, 'othdiscr')

def ptype(r):
    a = int(r['R_AGE'])
    if a < 6: return 8
    if a < 16: return 7
    if r['WORKER'] == '01' and r['WKFTPT'] == '01': return 1
    if a <= 19 and r['SCHTYP'] in ('01', '02'): return 6
    if r['PRMACT'] == '05': return 3
    if r['WORKER'] == '01': return 2
    return 5 if a >= 65 else 4

z = zipfile.ZipFile(os.path.join(RAW, 'params/nhts2017/csv.zip'))
P = {}
with z.open('perpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != '41860' or int(r['TRAVDAY']) in (1, 7) or int(r['R_AGE']) < 5: continue
        P[(r['HOUSEID'], r['PERSONID'])] = {'pt': ptype(r), 'w': float(r['WTPERFIN']), 'age': int(r['R_AGE']), 'trips': []}
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        k = (r['HOUSEID'], r['PERSONID'])
        if k in P: P[k]['trips'].append(r)

PUR = ['work', 'school', 'univ', 'escort', 'shopping', 'othmaint', 'eatout', 'social', 'othdiscr']
S = defaultdict(lambda: {'n': 0, 'w': 0.0, 'pat': defaultdict(float), 'tours': defaultdict(lambda: defaultdict(float)), 'trips': defaultdict(float), 'nPat': defaultdict(int)})
for p in P.values():
    trips = sorted(p['trips'], key=lambda r: int(r['TDTRPNUM']))
    acts = [act(t['WHYTO'], p['age']) for t in trips]
    pat = 'M' if any(a in ('work', 'school', 'univ') for a in acts) else 'N' if trips else 'H'
    s = S[p['pt']]
    s['n'] += 1; s['w'] += p['w']; s['pat'][pat] += p['w']; s['nPat'][pat] += 1
    s['trips'][pat] += p['w'] * sum(1 for t in trips if t['WHYTO'] != '07')
    tour = []
    for r in trips:
        if r['WHYFROM'] in HOME and tour: tour = []
        tour.append(r)
        if r['WHYTO'] in HOME and tour[0]['WHYFROM'] in HOME:
            xs = []
            for t in tour[:-1]:
                a = act(t['WHYTO'], p['age'])
                if a is None: continue
                d = float(t['DWELTIME']) if t['DWELTIME'].lstrip('-').replace('.', '').isdigit() else 0
                xs.append((a, d))
            if xs:
                pr = min(xs, key=lambda x: ({'work': 0, 'school': 1, 'univ': 1}.get(x[0], 2), -x[1]))[0]
                s['tours'][pat][pr] += p['w']
            tour = []

out = {'source': 'NHTS 2017 public microdata (FHWA), weekday person-days of residents aged 5+ of the San Francisco–Oakland–Hayward CBSA (41860); server/beta3/pipeline/nhts_cdap.py', 'url': 'https://nhts.ornl.gov/', 'byPtype': {}}
for pt in sorted(S):
    s = S[pt]
    out['byPtype'][str(pt)] = {
        'persons_sample': s['n'], 'sampleByPattern': dict(s['nPat']),
        'pattern': {k: s['pat'][k] / s['w'] for k in 'MNH'},
        # tours per person-day of that pattern, by primary purpose
        'toursGiven': {k: {pp: s['tours'][k][pp] / s['pat'][k] for pp in PUR if s['tours'][k][pp] > 0} for k in 'MN' if s['pat'][k] > 0},
        'tripsGiven': {k: s['trips'][k] / s['pat'][k] for k in 'MN' if s['pat'][k] > 0},
    }
json.dump(out, open(OUT, 'w'), indent=1)
for pt, d in out['byPtype'].items():
    print(pt, d['persons_sample'], {k: round(v, 3) for k, v in d['pattern'].items()}, {k: {a: round(b, 3) for a, b in v.items()} for k, v in d['toursGiven'].items()}, {k: round(v, 2) for k, v in d['tripsGiven'].items()})
