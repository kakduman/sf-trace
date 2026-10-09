#!/usr/bin/env python3
"""In-commuters to San Francisco from ACS 2020-2024 5-year PUMS (California person and housing
files): by residence PUMA, workers whose place of work is San Francisco (POWSP 006, POWPUMA 07500),
their means of transportation, and their household's vehicles available (VEH). Weighted (PWGTP).
Writes server/beta3/reference/in-commuters-pums.json.

Inputs (data/beta3/raw/commute-county/): csv_pca_2024_5yr.zip, csv_hca_2024_5yr.zip
(https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/csv_pca.zip, csv_hca.zip),
2020_Census_Tract_to_2020_PUMA.txt.
Run: python3 server/beta3/pipeline/research/pums_incommuters.py
"""
import csv, json, os, subprocess, collections

RAW = os.environ.get('BETA3_RAW', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/data/beta3/raw') + '/commute-county/'
OUT = os.path.join(os.path.dirname(__file__), '../../reference/in-commuters-pums.json')
puma_cty = {}
for r in csv.DictReader(open(RAW + '2020_Census_Tract_to_2020_PUMA.txt', encoding='utf-8-sig')):
    if r['STATEFP'] == '06':
        puma_cty.setdefault(r['PUMA5CE'], set()).add(r['COUNTYFP'])
puma_cty = {k: '+'.join(sorted(v)) for k, v in puma_cty.items()}
TRANSIT = {'02': 'bus', '03': 'subway', '04': 'commuterRail', '05': 'lightRail', '06': 'ferry'}

def stream(z, f):
    p = subprocess.Popen(['unzip', '-p', RAW + z, f], stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    rd = csv.reader(p.stdout)
    return rd, next(rd)

rd, h = stream('csv_pca_2024_5yr.zip', 'psam_p06.csv')
iS, iP, iPW, iPS, iJ, iW = (h.index(c) for c in ('SERIALNO', 'PUMA', 'POWPUMA', 'POWSP', 'JWTRNS', 'PWGTP'))
workers = []
for row in rd:
    if row[iPS] != '006' or row[iPW] != '07500' or not row[iJ].strip() or row[iJ] == '11':
        continue
    if puma_cty.get(row[iP], '').startswith('075'):
        continue  # residents of the city
    workers.append((row[iS], row[iP], row[iJ], int(row[iW])))
need = {w[0] for w in workers}
rd, h = stream('csv_hca_2024_5yr.zip', 'psam_h06.csv')
iS, iV = h.index('SERIALNO'), h.index('VEH')
veh = {}
for row in rd:
    if row[iS] in need:
        veh[row[iS]] = int(row[iV]) if row[iV].strip() else -1
agg = collections.defaultdict(lambda: collections.Counter())
for s, puma, j, w in workers:
    v = veh.get(s, -1)
    a = agg[puma]
    a['workers'] += w
    a['n'] += 1
    t = j in TRANSIT
    a['transit'] += w * t
    if t:
        a[TRANSIT[j]] += w
    if v == 0:
        a['zeroCar'] += w
        a['zeroCarTransit'] += w * t
    elif v > 0:
        a['withCar'] += w
        a['withCarTransit'] += w * t
rows = []
for puma, a in sorted(agg.items(), key=lambda x: -x[1]['workers']):
    rows.append({'puma': puma, 'county': puma_cty.get(puma), **{k: a[k] for k in ('workers', 'n', 'transit', 'bus', 'subway', 'commuterRail', 'lightRail', 'ferry', 'zeroCar', 'zeroCarTransit', 'withCar', 'withCarTransit')}})
by_cty = collections.defaultdict(collections.Counter)
for r in rows:
    for k, v in r.items():
        if isinstance(v, int):
            by_cty[r['county']][k] += v
json.dump({
    'source': 'ACS 2020-2024 5-year PUMS, California person (psam_p06) and housing (psam_h06) files, U.S. Census Bureau',
    'url': 'https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/',
    'universe': 'workers 16+ not working from home (JWTRNS != 11) whose place of work is San Francisco (POWSP 006, POWPUMA 07500) and who live outside the city; weighted by PWGTP',
    'fields': 'transit = bus + subway (BART) + commuterRail + lightRail + ferry (JWTRNS 02-06); zeroCar/withCar by household vehicles available (VEH); n = unweighted records',
    'generated_by': 'server/beta3/pipeline/research/pums_incommuters.py',
    'byCounty': {k: dict(v) for k, v in sorted(by_cty.items(), key=lambda x: -x[1]['workers'])},
    'byPuma': rows,
}, open(OUT, 'w'), indent=1)
for k, v in sorted(by_cty.items(), key=lambda x: -x[1]['workers'])[:12]:
    print(k, v['workers'], 'transit %.2f' % (v['transit'] / v['workers']), 'zeroCar %.3f' % (v['zeroCar'] / v['workers']), 'transit|0car %.2f' % (v['zeroCarTransit'] / max(1, v['zeroCar'])), 'transit|car %.2f' % (v['withCarTransit'] / max(1, v['withCar'])))
