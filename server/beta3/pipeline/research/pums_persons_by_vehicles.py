"""
Persons, employed persons, children 5-17, persons 65 and over, and persons with a disability per
household, by vehicles available (0, 1, 2+) and household income band (<$50k, $50-100k, $100-200k,
$200k+, 2024 dollars), San Francisco, ACS 2024 1-year PUMS (SF PUMAs 07507-07514; households with
VEH and HINCP, so group quarters and vacant units are out; housing weights WGTP, person weights PWGTP).

Households without a car are smaller than others: they are 32.6% of the city's households but 24.0% of
its residents, and 24.6% of its workers (ACS B08141). The model splits each zone's residents by car
ownership; with households' shares it put a third too many people in households without a car and a
third too few in those with two or more. These rates turn each zone's household shares into shares of
its residents, workers, children, and seniors (demand.ts prepare).

Adds `perHousehold` to server/beta3/reference/sf-hh-vehicles-income.json.
Inputs: data/beta3/raw/income/csv_hca_2024.zip, csv_pca_2024.zip
(https://www2.census.gov/programs-surveys/acs/data/pums/2024/1-Year/)
Run: python3 server/beta3/pipeline/research/pums_persons_by_vehicles.py
"""
import collections, csv, io, json, os, zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
REF = os.path.join(ROOT, 'server/beta3/reference/sf-hh-vehicles-income.json')
SF = {'07507', '07508', '07509', '07510', '07511', '07512', '07513', '07514'}

def rows(zipname, member):
    with zipfile.ZipFile(os.path.join(RAW, 'income', zipname)).open(member) as f:
        yield from csv.DictReader(io.TextIOWrapper(f))

hh = {}
for r in rows('csv_hca_2024.zip', 'psam_h06.csv'):
    if r['PUMA'] in SF and r['VEH'] != '' and r['HINCP'] != '':
        inc = float(r['HINCP']) * float(r['ADJINC']) / 1e6
        band = 0 if inc < 50000 else 1 if inc < 100000 else 2 if inc < 200000 else 3
        hh[r['SERIALNO']] = (min(2, int(r['VEH'])), band, float(r['WGTP']))
H = collections.defaultdict(float)
for v, b, w in hh.values(): H[(v, b)] += w
P = collections.defaultdict(lambda: collections.defaultdict(float))
for r in rows('csv_pca_2024.zip', 'psam_p06.csv'):
    h = hh.get(r['SERIALNO'])
    if not h: continue
    k, w, a = (h[0], h[1]), float(r['PWGTP']), int(r['AGEP'])
    P[k]['persons'] += w
    if r['ESR'] in ('1', '2', '4', '5'): P[k]['employed'] += w
    if 5 <= a <= 17: P[k]['age5to17'] += w
    if a >= 65: P[k]['age65plus'] += w
    if r['DIS'] == '1': P[k]['disability'] += w
KINDS = ['persons', 'employed', 'age5to17', 'age65plus', 'disability']
ref = json.load(open(REF))
ref['perHousehold'] = {
    'description': 'Weighted persons per household by vehicles (rows 0, 1, 2+) and income band (columns): all persons, employed (ESR 1, 2, 4, 5), ages 5-17, ages 65+, with a disability (DIS 1). Computed by server/beta3/pipeline/research/pums_persons_by_vehicles.py from the same PUMS files.',
    **{k: [[round(P[(v, b)][k] / H[(v, b)], 4) for b in range(4)] for v in range(3)] for k in KINDS},
}
tot = {k: sum(P[x][k] for x in P) for k in KINDS}
ref['perHousehold']['shareByVehicles'] = {k: [round(sum(P[(v, b)][k] for b in range(4)) / tot[k], 4) for v in range(3)] for k in KINDS}
ref['perHousehold']['shareByVehicles']['households'] = [round(sum(H[(v, b)] for b in range(4)) / sum(H.values()), 4) for v in range(3)]
json.dump(ref, open(REF, 'w'), indent=1, ensure_ascii=False)
print(json.dumps(ref['perHousehold'], indent=1))
