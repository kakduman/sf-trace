"""
Mean trip length by purpose for residents of dense neighborhoods of the San Francisco–Oakland metro
(HH_CBSA 41860, home tract density HTPPOPDN class 17000 or 30000, i.e. 10,000 or more people per square mile, as in most of San
Francisco), weekdays, from the 2017 NHTS public microdata. These are the destination-choice targets
in calibrate.ts. The model's check covers trips within the city, whose longest road distance is
about 12 miles, so trips longer than that are left out (the untrimmed means are reported too).
TRPMILES is the shortest-path road distance computed by the NHTS. Purposes as in nhts_daytypes.py.
Input: data/beta3/raw/params/nhts2017/csv.zip  Output: server/beta3/reference/nhts-triplength.json
Run: python3 server/beta3/pipeline/nhts_triplength.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
ZIP = os.path.join(ROOT, 'data/beta3/raw/params/nhts2017/csv.zip')
OUT = os.path.join(ROOT, 'server/beta3/reference/nhts-triplength.json')
CBSA, DENSE, CAP_MI = '41860', 17000, 12.0

z = zipfile.ZipFile(ZIP)
# home tract density is on the household file
hdens = {}
with z.open('hhpub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] == CBSA: hdens[r['HOUSEID']] = int(r['HTPPOPDN']) if r['HTPPOPDN'].lstrip('-').isdigit() else -1
acc = defaultdict(lambda: [0.0, 0.0, 0])  # weighted miles, weight, sample
raw = defaultdict(lambda: [0.0, 0.0])
dens = defaultdict(int)
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != CBSA: continue
        if int(r['TRAVDAY']) in (1, 7): continue
        d = hdens.get(r['HOUSEID'], -1)
        dens[d] += 1
        if d < DENSE: continue
        p = r['TRIPPURP']
        wf, wt = r['WHYFROM'], r['WHYTO']
        if p == 'HBO' and ('08' in (wf, wt)) and ((wf in ('01', '02')) or (wt in ('01', '02'))):
            p = 'HBSCH_K12' if 0 <= int(r['R_AGE']) < 18 else 'HBUNIV'
        if p not in ('HBW', 'HBSHOP', 'HBSOCREC', 'HBO', 'NHB', 'HBSCH_K12', 'HBUNIV'): continue
        mi = float(r['TRPMILES'])
        if mi <= 0: continue
        w = float(r['WTTRDFIN'])
        raw[p][0] += w * mi; raw[p][1] += w
        if mi > CAP_MI: continue
        a = acc[p]; a[0] += w * mi; a[1] += w; a[2] += 1

KM = 1.609344
out = {
    'source': 'NHTS 2017 public microdata (FHWA), weekday trips by residents of the San Francisco–Oakland–Hayward CBSA (41860) living in tracts of 10,000+ people per square mile (HTPPOPDN classes 17000 and 30000: 10,000-24,999 and 25,000+); computed by server/beta3/pipeline/nhts_triplength.py',
    'url': 'https://nhts.ornl.gov/',
    'method': f'Weighted (WTTRDFIN) mean TRPMILES by purpose, trips of 0–{CAP_MI:g} miles; untrimmed means also given.',
    'homeTractDensitySample': {str(k): v for k, v in sorted(dens.items())},
    'byPurpose': {p: {'meanKm': acc[p][0] / acc[p][1] * KM, 'meanKmUntrimmed': raw[p][0] / raw[p][1] * KM, 'n_trips_sample': acc[p][2]} for p in acc},
}
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps(out['byPurpose'], indent=1)); print(out['homeTractDensitySample'])
