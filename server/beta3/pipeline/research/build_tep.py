"""Parse SFMTA TEP 2006-07 stop-level passenger activity CSVs and match stops to the
current Muni GTFS / DataSF Muni Stops. Writes an intermediate JSON to the scratchpad."""
import csv, glob, json, math, os, re, collections

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/data/beta3/raw/muni-stops'
TEP = RAW + '/tep-2006-07'
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..'))
WORKR = os.path.join(ROOT, 'data/beta3/work/research')  # intermediates (gitignored)
SCR = WORKR
G = SCR + '/gtfs_muni/'  # data/beta3/raw/gtfs/muni.zip, unzipped

PERIODS = ['am', 'midday', 'school', 'pm', 'evening', 'owl']


def num(s):
    s = (s or '').strip().replace(',', '')
    if s == '':
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def parse_file(path):
    """Return list of blocks: {title, direction, stops:[(name, on, off, load, periods{...})], total}"""
    rows = list(csv.reader(open(path, encoding='latin-1')))
    blocks = []
    cur = None
    rail_fmt = any(len(r) > 1 and r[0] == '' and r[1] == 'Stop' for r in rows)
    pending_title = None
    pending_dir = None
    for r in rows:
        if not any(c.strip() for c in r):
            continue
        if rail_fmt:
            # leading empty column; header block has title in col1 and direction in col22
            if len(r) > 22 and r[22].strip() in ('Inbound', 'Outbound'):
                pending_title = r[1].strip()
                pending_dir = r[22].strip()
                continue
            if len(r) > 1 and r[1] == 'Stop':
                cur = {'title': pending_title, 'direction': pending_dir, 'stops': [], 'total': None}
                blocks.append(cur)
                continue
            cells = r[1:]
        else:
            if r[0] == 'Stop':
                cur = None
                continue
            if r[0].strip() and all(not c.strip() for c in r[1:]) and cur is None:
                t = r[0].strip()
                if t.startswith('Subject to disclaimer'):
                    continue
                cur = {'title': t, 'direction': None, 'stops': [], 'total': None}
                blocks.append(cur)
                continue
            cells = r
        if cur is None:
            continue
        name = cells[0].strip()
        if (not name or name.startswith('Subject to disclaimer') or name.startswith('Passenger Activity')
                or name.startswith('Passenger Miles') or name.startswith('Average Passenger')
                or name.startswith('Stop selected')):
            continue
        vals = [num(c) for c in cells[1:]]
        if name.startswith('Total Passenger Boardings'):
            cur['total'] = {'on': vals[0], 'off': vals[1]}
            if not rail_fmt:
                cur = None
            continue
        if all(v is None for v in vals):
            continue
        per = {}
        for i, p in enumerate(PERIODS):
            j = 3 + 3 * i
            if j + 1 < len(vals) and (vals[j] is not None or vals[j + 1] is not None):
                per[p] = [vals[j] or 0, vals[j + 1] or 0]
        cur['stops'].append({'name': name, 'on': vals[0] or 0, 'off': vals[1] or 0,
                             'load': vals[2], 'periods': per})
    return blocks


def route_from_file(fn):
    b = os.path.basename(fn)
    m = re.match(r'PassengerActivity_ByTimePeriod_RT_(.+)\.csv', b)
    if m:
        return m.group(1)
    m = re.match(r'Passenger_Activity_ByTimePeriod_(.+)\.csv', b)
    r = m.group(1)
    r = re.sub(r'^0+(?=\d)', '', r)  # 009BX -> 9BX
    return {'60': 'PH', '61': 'C'}.get(r, r)


# ---------- current stop inventory ----------
ds = {r['stopid']: r for r in csv.DictReader(open(RAW + '/datasf-muni-stops-i28k-bkz6.csv'))}
gst = {r['stop_id']: r for r in csv.DictReader(open(G + 'stops.txt'))}


def norm(s):
    s = s.upper().replace('@', '&').replace('&', ' & ')
    s = re.sub(r'\bBAY SHORE\b', 'BAYSHORE', s)
    s = re.sub(r'\bTHIRD STREET\b', '3RD ST', s)
    s = re.sub(r'\bCUT-?OUT\b', '', s)
    s = re.sub(r'[^A-Z0-9& ]', ' ', s)
    s = re.sub(r'\bSTREET\b', 'ST', s)
    s = re.sub(r'\bAVENUE\b', 'AVE', s)
    s = re.sub(r'\bBOULEVARD\b', 'BLVD', s)
    s = re.sub(r'\bTHE\b', '', s)
    return ' '.join(s.split())


def split_trapeze(name):
    """'Judah St&19th Ave SW-NS/SI' -> ('JUDAH ST & 19TH AVE', 'SW', 'NS', 'SI')"""
    name = re.sub(r'\s+Cut-?out\s*$', '', name.strip(), flags=re.I)
    name = re.sub(r'-([NSEW]{1,2})\s*$', r' \1', name)
    m = re.match(r'^(.*?)\s+([NSEW]{1,2})[-/ ]([A-Z]{2})(?:[/ -]([A-Z]{2}))?\s*$', name.strip())
    if m:
        return norm(m.group(1)), m.group(2), m.group(3), m.group(4)
    m = re.match(r'^(.*?)\s+([NSEW]{1,2})\s*$', name.strip())
    if m:
        return norm(m.group(1)), m.group(2), None, None
    return norm(name), None, None, None


def pair_key(base):
    parts = [p.strip() for p in base.split('&')]
    return tuple(sorted(parts)) if len(parts) == 2 else (base,)


by_full = collections.defaultdict(list)
by_base_or = collections.defaultdict(list)
by_pair = collections.defaultdict(list)
for sid, r in ds.items():
    if sid not in gst:
        continue
    base, ori, pos, typ = split_trapeze(r['stopname'])
    by_full[norm(r['stopname'])].append(sid)
    by_base_or[(base, ori)].append(sid)
    by_pair[pair_key(base)].append(sid)
for sid, r in gst.items():
    by_pair[pair_key(norm(r['stop_name']))].append(sid)
for k in by_pair:
    by_pair[k] = sorted(set(by_pair[k]))

# GTFS route/direction stop sets (weekday M11)
trips = {}
for t in csv.DictReader(open(G + 'trips.txt')):
    if t['service_id'] == 'M11':
        trips[t['trip_id']] = (t['route_id'], t['direction_id'], t['trip_headsign'])
route_stops = collections.defaultdict(set)
rd_stops = collections.defaultdict(collections.Counter)
for r in csv.DictReader(open(G + 'stop_times.txt')):
    tr = trips.get(r['trip_id'])
    if tr:
        route_stops[tr[0]].add(r['stop_id'])
        rd_stops[(tr[0], tr[1])][r['stop_id']] += 1
routes = {r['route_id']: r for r in csv.DictReader(open(G + 'routes.txt'))}
directions = {(r['route_id'], r['direction_id']): r['direction'] for r in csv.DictReader(open(G + 'directions.txt'))}


def dist_m(a, b):
    return math.hypot(float(a['stop_lat']) - float(b['stop_lat']),
                      (float(a['stop_lon']) - float(b['stop_lon'])) * 0.79) * 111000


def match(name, route_id, prev_sid):
    """Return (stop_id, method)."""
    full = norm(name)
    base, ori, pos, typ = split_trapeze(name)
    on_route = route_stops.get(route_id, set())

    def pick(cands, method):
        cands = [c for c in cands if c in gst]
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0], method
        rc = [c for c in cands if c in on_route]
        if len(rc) == 1:
            return rc[0], method + '+route'
        pool = rc or cands
        if prev_sid and prev_sid in gst:
            pool = sorted(pool, key=lambda c: dist_m(gst[c], gst[prev_sid]))
            return pool[0], method + '+nearest-prev'
        return None

    for cands, method in ((by_full.get(full, []), 'exact-name'),
                          (by_base_or.get((base, ori), []) if ori else [], 'street-pair+orientation')):
        r = pick(cands, method)
        if r:
            return r
    cands = by_pair.get(pair_key(base), [])
    rc = [c for c in cands if c in on_route]
    if rc:
        r = pick(rc, 'street-pair')
        if r:
            return r
    st = re.match(r'^(Embarcadero|Montgomery|Powell|Civic Center|Van Ness|Church St|Church|Castro|Forest Hill|West Portal) Station\s*(\w+)?', name.strip(), re.I)
    if st:
        key = st.group(1).upper().replace('CHURCH ST', 'CHURCH')
        d = (st.group(2) or '').upper()
        sc = [sid for sid, g in gst.items() if key + ' STATION' in g['stop_name'].upper()]
        if d.startswith('IN') or d.startswith('INT'):
            sc2 = [c for c in sc if 'DOWNT' in gst[c]['stop_name'].upper()] or [c for c in sc if 'OUTB' not in gst[c]['stop_name'].upper()]
        elif d.startswith('OUT'):
            sc2 = [c for c in sc if 'OUTB' in gst[c]['stop_name'].upper()] or sc
        else:
            sc2 = sc
        r = pick(sc2, 'station-name')
        if r:
            return r
    if ori and cands:
        same = [c for c in cands if c in ds and split_trapeze(ds[c]['stopname'])[1] == ori]
        r = pick(same, 'street-pair+orientation-any-route')
        if r:
            return r
    return None, None


out = []
files = sorted(glob.glob(TEP + '/*.csv'))
summary = []
for fn in files:
    route = route_from_file(fn)
    rid_guess = route.split('-')[0]
    rid = {'KT': 'K', 'C': 'CA'}.get(rid_guess, rid_guess)
    gtfs_route = rid if rid in routes else None
    for bi, b in enumerate(parse_file(fn)):
        title = b['title'] or ''
        m = re.match(r'^\s*\S+?\s*(?:-\s*.*?)?\s+(?:[Tt]o|TO)\s+(.*?)(?:\s+Weekday)?\s*$', title)
        dest = m.group(1) if m else None
        prev = None
        matched = []
        for s in b['stops']:
            sid, meth = match(s['name'], gtfs_route, prev)
            if sid:
                prev = sid
            matched.append((s, sid, meth))
        # infer current GTFS direction by stop overlap
        gdir = None
        if gtfs_route:
            best = (0, None)
            ids = {sid for _, sid, _ in matched if sid}
            for d in ('0', '1'):
                ov = len(ids & set(rd_stops.get((gtfs_route, d), {})))
                if ov > best[0]:
                    best = (ov, d)
            if best[1] is not None and ids and best[0] >= 0.5 * len(ids):
                gdir = best[1]
        for seq, (s, sid, meth) in enumerate(matched):
            g = gst.get(sid) if sid else None
            row = {
                'route': route,
                'gtfsRouteId': gtfs_route,
                'direction': b['direction'] or (('to ' + dest) if dest else None),
                'gtfsDirectionId': int(gdir) if gdir is not None else None,
                'gtfsDirection': directions.get((gtfs_route, gdir)) if gdir is not None else None,
                'pattern': title or None,
                'seq': seq + 1,
                'stopName': s['name'],
                'stopId': sid,
                'stopCode': g['stop_code'] if g else None,
                'currentStopName': g['stop_name'] if g else None,
                'lat': float(g['stop_lat']) if g else None,
                'lon': float(g['stop_lon']) if g else None,
                'matchMethod': meth,
                'boardings': s['on'],
                'alightings': s['off'],
                'load': s['load'],
                'byPeriod': s['periods'],
            }
            out.append(row)
        summary.append((route, title, b['direction'], len(b['stops']),
                        sum(1 for _, sid, _ in matched if sid), b['total'],
                        sum(s['on'] for s in b['stops']), gtfs_route, gdir))

json.dump({'rows': out, 'summary': summary}, open(SCR + '/tep_parsed.json', 'w'))
for s in summary:
    print(s)
print('rows', len(out), 'matched', sum(1 for r in out if r['stopId']))
