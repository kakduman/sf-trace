"""
When home-based tours travel, from the 2017 NHTS: each weekday person-day of a resident of the San
Francisco–Oakland metro (HH_CBSA 41860) is cut into home-based tours as in nhts_tours.py (primary
activity: work, else school, else the longest stay). For each tour purpose it gives the period in
which the tour's leg into its primary destination starts (the outbound leg) and the period in which
the leg leaving it starts (the return leg; for work and school, the first arrival and the last
departure), for all tours and for transit tours (the mode of the leg
into the primary destination), and the joint outbound × return shares. Each half of a tour is one
trip in the model, so these are the shares the model's two legs need (trip-based HBW/HBO shares
mix in the trips of tours with stops, whose legs NHTS files as trips not from home, which is why
their two directions do not balance).
Periods: EA 3–6, AM 6–10, MD 10–15, PM 15–19, EV 19–3 (the model's; NT = EV + EA).
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-tour-tod.json
Run: python3 server/beta3/pipeline/nhts_tour_tod.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-tour-tod.json')
HOME = {'01', '02'}
P = ['EA', 'AM', 'MD', 'PM', 'EV']

def act(why, age):
    w = int(why) if why.lstrip('-').isdigit() else -1
    if w in (3, 4): return 'work'
    if w == 8: return 'school' if age < 18 else 'univ'
    if w in (11, 12): return 'shop'
    if w in (13, 15, 16, 17, 19): return 'social'
    if w == 7: return None
    return 'other'

def period(hhmm):
    h = int(hhmm) // 100
    return 'EA' if 3 <= h < 6 else 'AM' if h < 10 and h >= 6 else 'MD' if 10 <= h < 15 else 'PM' if 15 <= h < 19 else 'EV'

PRIORITY = {'work': 0, 'school': 1, 'univ': 1}
TRANSIT = {'11', '15', '16', '12', '14'}
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
z = zipfile.ZipFile(os.path.join(RAW, 'params/nhts2017/csv.zip'))
days = defaultdict(list)
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != '41860' or int(r['TRAVDAY']) in (1, 7): continue
        days[(r['HOUSEID'], r['PERSONID'])].append(r)

acc = {k: defaultdict(lambda: {'n': 0, 'out': defaultdict(float), 'ret': defaultdict(float), 'joint': defaultdict(float)}) for k in ('all', 'transit')}
for trips in days.values():
    trips.sort(key=lambda r: int(r['TDTRPNUM']))
    age = int(trips[0]['R_AGE']) if trips[0]['R_AGE'].lstrip('-').isdigit() else 30
    w = float(trips[0]['WTTRDFIN'])
    tour = []
    for r in trips:
        if r['WHYFROM'] in HOME and tour: tour = []
        tour.append(r)
        if r['WHYTO'] in HOME and tour and tour[0]['WHYFROM'] in HOME:
            acts = [(i, a, float(t['DWELTIME']) if t['DWELTIME'].lstrip('-').replace('.', '').isdigit() else 0)
                    for i, t in enumerate(tour[:-1]) for a in [act(t['WHYTO'], age)] if a is not None]
            if acts:
                k = min(range(len(acts)), key=lambda j: (PRIORITY.get(acts[j][1], 2), -acts[j][2]))
                p = acts[k][1]
                # work and school: from the first arrival there to the last departure (a lunch out
                # and back is a subtour, not the tour's legs); otherwise the primary stay itself
                same = [a[0] for a in acts if a[1] == p] if p in PRIORITY else [acts[k][0]]
                legIn, legOut = tour[same[0]], tour[same[-1] + 1]
                if int(legIn['STRTTIME']) >= 0 and int(legOut['STRTTIME']) >= 0:
                    po, pr = period(legIn['STRTTIME']), period(legOut['STRTTIME'])
                    for key in ('all', 'transit'):
                        if key == 'transit' and legIn['TRPTRANS'] not in TRANSIT: continue
                        s = acc[key][p]
                        s['n'] += 1; s['out'][po] += w; s['ret'][pr] += w; s['joint'][po + '-' + pr] += w
            tour = []

def norm(d):
    t = sum(d.values()) or 1
    return {k: round(d.get(k, 0) / t, 4) for k in P}

out = {'source': 'NHTS 2017 public microdata (FHWA), weekday person-days of residents of the San Francisco–Oakland–Hayward CBSA (41860); server/beta3/pipeline/nhts_tour_tod.py', 'url': 'https://nhts.ornl.gov/',
       'periods': {'EA': '03:00-05:59', 'AM': '06:00-09:59', 'MD': '10:00-14:59', 'PM': '15:00-18:59', 'EV': '19:00-02:59'},
       'definition': 'outbound: start time of the trip arriving at the tour\'s primary destination; return: start time of the trip leaving it', 'byTourPurpose': {}}
for key in ('all', 'transit'):
    for p, s in sorted(acc[key].items()):
        t = sum(s['joint'].values())
        out['byTourPurpose'].setdefault(p, {})[key] = {
            'tours_sample': s['n'], 'outbound': norm(s['out']), 'return': norm(s['ret']),
            'joint': {k: round(v / t, 4) for k, v in sorted(s['joint'].items(), key=lambda x: -x[1]) if v / t >= 0.01},
        }
json.dump(out, open(OUT, 'w'), indent=1)
for p, d in out['byTourPurpose'].items():
    for key, v in d.items():
        print(f"{p:7s} {key:8s} n={v['tours_sample']:5d} out {v['outbound']} ret {v['return']}")
    print('        joint (all)', d['all']['joint'])
