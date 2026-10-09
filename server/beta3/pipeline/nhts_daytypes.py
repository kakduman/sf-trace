"""
Trip rates, time of day and direction by day type (weekday, Saturday, Sunday) for residents of
the San Francisco–Oakland metro (HH_CBSA 41860), from the 2017 NHTS public microdata.
Same method as the weekday figures in reference/params.json (computed by the parameter research):
  trips/person/day = sum(trip weight on that day type) / (days of that type per year) / sum(all person weights)
  (trip weights expand to annual trips by the whole population; person weights to the population)
Purposes are NHTS TRIPPURP (HBW, HBSHOP, HBSOCREC, HBO, NHB) with home<->school trips split out
of HBO by age (<18 K-12, else university). Periods follow MTC Travel Model One.
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-daytypes.json
Run: python3 server/beta3/pipeline/nhts_daytypes.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
ZIP = os.path.join(ROOT, 'data/beta3/raw/params/nhts2017/csv.zip')
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-daytypes.json')
CBSA = '41860'
DAYS = {'weekday': 365 * 5 / 7, 'saturday': 365 / 7, 'sunday': 365 / 7}

def daytype(travday):
    d = int(travday)
    return 'sunday' if d == 1 else 'saturday' if d == 7 else 'weekday'

def period(hhmm):
    h = int(hhmm) // 100
    if 3 <= h < 6: return 'EA'
    if 6 <= h < 10: return 'AM'
    if 10 <= h < 15: return 'MD'
    if 15 <= h < 19: return 'PM'
    return 'EV'

z = zipfile.ZipFile(ZIP)
# persons: weight by day type
pw = defaultdict(float)
with z.open('perpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != CBSA: continue
        pw['all'] += float(r['WTPERFIN'])
trips = defaultdict(float)
per = defaultdict(lambda: defaultdict(float))
home = defaultdict(lambda: defaultdict(float))
n = defaultdict(int)
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != CBSA: continue
        dt = daytype(r['TRAVDAY'])
        w = float(r['WTTRDFIN'])
        p = r['TRIPPURP']
        wf, wt = r['WHYFROM'], r['WHYTO']
        if p == 'HBO' and ('08' in (wf, wt)) and ((wf in ('01', '02')) or (wt in ('01', '02'))):
            p = 'HBSCH_K12' if 0 <= int(r['R_AGE']) < 18 else 'HBUNIV'
        if p not in ('HBW', 'HBSHOP', 'HBSOCREC', 'HBO', 'NHB', 'HBSCH_K12', 'HBUNIV'): continue
        if not r['STRTTIME'].lstrip('-').isdigit() or int(r['STRTTIME']) < 0: continue
        k = (dt, p)
        trips[k] += w
        n[k] += 1
        pr = period(r['STRTTIME'])
        per[k][pr] += w
        if wf in ('01', '02'): home[k][pr] += w

out = {
    'source': 'NHTS 2017 public microdata (FHWA), households in the San Francisco–Oakland–Hayward CBSA (41860); computed by server/beta3/pipeline/nhts_daytypes.py',
    'url': 'https://nhts.ornl.gov/',
    'method': 'trips/person/day = sum(WTTRDFIN on the day type) / days of that type per year / sum(WTPERFIN over all persons). Purposes TRIPPURP; school split from HBO by age. Periods EA 3-6, AM 6-10, MD 10-15, PM 15-19, EV 19-3.',
    'byDayType': {},
}
for dt in DAYS:
    d = {}
    for p in ('HBW', 'HBSHOP', 'HBSOCREC', 'HBO', 'NHB', 'HBSCH_K12', 'HBUNIV'):
        k = (dt, p)
        if not trips[k]: continue
        tot = trips[k]
        d[p] = {
            'n_trips_sample': n[k],
            'trips_per_person': trips[k] / DAYS[dt] / pw['all'],
            'period_share': {q: per[k][q] / tot for q in ('EA', 'AM', 'MD', 'PM', 'EV')},
            'from_home_share': {q: (home[k][q] / per[k][q] if per[k][q] else 0) for q in ('EA', 'AM', 'MD', 'PM', 'EV')},
        }
    out['byDayType'][dt] = d
json.dump(out, open(OUT, 'w'), indent=1)
for dt, d in out['byDayType'].items():
    print(dt, {p: round(v['trips_per_person'], 3) for p, v in d.items()}, 'n', sum(v['n_trips_sample'] for v in d.values()))
