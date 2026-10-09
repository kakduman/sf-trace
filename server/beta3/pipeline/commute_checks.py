"""
Evidence on how many commute trips San Francisco has on a weekday and how many of its transit riders
are commuting, from surveys and tables the model is not fitted to (October 2026):
  - BATS 2023: who Table 45's commute frequency covers (its weighted total against the workers of
    Table 20) and the diaries' trips to work by San Francisco adults, 2019 and 2023 (MTC's dashboard
    extract of weekday trip shares by destination purpose);
  - the SFMTA Travel Decision Survey, 2019 and 2021 (DataSF respondent files): the share of residents'
    transit trips that are work trips, read as MTC's Snapshot reads them (to work, or home from it);
  - the 2017 Muni on-board survey (expanded): the shares of boardings coming from and going to work.
  - jobs downtown: LODES 2023 (all jobs, by block) against the model's jobs after the corrections for
    head-office filings (zones.ts), in the districts od-checks.ts compares with the CTPP.
Input: BETA3_RAW (default data/beta3/raw): mode-by-area/mtc_bats_dashboard_tripshare.csv,
mode-by-area/tds_qmdj-wtj2.csv (2019), mode-by-area/tds_b7eg-vqw2.csv (2021),
lodes/ca_wac_S000_JT00_2023.csv.gz; BETA3_WORK (default work): zones.json.
Output: server/beta3/reference/commute-checks.json
Run: python3 server/beta3/pipeline/commute_checks.py
"""
import csv, gzip, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
OUT = os.path.join(ROOT, 'server/beta3/reference/commute-checks.json')
WORK = os.environ.get('BETA3_WORK', os.path.join(ROOT, 'work'))


def num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


# ---- BATS 2023 diaries: San Francisco adults' weekday trips by destination purpose ----
diary = {}
with open(os.path.join(RAW, 'mode-by-area/mtc_bats_dashboard_tripshare.csv'), encoding='utf-8') as f:
    for r in csv.DictReader(f):
        if r['summary_col'] != 'dpurp_label' or r['summary_level'] != 'survey_cycle,home_county_label_grouped,adult_yn':
            continue
        if r['home_county_label_grouped'] != 'San Francisco' or r['adult_yn'] != '18 and over':
            continue
        y = r['survey_cycle'][:4]
        d = diary.setdefault(y, {'trips': round(float(r['total_weighted'])), 'byDestination': {}})
        d['byDestination'][r['dpurp_label']] = round(float(r['weighted_count']))

# ---- SFMTA Travel Decision Survey: residents' trips, work as the Snapshot reads it ----
def trips(rec, year):
    out = []
    for day in ('4', '5'):
        prev = None
        for L in 'abcdefgh' + ('ij' if year == 2021 else ''):
            p = num(rec.get(f'Q{day}{L}P'))
            if p is None:
                continue
            if year == 2021:
                ms = [m for m in (num(rec.get(f'Q{day}{L}M_{k}')) for k in (1, 2, 3)) if m]
            else:
                m = num(rec.get(f'Q{day}{L}M'))
                ms = [m] if m else []
            out.append({'purp': p, 'modes': ms, 'prev': prev})
            prev = p
    return out


tds = {}
for f, year in (('tds_qmdj-wtj2.csv', 2019), ('tds_b7eg-vqw2.csv', 2021)):
    W = Ww = T = Tw = 0.0
    n = nT = 0
    with open(os.path.join(RAW, 'mode-by-area', f), encoding='utf-8-sig') as fh:
        for r in csv.DictReader(fh):
            if num(r.get('Q2')) != 9:  # San Francisco residents
                continue
            w = float(r.get('WEIGHT') or 0)
            for t in trips(r, year):
                if not t['modes']:
                    continue
                transit = 6 in t['modes']  # public transit on any leg
                work = t['purp'] == 1 or (t['purp'] == 5 and t['prev'] == 1)  # to work, or home from work
                W += w; n += 1
                Ww += w * work
                T += w * transit; nT += transit
                Tw += w * (transit and work)
    tds[str(year)] = {
        'trips': n, 'transitTrips': nT,
        'workShareOfTrips': round(Ww / W, 4), 'transitShare': round(T / W, 4),
        'workTransitShare': round(Tw / Ww, 4), 'nonWorkTransitShare': round((T - Tw) / (W - Ww), 4),
        'workShareOfTransitTrips': round(Tw / T, 4),
    }

# ---- jobs downtown: LODES against the model's (od-checks.ts DISTRICTS) ----
DOWNTOWN = {'Financial District/South Beach', 'Chinatown', 'Nob Hill', 'Tenderloin'}
jobs = None
zf = os.path.join(WORK, 'zones.json')
if os.path.exists(zf):
    zones = json.load(open(zf))['internal']
    down = {z['id'] for z in zones if z['nhood'] in DOWNTOWN}
    ids = {z['id'] for z in zones}
    lt = ld = 0
    with gzip.open(os.path.join(RAW, 'lodes/ca_wac_S000_JT00_2023.csv.gz'), 'rt') as fh:
        for r in csv.DictReader(fh):
            g = r['w_geocode'][:12]
            if g not in ids:
                continue
            c = int(r['C000'])
            lt += c
            ld += c * (g in down)
    mt = sum(z['jobs'] for z in zones)
    md = sum(z['jobs'] for z in zones if z['id'] in down)
    jobs = {'lodes': {'total': lt, 'downtown': ld}, 'model': {'total': round(mt), 'downtown': round(md)},
            'note': "Downtown: the Financial District/South Beach, Chinatown, Nob Hill, and the Tenderloin (od-checks.ts). LODES 2023 WAC, all jobs (JT00), blocks in the model's zones; the model's jobs after UCSF's sites and the rebalancing to MTC's 2023 employment (zones.ts)."}

out = {
    'description': "Independent evidence on San Francisco's commute trips and on how many of its transit trips are commutes (commute_checks.py). Not fitted.",
    'generated': '2026-10-08',
    'bats2023': {
        'table45WeightedTotalSF': 365855,
        'table20PersonsSF': 689506,
        'table20EmployedSF': {'fullTime': 0.533, 'partTime': 0.119, 'selfEmployed': 0.025},
        'note': "BATS 2023 Final Report: Table 45 (typical commute frequency by home county, p. 68) has a weighted total of 365,855 San Francisco workers; Table 20 (employment status by county, p. 44) has 689,506 San Francisco persons, 53.3% employed full time, 11.9% part time, and 2.5% self-employed. Table 45 therefore covers about 78% of the county's workers: those who do not work only from home, the ACS's 78.6% not working from home in 2024. Its 65% of weekdays applies to all of them, part-time workers included.",
        'diaryTripsToWork': {y: d['byDestination'].get('WORK') for y, d in diary.items()},
        'diaryAdultTrips': {y: d['trips'] for y, d in diary.items()},
        'diarySource': "MTC BATS 2019-2023 dashboard extract (mtc_bats_dashboard_tripshare.csv): weighted weekday trips of San Francisco adults by destination purpose (Tuesday-Thursday diaries in 2023).",
    },
    'tds': tds,
    'tdsNote': "SFMTA Travel Decision Survey respondent files (DataSF qmdj-wtj2, 2019; b7eg-vqw2, 2021): San Francisco residents' trips yesterday and two days before, respondent weights. A work trip goes to work, or home from work, as MTC's Snapshot codes it; transit if any leg was public transit.",
    'jobs': jobs,
    'muni2017': {
        'boardings': 703947,
        'originWork': 0.24 + 0.02, 'destinationWork': 0.28 + 0.02,
        'note': "SFMTA 2017 on-board survey (ETC Institute for MTC, draft final report), expanded weekday boardings: coming from the usual workplace 24% and work-related 2% (Table 15), going to it 28% and work-related 2% (Table 19). Neither table gives both ends of a trip.",
    },
}
with open(OUT, 'w') as f:
    json.dump(out, f, indent=1)
print(json.dumps(out, indent=1)[:2000])
