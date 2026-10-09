"""
Observed transit markets for the origin-destination checks (od-checks.ts), with their sources:
on-board survey summaries (MTC Snapshot 2023-24, BART 2024 station profile, Muni 2017 on-board
survey, Caltrain 2024 OD and 2025 triennial) and, when downloaded, CTPP 2017-2021 commute flows by
means of transportation. Writes server/beta3/reference/od-validation.json.

Inputs (gitignored, under $BETA3_RAW or data/beta3/raw):
  od/onboard/onboard-summaries.json   numbers copied from the published reports (see its sources)
  od/ctpp/*.csv                       CTPP portal downloads (optional; see CTPP below)
Run: python3 server/beta3/pipeline/od_reference.py
"""
import csv, glob, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
OUT = os.path.join(ROOT, 'server/beta3/reference/od-validation.json')

ob = json.load(open(os.path.join(RAW, 'od/onboard/onboard-summaries.json')))
S = {s['id']: s for s in ob['surveys']}

out = {
    'description': 'Observed transit markets for the model\'s origin-destination checks (server/beta3/pipeline/od-checks.ts): who rides Muni (purpose, home county), how riders reach BART in the city, how many Muni boardings follow a change of vehicle, commute flows by means of transportation. Numbers are copied from the published sources; anything computed here is labeled derived.',
    'generated': __import__('datetime').date.today().isoformat(),
    'sources': [],
}

def src(id_, **kw):
    s = S.get(id_, {})
    out['sources'].append({'id': id_, 'title': s.get('title'), 'operator': s.get('operator'), 'year': s.get('year'), 'url': s.get('url'), 'sampleSize': s.get('sampleSize'), **kw})

# ---- MTC 2023-24 Regional Transit Passenger Snapshot Survey: home county and trip purpose ----
snap = S['mtc-snapshot-2023-24']['items']
out['snapshot'] = {}
for op, v in snap.items():
    if not isinstance(v, dict) or 'home_county' not in v:
        continue
    out['snapshot'][op] = {
        k: {kk: round(vv / 100, 4) for kk, vv in v[k]['pct'].items() if isinstance(vv, (int, float))}
        for k in ('home_county', 'trip_purpose_group') if k in v
    }
    out['snapshot'][op]['n'] = {k: v[k].get('n_unweighted') for k in ('home_county', 'trip_purpose_group') if k in v}
src('mtc-snapshot-2023-24', use='Muni light rail and bus riders: home county (San Francisco share) and trip purpose, weekday')

# ---- BART 2024 station profile: home-origin share of entries and home-origin access by bus/transit ----
CODES = {'Embarcadero': 'EMBR', 'Montgomery St.': 'MONT', 'Powell St.': 'POWL', 'Civic Center / UN Plaza': 'CIVC', '16th St. Mission': '16TH', '24th St. Mission': '24TH', 'Glen Park': 'GLEN', 'Balboa Park': 'BALB'}
bp = S['bart-2024-station-profile']['items']['stations']
out['bartProfile2024'] = {
    CODES[n]: {
        'avgTueThuEntries': v['ridership_xlsx']['avgTueThuEntries'],
        'homeOriginShare': round(v['ridership_xlsx']['homeBasedEntriesPct'] / 100, 3),
        'homeAccessTransit': round(v['homeOrigin_accessModePct']['pct']['Bus / transit'] / 100, 3),
        'homeAccessWalk': round(v['homeOrigin_accessModePct']['pct']['Walk'] / 100, 3),
        'sampleHome': v['sampleSizeUnweighted']['home'],
    }
    for n, v in bp.items() if n in CODES
}
src('bart-2024-station-profile', use='Share of entries at the eight city stations by riders setting out from home, and their access by "bus / transit" (Muni and other operators together), Sept-Nov 2024 Tue-Thu')

# ---- Muni 2017 on-board survey: changes of vehicle before boarding, by Metro line; KT purposes ----
mu = S['muni-2017-obs']['items']
routes = mu['routes_lightRail_and_streetcar']
num = lambda x: 0.0 if x in (None, '<1') else float(str(x).rstrip('%'))
tb = {}
for name, v in routes.items():
    t = v.get('transfersBeforeBoardingPct')
    if not t:
        continue
    key = name.split('-')[0]
    tb[key] = round(1 - num(t.get('None')) / 100, 3)
# systemwide: total changes per one-way trip (Table 8) -> share of boardings preceded by a change,
# taking the intercepted boarding equally likely to be any of a trip's k+1 boardings (derived)
t8 = mu['systemwide_weekday']['totalTransfersPerOneWayTripPct_table8']
tb['system'] = round(sum(num(t8[k]) / 100 * kk / (kk + 1) for k, kk in (('1', 1), ('2', 2), ('3+', 3))), 3)
out['muni2017TransfersBefore'] = tb
out['muni2017TransfersBeforeNote'] = 'Share of a line\'s boardings preceded by another bus or train (route charts: "how many buses/trains did you travel on before you boarded this one"); KT = the 2017 K-Ingleside/T-Third through line. "system" is derived from Table 8 (changes per one-way trip: 0 75%, 1 22%, 2 2%). MTC/RSG note local-bus surveys under-report changes to and from rail.'
out['muni2017KT'] = {k: routes['KT-Ingleside/Third Street'][k] for k in ('originPct', 'destinationPct', 'accessModePct_table')}
out['muni2017System'] = {k: mu['systemwide_weekday'][k] for k in ('accessModePct_table1', 'egressModePct_table5', 'totalTransfersPerOneWayTripPct_table8', 'originPurposePct_table15')}
src('muni-2017-obs', use='Changes of vehicle before boarding by Muni Metro line; KT origin and destination purposes; access and egress modes')
dec = S.get('mtc-tps-route-decomposition', {}).get('items', {}).get('Muni 2017')
if dec:
    out['muni2017OtherOperators'] = {k: v['beforePlusAfter_pctOfInterceptTrips'] for k, v in dec['otherLegsByOperator_tripWeight'].items() if k in ('BART', 'Caltrain', 'AC Transit', 'SAMTRANS', 'GOLDEN GATE TRANSIT', 'SF BAY FERRY')}
    src('mtc-tps-route-decomposition', use='Derived: share of Muni-intercepted linked trips with a BART or Caltrain leg before or after (before MTC\'s re-weighting)')

# ---- Caltrain ----
ct = S['caltrain-triennial-2025']['items']['accessEgressByYearPct_p28']
out['caltrain2025'] = {'accessMuni': ct['access']['Muni'][0] / 100, 'egressMuni': ct['egress']['Muni'][0] / 100, 'note': 'all Caltrain riders, all stations (no station-level access by mode is published)'}
src('caltrain-triennial-2025', use='Share of Caltrain riders reaching or leaving the train by Muni')

# ---- CTPP 2017-2021 (optional): flows by means of transportation ----
# Portal downloads (ctppdata.transportation.org, no account): each CSV has residence, workplace and
# estimate columns for the 18 means; only queries under 10,000 cells download directly.
wp = sorted(glob.glob(os.path.join(RAW, 'od/ctpp/B202105_*.csv')))
if wp:
    rows = list(csv.reader(open(wp[-1], encoding='utf-8-sig')))
    n = lambda x: float(x.replace(',', '')) if x and not x.startswith('+') else 0.0
    tracts = []
    for r in rows[2:]:
        e = {k: n(r[2 + 2 * (k - 1)]) for k in range(1, 19)}
        m = lambda k: n(r[3 + 2 * (k - 1)].replace('+/-', ''))
        if e[1] <= 0:
            continue
        tracts.append({
            'tract': r[0][-6:], 'workers': e[1], 'wfh': e[18],
            'drive': sum(e[k] for k in range(2, 8)), 'transit': sum(e[k] for k in range(8, 13)),
            'bus': e[8], 'subway': e[9], 'rail': e[10], 'lightRail': e[11], 'ferry': e[12],
            'bike': e[13], 'walk': e[14], 'other': e[15] + e[16] + e[17],
            'transitMoe': round(sum(m(k) ** 2 for k in range(8, 13)) ** 0.5),
        })
    out['ctppWorkplace'] = {
        'source': 'CTPP 2017-2021 (5-year ACS), Part 2 (workplace) Table B202105, Means of Transportation to Work (18), workers 16 and over, every census tract of San Francisco County (summary level C31). AASHTO CTPP Data Portal query, downloaded without an account (under the 10,000-cell instant-download limit).',
        'url': 'https://ctppdata.transportation.org/',
        'file': 'data/beta3/raw/od/ctpp/' + os.path.basename(wp[-1]),
        'accessed': '2026-10-05',
        'note': 'transit = bus + subway or elevated rail + long-distance train or commuter rail + light rail, streetcar or trolley + ferryboat; drive = drove alone + all carpools; margins of error at 90% (transitMoe: root sum of squares, approximate)',
        'tracts': tracts,
    }
    out['sources'].append({'id': 'ctpp-2017-2021-B202105', 'title': 'CTPP 2017-2021 Part 2, Table B202105 Means of Transportation to Work (18), San Francisco County tracts', 'operator': 'AASHTO / U.S. Census Bureau', 'year': '2017-2021', 'url': 'https://ctppdata.transportation.org/', 'use': 'Commuters to jobs in each tract of the city and their means of transportation'})


# ---- in-commuters by home PUMA (ACS 2020-2024 PUMS; tabulated by od/pums/puma_to_sf.py) ----
# workers whose workplace is San Francisco, by residence PUMA in the other Bay Area counties, by mode,
# with standard errors from the 80 replicate weights; and tract centroids by PUMA (LODES crosswalk
# block points, 2020 tracts) to place the model's outside zones in PUMAs
pf = os.path.join(RAW, 'od/pums/puma_to_sf.json')
if os.path.exists(pf):
    import gzip, math
    rows = json.load(open(pf))['rows']
    BAY = ('001', '013', '041', '055', '081', '085', '095', '097')
    tp = {}
    for r in csv.DictReader(open(os.path.join(RAW, 'commute-county/2020_Census_Tract_to_2020_PUMA.txt'), encoding='utf-8-sig')):
        if r['STATEFP'] == '06' and r['COUNTYFP'] in BAY:
            tp[r['COUNTYFP'] + r['TRACTCE']] = r['PUMA5CE']
    TRANSIT = ('bus', 'subway', 'commuterRail', 'lightRail', 'ferry')
    by = {}
    for r in rows:
        puma, work, m, w = r[0], r[1], r[2], r[3:]
        if work != 'SF' or puma not in set(tp.values()):
            continue
        e = by.setdefault(puma, {'all': [0.0] * 81, 'wfh': [0.0] * 81, 'transit': [0.0] * 81, 'subway': [0.0] * 81})
        for k in range(81):
            e['all'][k] += w[k]
            if m == 'wfh': e['wfh'][k] += w[k]
            if m in TRANSIT: e['transit'][k] += w[k]
            if m == 'subway': e['subway'][k] += w[k]
    se = lambda v: math.sqrt(4 / 80 * sum((v[k + 1] - v[0]) ** 2 for k in range(80)))
    pumas = []
    for puma, e in sorted(by.items()):
        comm = [e['all'][k] - e['wfh'][k] for k in range(81)]
        share = [e['transit'][k] / comm[k] if comm[k] else 0 for k in range(81)]
        pumas.append({'puma': puma, 'commuters': round(comm[0]), 'commutersSE': round(se(comm)), 'transitShare': round(share[0], 3), 'transitShareSE': round(se(share), 3), 'bartShare': round(e['subway'][0] / comm[0], 3) if comm[0] else 0})
    # tract centroids (mean of block internal points) by PUMA
    acc = {}
    with gzip.open(os.path.join(RAW, 'lodes/ca_xwalk.csv.gz'), 'rt') as f:
        for r in csv.DictReader(f):
            t = r['trct'][2:]
            if t in tp:
                a = acc.setdefault(t, [0.0, 0.0, 0])
                a[0] += float(r['blklatdd']); a[1] += float(r['blklondd']); a[2] += 1
    out['inCommutersByPuma'] = {
        'source': 'ACS 2020-2024 5-year PUMS, California person file: workers with workplace San Francisco County (POWSP 006, POWPUMA 07500) by residence PUMA (2020 PUMAs) and means of transportation; commuters = workers less those working from home; standard errors from the 80 replicate weights (successive differences). Tabulated by data/beta3/raw/od/pums/puma_to_sf.py.',
        'url': 'https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/csv_pca.zip',
        'pumas': [p for p in pumas if p['commuters'] >= 1000],
        'tractCentroidsNote': 'mean of the LODES 2023 crosswalk block points (blklatdd, blklondd) of each 2020 tract, with its 2020 PUMA (2020_Census_Tract_to_2020_PUMA.txt)',
        'tractCentroids': [[round(a[0] / a[2], 5), round(a[1] / a[2], 5), tp[t]] for t, a in sorted(acc.items())],
    }

json.dump(out, open(OUT, 'w'), indent=1, ensure_ascii=False)
print('wrote', OUT, list(out.keys()))
