"""
Weekday trip rates by age group relative to all persons, by purpose, for residents of the San
Francisco–Oakland metro (HH_CBSA 41860), from the 2017 NHTS public microdata. Used to split home-based
shopping, other, and social trips among youth (5–17), adults (18–64), and seniors (65+) in demand.ts.
Rates as in nhts_daytypes.py: sum of trip weights / weekdays per year / sum of person weights.
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-persontypes.json
Run: python3 server/beta3/pipeline/nhts_persontypes.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
ZIP = os.path.join(ROOT, 'data/beta3/raw/params/nhts2017/csv.zip')
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-persontypes.json')
CBSA, WEEKDAYS = '41860', 365 * 5 / 7

def group(age):
    a = int(age)
    if a < 0: return None
    return 'youth' if a < 18 else 'senior' if a >= 65 else 'adult'

z = zipfile.ZipFile(ZIP)
pw = defaultdict(float)
with z.open('perpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != CBSA: continue
        g = group(r['R_AGE'])
        if g is None: continue
        w = float(r['WTPERFIN'])
        pw[g] += w; pw['all'] += w
trips = defaultdict(float); n = defaultdict(int)
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != CBSA or int(r['TRAVDAY']) in (1, 7): continue
        g = group(r['R_AGE'])
        if g is None: continue
        p = r['TRIPPURP']
        wf, wt = r['WHYFROM'], r['WHYTO']
        if p == 'HBO' and ('08' in (wf, wt)) and ((wf in ('01', '02')) or (wt in ('01', '02'))): continue  # school, modeled apart
        if p not in ('HBSHOP', 'HBSOCREC', 'HBO'): continue
        w = float(r['WTTRDFIN'])
        trips[(g, p)] += w; trips[('all', p)] += w; n[(g, p)] += 1

out = {
    'source': 'NHTS 2017 public microdata (FHWA), weekday trips by residents of the San Francisco–Oakland–Hayward CBSA (41860); computed by server/beta3/pipeline/nhts_persontypes.py',
    'url': 'https://nhts.ornl.gov/',
    'method': 'Trips per person per weekday by age group (youth 5–17 as NHTS records trips from age 5, adults 18–64, seniors 65+), relative to all persons; home-based school trips excluded from HBO.',
    'personShare': {g: pw[g] / pw['all'] for g in ('youth', 'adult', 'senior')},
    'relativeRate': {p: {g: (trips[(g, p)] / pw[g]) / (trips[('all', p)] / pw['all']) for g in ('youth', 'adult', 'senior')} for p in ('HBSHOP', 'HBSOCREC', 'HBO')},
    'n_trips_sample': {f'{g}:{p}': n[(g, p)] for (g, p) in n},
}
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps(out, indent=1))
