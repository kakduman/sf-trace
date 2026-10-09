"""
Household size by vehicles available, PUMA by PUMA, San Francisco, ACS 2020-24 5-year PUMS (SF PUMAs
07507-07514; households with VEH and HINCP; WGTP and PWGTP weights).

The city's persons per household by vehicles and income (pums_persons_by_vehicles.py) turn each zone's
household shares into shares of its people. Household size differs by area within each vehicle class:
in the southeast (PUMA 07507: Bayview, Excelsior, Visitacion Valley, Portola) households without a car
average 2.41 persons against 1.59 citywide, and households with two or more cars 3.99 against 3.27,
so the city's ratios put too few of the southeast's people in households without a car. This writes,
for each PUMA, persons (and employed persons, children 5-17, and persons 65+) per household by vehicles
relative to the city's in the same 5-year file, and each SF tract's PUMA, into
server/beta3/reference/sf-hh-vehicles-income.json (perHouseholdByPuma), and prints them for params.ts.

Inputs: data/beta3/raw/commute-county/csv_hca_2024_5yr.zip, csv_pca_2024_5yr.zip
(https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/), and
data/beta3/raw/commute-county/2020_Census_Tract_to_2020_PUMA.txt (Census Bureau relationship file).
Run: python3 server/beta3/pipeline/research/pums_persons_by_puma.py
"""
import collections, csv, io, json, os, zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
REF = os.path.join(ROOT, 'server/beta3/reference/sf-hh-vehicles-income.json')
KINDS = ['persons', 'employed', 'age5to17', 'age65plus']

def rows(zipname, member):
    with zipfile.ZipFile(os.path.join(RAW, 'commute-county', zipname)).open(member) as f:
        yield from csv.DictReader(io.TextIOWrapper(f))

hh = {}
for r in rows('csv_hca_2024_5yr.zip', 'psam_h06.csv'):
    if r['PUMA'].startswith('075') and r['VEH'] != '' and r['HINCP'] != '':
        hh[r['SERIALNO']] = (r['PUMA'], min(2, int(r['VEH'])), float(r['WGTP']))
H = collections.defaultdict(float)
N = collections.defaultdict(int)
for p, v, w in hh.values():
    H[(p, v)] += w
    N[(p, v)] += 1
P = collections.defaultdict(lambda: collections.defaultdict(float))
for r in rows('csv_pca_2024_5yr.zip', 'psam_p06.csv'):
    h = hh.get(r['SERIALNO'])
    if not h:
        continue
    k, w, a = (h[0], h[1]), float(r['PWGTP']), int(r['AGEP'])
    P[k]['persons'] += w
    if r['ESR'] in ('1', '2', '4', '5'):
        P[k]['employed'] += w
    if 5 <= a <= 17:
        P[k]['age5to17'] += w
    if a >= 65:
        P[k]['age65plus'] += w
pumas = sorted({p for p, _ in H})
city = {k: [sum(P[(p, v)][k] for p in pumas) / sum(H[(p, v)] for p in pumas) for v in range(3)] for k in KINDS}
factor = {p: {k: [round((P[(p, v)][k] / H[(p, v)]) / city[k][v], 3) for v in range(3)] for k in KINDS} for p in pumas}
tracts = {}
with open(os.path.join(RAW, 'commute-county', '2020_Census_Tract_to_2020_PUMA.txt'), encoding='utf-8-sig') as f:
    for line in f:
        s = line.strip().split(',')
        if s[0] == '06' and s[1] == '075':
            tracts[s[2]] = s[3]
ref = json.load(open(REF))
ref['perHouseholdByPuma'] = {
    'description': 'Persons, employed persons, children 5-17, and persons 65+ per household by vehicles (0, 1, 2+), each PUMA relative to the city, ACS 2020-24 5-year PUMS; sample households by PUMA and vehicles; and each 2020 tract\'s PUMA. Computed by server/beta3/pipeline/research/pums_persons_by_puma.py.',
    'cityPerHousehold': {k: [round(x, 4) for x in v] for k, v in city.items()},
    'factor': factor,
    'sampleHouseholds': {p: [N[(p, v)] for v in range(3)] for p in pumas},
    'tractPuma': tracts,
}
json.dump(ref, open(REF, 'w'), indent=1, ensure_ascii=False)
print(json.dumps({'city': ref['perHouseholdByPuma']['cityPerHousehold'], 'factor': factor, 'n': ref['perHouseholdByPuma']['sampleHouseholds']}, indent=1))
