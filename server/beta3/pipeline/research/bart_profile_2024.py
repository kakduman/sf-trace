#!/usr/bin/env python3
"""BART 2024 Station Profile Study, home-origin one-pagers (BART Marketing and Research, v1 data
12/15/2025): per station, weekday (Tue-Thu) entries, home-origin entries, and the home-origin
access mode shares. Text extracted with pypdf (profile2024.txt); the seven mode shares are read in
the chart legend's order (Walk, Bicycle, Electric Scooter, Bus/Transit, Drive Alone/Carpool, Drop Off,
Uber/Lyft/taxi); '<1%' is kept as 0.5.
Input: data/beta3/raw/bart-profile/profile2024.txt (from Profile_OnePagers_121525.pdf)
Writes server/beta3/reference/bart-station-access-2024.json
"""
import json, os, re
RAW = os.environ.get('BETA3_RAW', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/data/beta3/raw') + '/bart-profile/'
OUT = os.path.join(os.path.dirname(__file__), '../../reference/bart-station-access-2024.json')
txt = open(RAW + 'profile2024.txt').read()
pages = txt.split('=== PAGE ')[1:]
MODES = ['walk', 'bike', 'scooter', 'busTransit', 'driveParkCarpool', 'dropOff', 'tnc']
rows, bad = [], []
for pg in pages:
    m = re.search(r'\n([A-Z0-9 .\'/&–-]+?) STATION – HOME ORIGINS', pg)
    if not m:
        continue
    name = m.group(1).strip()
    r = re.search(r'([\d,]+) riders enter .*?Of these riders, ([\d,]+)', pg, re.S)
    seg = pg[pg.index('\nOther') + 6: pg.index('Walk Bicycle')]
    vals = [0.5 if v == '<1' else float(v) for v in re.findall(r'(<1|\d+)%', seg)]
    row = {'station': name, 'entries': int(r.group(1).replace(',', '')) if r else None, 'homeOriginEntries': int(r.group(2).replace(',', '')) if r else None}
    if len(vals) == 7:
        row.update({k: v / 100 for k, v in zip(MODES, vals)})
    else:
        row['parseNote'] = f'{len(vals)} shares read: {vals}'
        bad.append(name)
    rows.append(row)
json.dump({
    'source': 'BART Marketing and Research Department, 2024 BART Station Profile Study, Station Profiles - Home Origins (v1 data, 12/15/2025)',
    'url': 'https://www.bart.gov/sites/default/files/2025-12/Profile_OnePagers_121525.pdf',
    'accessed': '2026-10-05',
    'rawFile': 'data/beta3/raw/bart-profile/bart_station_profile_2024_onepagers.pdf',
    'universe': 'riders entering each station from home on an average Tuesday-Thursday; shares of those home-origin riders by access mode',
    'modes': MODES,
    'generated_by': 'server/beta3/pipeline/research/bart_profile_2024.py',
    'stations': rows,
}, open(OUT, 'w'), indent=1)
print(len(rows), 'stations;', 'unparsed:', bad)
for r in rows[:60]:
    print(r['station'][:30].ljust(30), r.get('homeOriginEntries'), ' '.join(f"{k}={r[k]:.2f}" for k in MODES if k in r))
