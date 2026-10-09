import json, re, unicodedata, os, html
from collections import Counter, defaultdict

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/data/beta3/raw'
SR = f'{RAW}/schools'
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..'))
WORKR = os.path.join(ROOT, 'data/beta3/work/research')  # intermediates (gitignored)
SP = WORKR
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/server/beta3/reference/sf-schools.json'

# ---------- OSM features (pois.json + targeted name query + optional bbox query) ----------
osm = {}
def add_osm(path):
    if not os.path.exists(path): return
    try: d = json.load(open(path))
    except Exception: return
    for e in d.get('elements', []):
        t = e.get('tags', {})
        c = e.get('center') or ({'lat': e['lat'], 'lon': e['lon']} if 'lat' in e else None)
        if not c or 'name' not in t: continue
        osm.setdefault(e['type'][0] + str(e['id']), {'name': t['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'src': os.path.basename(path)})
add_osm(f'{RAW}/pois.json')
add_osm(f'{SR}/osm_extra_names.json')
add_osm(f'{SR}/osm_schools_bbox.json')

# ---------- Public: CDE directory ----------
dirrows = {}
with open(f'{SR}/pubschls.txt', encoding='latin-1') as f:
    hdr = f.readline().rstrip('\r\n').split('\t')
    for line in f:
        r = dict(zip(hdr, line.rstrip('\r\n').split('\t')))
        if r['County'] == 'San Francisco':
            dirrows[r['CDSCode']] = r

# ---------- Public: census-day enrollment 2025-26 ----------
enr = {}
with open(f'{SR}/cdenroll2526.txt', encoding='latin-1') as f:
    hdr = f.readline().rstrip('\r\n').split('\t')
    for line in f:
        v = line.rstrip('\r\n').split('\t')
        r = dict(zip(hdr, v))
        if r['AggregateLevel'] == 'S' and r['CountyCode'] == '38' and r['ReportingCategory'] == 'TA':
            cds = r['CountyCode'] + r['DistrictCode'] + r['SchoolCode']
            enr[cds] = r

def num(x):
    try: return int(x)
    except: return 0

def gband(r):
    g = {k: num(r[k]) for k in ['GR_TK','GR_KN','GR_01','GR_02','GR_03','GR_04','GR_05','GR_06','GR_07','GR_08','GR_09','GR_10','GR_11','GR_12']}
    tk = g['GR_TK']
    k5 = tk + g['GR_KN'] + g['GR_01'] + g['GR_02'] + g['GR_03'] + g['GR_04'] + g['GR_05']
    g68 = g['GR_06'] + g['GR_07'] + g['GR_08']
    g912 = g['GR_09'] + g['GR_10'] + g['GR_11'] + g['GR_12']
    return tk, k5, g68, g912

# ---------- SFUSD bell times ----------
bell_rows = json.load(open(f'{SP}/bell_rows.json'))
def bnorm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = s.replace('&', ' and ')
    s = re.sub(r'\(access\)|\(at moscone\)', ' ', s)
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    drop = {'es','ms','hs','elementary','middle','high','school','k5','k','5','6','8','the','sf','san','francisco','of','academy','alternative','at','and','jr','dr','a','public','k8','sch','arts','for','international'}
    return set(w for w in s.split() if w not in drop and not re.fullmatch(r'\d+', w))
bell_by_key = []
for sec, sid, name, start, end, *rest in bell_rows:
    rest = [x for x in rest]
    if sec.startswith('Early Education'): continue
    if '(Access)' in name or 'SDC' in name: continue
    end = re.sub(r'<!--.*?-->', '', end, flags=re.S).strip()
    bell_by_key.append({'section': sec, 'sfusdId': sid, 'name': name, 'start': start, 'end': end.replace('PM', ' PM').replace('  ', ' ').strip(),
                        'section': sec, 'earlyReleaseDay': (rest[0] if rest else '') or None, 'earlyRelease': (rest[1] if len(rest) > 1 else '') or None, 'key': bnorm(name)})

BELL_OVERRIDE = {  # CDE name fragment -> SFUSD bell-table name(s), where token matching is ambiguous
    'Asawa (Ruth) SF Sch of the Arts': ['Asawa (Ruth) SOTA HS'],
    'Academy (The)- SF @McAteer': ['The Academy - SF @ McAteer HS'],
    'S.F. International High': ['SF International HS'],
    'S.F. County Civic Center Secondary': ['SF Civic Center Secondary MS', 'SF Civic Center Secondary HS'],
    'S.F. County Opportunity (Hilltop)': ['Hilltop HS'],
    'Carver (George Washington)': ['Carver (Dr George W) ES'],
    'Chinese Immersion School at DeAvila': ['CIS at DeAvila ES'],
    'Galileo Academy': ['Galileo HS'],
    'Francisco Middle': ['Francisco MS'],
    'King Jr. (Martin Luther)': ['King Jr (Dr Martin L) MS'],
    'Tenderloin Community': ['Tenderloin ES'],
    'Visitacion Valley Elementary': ['Visitacion Valley ES'],
    'Visitacion Valley Middle': ['Visitacion Valley MS'],
}

def bell_for(cdename):
    for frag, names in BELL_OVERRIDE.items():
        if cdename.startswith(frag):
            return [b for b in bell_by_key if b['name'] in names]
    k = bnorm(cdename)
    if not k: return []
    best, bs = [], 0
    for b in bell_by_key:
        if not b['key']: continue
        inter = len(k & b['key'])
        if inter == 0: continue
        sc = inter / len(k | b['key'])
        if sc > bs + 1e-9: best, bs = [b], sc
        elif abs(sc - bs) < 1e-9: best.append(b)
    if bs >= 0.5:
        return best
    return []

schools = []
dropped_public = []
public_no_dir = []
for cds, r in sorted(enr.items()):
    tk, k5, g68, g912 = gband(r)
    total = num(r['TOTAL_ENR'])
    d = dirrows.get(cds)
    remap = None
    if d is None and r['SchoolCode'] != '0000000':
        alt = [x for x in dirrows.values() if x['CDSCode'][7:] == r['SchoolCode'] and x['StatusType'] == 'Active']
        if len(alt) == 1:
            d = alt[0]; remap = cds; cds = d['CDSCode']
    if d is None or d['StatusType'] != 'Active' or d['School'] == 'No Data':
        (public_no_dir if d is None or d['School'] == 'No Data' else dropped_public).append({'cds': cds, 'name': r['SchoolName'], 'enrollment': total, 'status': d['StatusType'] if d else 'not in directory'})
        continue
    if total == 0: continue
    soc = d['SOCType']; edops = d['EdOpsName']
    rec = {
        'cds': cds, 'name': d['School'], 'district': d['District'],
        'type': 'charter' if r['Charter'] == 'Y' or d['Charter'] == 'Y' else 'public',
        'grades': d['GSserved'] if d['GSserved'] != 'No Data' else d['GSoffered'],
        'enrollment': total, 'tk': tk, 'k5': k5, 'g68': g68, 'g912': g912,
        'lat': float(d['Latitude']) if d['Latitude'] not in ('', 'No Data') else None,
        'lon': float(d['Longitude']) if d['Longitude'] not in ('', 'No Data') else None,
        'street': d['Street'], 'zip': d['Zip'][:5],
        'schoolType': soc, 'edOps': edops,
        'geocode': 'CDE directory',
    }
    if remap:
        rec['note'] = f'Census enrollment is reported under CDS {remap} (former State Board of Education charter district); joined to the active directory record by school code.'
    nontrad = edops not in ('Traditional',) or 'Five Keys' in d['School']
    if nontrad:
        rec['nontraditional'] = True
    if 'Five Keys' in d['School']:
        rec['note'] = "SF Sheriff's Office charter (Five Keys) serving mainly adult learners in custody and community sites; not a conventional school commute."
    if d['District'] == 'San Francisco Unified' and rec['type'] == 'public' or d['District'].startswith('San Francisco County Office'):
        bt = bell_for(d['School'])
        if bt:
            rec['bell'] = [{'program': b['name'], 'table': b['section'], 'start': b['start'], 'end': b['end'], 'earlyReleaseDay': b['earlyReleaseDay'], 'earlyRelease': b['earlyRelease']} for b in bt]
    schools.append(rec)

# ---------- Private: CDE Private School Affidavit ----------
def read_ps(path):
    rows = []
    for l in open(path):
        v = l.rstrip('\n').split('\t')
        if len(v) > 17 and v[1] == 'San Francisco' and re.fullmatch(r'\d{13,14}', v[0]):
            rows.append(v)
    return rows
ps26 = read_ps(f'{SP}/ps2526_0.tsv')
ps25 = read_ps(f'{SP}/ps2425_0.tsv')
have26 = {v[0] for v in ps26}

# Manual, reviewed match: affidavit CDS -> OSM element (pois.json unless noted)
PMAP = {
 '38684786930572': 'w192123449', '38684786140099': 'w229620083', '38684786142079': 'n13233030962',
 '38684786965586': 'n358803226', '38684787096514': 'w138882589', '38684786168041': 'w229619076',
 '38684786158596': 'w838846558', '38684786133763': 'w229620075', '38684786903165': 'w229620371',
 '38684787104466': 'w35536668', '38684786981500': 'w942310706', '38684786908917': 'w402127062',
 '38684786162549': 'w690979551', '38684786174080': 'n5515207393', '38684786939607': 'n5152065722',
 '38684786981278': 'w285960375', '38684786939615': 'w1529171564', '38684786200554': 'w545423056',
 '38684786981328': 'w229621224', '38684786981336': 'w276412233', '38684786913123': 'w229617446',
 '38684786144257': 'w266762279', '38684786906176': 'w229619074', '38684786939649': 'w229619075',
 '38684786981377': 'w617714580', '38684786146369': 'w672441194', '38684786939664': 'w311120377',
 '38684786981716': 'w1411604286', '38684786981559': 'w100230854', '38684786144034': 'w243466311',
 '38684786939748': 'n11017018708', '38684786981682': 'n358804715', '38684786980692': 'n358805338',
 '38684786915748': 'r3828921', '38684786204762': 'w1090739372', '38684786146054': 'w287688530',
 '38684786980726': 'w229620086', '38684786143952': 'n4338805961', '38684786980734': 'w229620369',
 '38684786981658': 'w229621524', '38684786981666': 'n286898816', '38684786981674': 'w528000360',
 '38684786981690': 'w229619299', '38684786981740': 'w783773707', '38684786139893': 'w479425025',
 '38684786980601': 'w32113140', '38684786980627': 'w843798291', '38684786980643': 'w229619078',
 '38684786980650': 'w229617447', '38684786980676': 'w731806938', '38684786162598': 'w274858128',
 '38684786999379': 'n358804896', '38684786980684': 'n358805186', '38684786905913': 'w256451910',
 '38684786138176': 'w288342510', '38684786152565': 'w288965474', '38684786981195': 'r7394142',
 '38684786980833': 'w262074929', '38684786938930': 'w449472827', '38684786980874': 'w229619300',
 '38684786980890': 'n358804984',
 # 2024-25 carry-forwards
 '38684786139463': 'n3801395653', '38684786168728': 'n10897941818', '38684786939698': 'w1410964642',
 '38684786939722': 'r21238054', '38684786939730': 'w159149997', '38684786980718': 'w229619077',
 '38684786981773': 'w256940400', '38684786997829': 'n358803458',
 # found by targeted Overpass name query (osm_extra_names.json)
 '38684786981765': 'w173642167', '38684786980619': 'w257972664', '38684786205652': 'w273177376',
 '38684786130090': 'w274261489', '38684786154439': 'w282917235', '38684786980585': 'w286297922',
}
PNOTE = {
 '38684786908917': 'Matched to OSM "Edgewood Center For Children and Families" (1801 Vicente St), which operates this school.',
 '38684786162598': 'Matched to OSM "Star of the Sea School" (360 9th Ave); Stella Maris Academy is the successor school on that parish campus.',
 '38684786913123': 'KZV Armenian School matched to OSM "Krouzian Armenian School" (825 Brotherhood Way).',
 '38684786981195': 'Formerly French American International School; matched to OSM "International High School" (Oak St campus). Lower grades are on nearby campuses.',
 '38684786158596': 'One affidavit for four Broadway/Octavia buildings; point is the Broadway campus. Part of the 9-12 enrollment (Stuart Hall High School) is at 1715 Octavia St, about 0.9 km away.',
 '38684786139893': 'Matched to OSM "Saint John Catholic School" (925 Chenery St, Glen Park), the parish school of St. John the Evangelist.',
 '38684786154439': 'OSM tags this site (50 Fell St) as a kindergarten.',
}
UNMATCH_NOTE = {
 '38684786135651': 'Stratford has three SF affidavits (two K-5, one 6-8) and OSM shows two Stratford sites (301 De Montfort Ave, 37.72315,-122.46175; and 37.77637,-122.4729). Which affidavit belongs to which site could not be confirmed, so coordinates are left null.',
 '38684786159156': 'See the Stratford note: campus assignment could not be confirmed.',
 '38684786156640': 'See the Stratford note: campus assignment could not be confirmed.',
 '38684786171813': 'A home school; it has no public location.',
}

def prow(v, year):
    g = [num(x) for x in v[4:17]]
    k5, g68, g912 = sum(g[0:6]), sum(g[6:9]), sum(g[9:13])
    total = num(v[17])
    lo = next((i for i, x in enumerate(g) if x > 0), None); hi = max((i for i, x in enumerate(g) if x > 0), default=None)
    lab = lambda i: 'K' if i == 0 else str(i)
    rec = {'cds': v[0], 'name': v[3].strip(), 'type': 'private', 'grades': f'{lab(lo)}-{lab(hi)}' if lo is not None else None,
           'enrollment': total, 'k5': k5, 'g68': g68, 'g912': g912, 'lat': None, 'lon': None, 'year': year}
    if year != '2025-26':
        rec['note'] = 'No 2025-26 affidavit on file (file revised 9/25/2026); enrollment is from the 2024-25 affidavit.'
    oid = PMAP.get(v[0])
    if oid and oid in osm:
        o = osm[oid]
        rec['lat'], rec['lon'] = o['lat'], o['lon']
        rec['geocode'] = f'OSM {oid} "{o["name"]}" ({o["src"]})'
    else:
        rec['geocode'] = 'unmatched'
    n = PNOTE.get(v[0]) or UNMATCH_NOTE.get(v[0])
    if n: rec['note'] = (rec.get('note', '') + ' ' + n).strip()
    if v[0].startswith('3810389'):
        rec['note'] = (rec.get('note', '') + ' Listed under the SF County Office of Education district code; may be an online or independent-study program.').strip()
    return rec

for v in ps26:
    r = prow(v, '2025-26')
    if v[0] == '38684786907927':  # SF Waldorf: one K-12 affidavit, two campuses with grade spans tagged in OSM
        g = [num(x) for x in v[4:17]]
        a = dict(r); b = dict(r)
        a.update({'name': r['name'] + ' (grade school, K-8)', 'grades': 'K-8', 'enrollment': sum(g[0:9]), 'g912': 0})
        o = osm['w262464467']; a.update({'lat': o['lat'], 'lon': o['lon'], 'geocode': 'OSM w262464467 "San Francisco Waldorf School" (pois.json)'})
        b.update({'name': r['name'] + ' (high school, 9-12)', 'grades': '9-12', 'enrollment': sum(g[9:13]), 'k5': 0, 'g68': 0})
        o = osm['w1187777978']; b.update({'lat': o['lat'], 'lon': o['lon'], 'geocode': 'OSM w1187777978 "San Francisco Waldorf High School" (pois.json)'})
        a['note'] = b['note'] = 'One K-12 affidavit, split into the K-8 and 9-12 campuses by grade.'
        schools += [a, b]
        continue
    schools.append(r)
carry = [v for v in ps25 if v[0] not in have26]
for v in carry:
    schools.append(prow(v, '2024-25'))

# ---------- totals ----------
def tot(filt):
    s = [x for x in schools if filt(x)]
    return {'schools': len(s), 'students': sum(x['enrollment'] for x in s), 'k5': sum(x['k5'] for x in s), 'g68': sum(x['g68'] for x in s), 'g912': sum(x['g912'] for x in s)}
pub = tot(lambda x: x['type'] == 'public')
cha = tot(lambda x: x['type'] == 'charter')
pri26 = tot(lambda x: x['type'] == 'private' and x['year'] == '2025-26')
pri = tot(lambda x: x['type'] == 'private')
trad = tot(lambda x: x['type'] != 'private' and not x.get('nontraditional'))
geo_missing = [x for x in schools if x['lat'] is None]
totals = {
    'public': pub, 'charter': cha,
    'publicAndCharter': tot(lambda x: x['type'] != 'private'),
    'publicAndCharterTraditionalOnly': trad,
    'publicTK': sum(x.get('tk', 0) for x in schools if x['type'] != 'private'),
    'private': pri, 'private2025_26AffidavitsOnly': pri26,
    'all': tot(lambda x: True),
    'byBand': {b: sum(x[b] for x in schools) for b in ('k5', 'g68', 'g912')},
    'byBandExcludingNontraditional': {b: sum(x[b] for x in schools if not x.get('nontraditional')) for b in ('k5', 'g68', 'g912')},
    'geocoded': {'withCoords': len(schools) - len(geo_missing), 'withoutCoords': len(geo_missing),
                 'studentsWithoutCoords': sum(x['enrollment'] for x in geo_missing)},
}

json.dump({'schools': schools, 'totals': totals, 'dropped_public': dropped_public, 'public_no_dir': public_no_dir},
          open(f'{SP}/schools_core.json', 'w'), indent=1)
print(json.dumps(totals, indent=1))
print('dropped (not active):', dropped_public)
print('no dir:', public_no_dir)
print('unmatched private:', [(x['name'], x['enrollment']) for x in geo_missing])
pubs = [x for x in schools if x['type'] == 'public' and x['district'] == 'San Francisco Unified']
print('SFUSD public w/o bell:', [x['name'] for x in pubs if 'bell' not in x])
