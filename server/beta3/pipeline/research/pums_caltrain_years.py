#!/usr/bin/env python3
"""
Commutes between San Francisco and San Mateo and Santa Clara counties by survey year, from the ACS
2020-2024 5-year PUMS person file for California: the pooled file's records keep their survey year
(the first four characters of SERIALNO), so each year's commuters by mode can be read on their own
(each year's records carry about a fifth of the 5-year weights, so a year's weighted count times 5 is
that year's estimate). Shows how far the pooled county commute shares (commute-by-county.json, the
calibration's county targets) lag Caltrain's riders in the model year.

Workers: JWTRNS not blank, worked-from-home (11) left out. Residence county from PUMA (2020 tract
to PUMA file), workplace county from POWSP 006 and POWPUMA (county FIPS x 100), as in
commute-county/build_json.py.

Input: $BETA3_RAW/commute-county/csv_pca_2024_5yr.zip, 2020_Census_Tract_to_2020_PUMA.txt
Output: JSON on stdout (copied into reference/caltrain-direction.json)
Run: python3 -I server/beta3/pipeline/research/pums_caltrain_years.py
"""
import csv, json, os, subprocess, sys

RAW = os.path.join(os.environ.get('BETA3_RAW', os.path.join(os.path.dirname(__file__), '../../../../data/beta3/raw')), 'commute-county')
puma_cty = {}
for r in csv.DictReader(open(os.path.join(RAW, '2020_Census_Tract_to_2020_PUMA.txt'), encoding='utf-8-sig')):
    if r['STATEFP'] == '06':
        puma_cty.setdefault(r['PUMA5CE'], set()).add(r['COUNTYFP'])
puma_cty = {k: (next(iter(v)) if len(v) == 1 else 'multi') for k, v in puma_cty.items()}
NAMES = {'075': 'San Francisco', '081': 'San Mateo', '085': 'Santa Clara'}
MODE = {'02': 'bus', '03': 'subway', '04': 'commuterRail'}

p = subprocess.Popen(['unzip', '-p', os.path.join(RAW, 'csv_pca_2024_5yr.zip'), 'psam_p06.csv'], stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
rd = csv.reader(p.stdout)
h = next(rd)
iS, iP, iPW, iPS, iJ, iW = (h.index(c) for c in ('SERIALNO', 'PUMA', 'POWPUMA', 'POWSP', 'JWTRNS', 'PWGTP'))
agg = {}
for row in rd:
    j = row[iJ]
    if not j.strip() or j == '11':
        continue
    home = puma_cty.get(row[iP])
    if row[iPS] != '006' or not row[iPW].endswith('00'):
        continue
    work = row[iPW][:3]
    if home != '075' and work != '075':
        continue
    if home not in NAMES or work not in NAMES:
        # other counties: all modes only, as 'San Francisco -> other' or 'other -> San Francisco'
        flow = f"{NAMES.get(home, 'other:' + str(home))} -> {NAMES.get(work, 'other:' + work)}"
        a = agg.setdefault(flow, {}).setdefault('all', {}).setdefault(row[iS][:4], [0, 0])
        a[0] += int(row[iW])
        a[1] += 1
        continue
    flow = f"{NAMES[home]} -> {NAMES[work]}"
    yr = row[iS][:4]
    for m in ('all', MODE.get(j)):
        if m is None:
            continue
        a = agg.setdefault(flow, {}).setdefault(m, {}).setdefault(yr, [0, 0])
        a[0] += int(row[iW])
        a[1] += 1
p.wait()
json.dump(agg, sys.stdout, indent=1, sort_keys=True)
