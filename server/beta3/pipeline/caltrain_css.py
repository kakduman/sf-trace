"""
When Caltrain riders board, by station and direction: the 2025 Caltrain Customer Satisfaction Survey's
public respondent file (May 2025, weekdays; boarding station, direction, and train number), with each
train's time at the boarding station from Caltrain's GTFS (the same train numbers; the January 2026
timetable, so times are approximate). Counts of weekday respondents by boarding station, direction,
and the model's period (AM 6-10am, MD 10am-3pm, PM 3-7pm, NT otherwise).

Input: data/beta3/raw/caltrain/caltrain_css_2025_raw.xlsx (https://www.caltrain.com/media/36020),
       data/beta3/raw/gtfs/caltrain.zip
Output: server/beta3/reference/caltrain-boarding-times.json
Run: python3 server/beta3/pipeline/caltrain_css.py
"""
import csv, io, json, os, re, zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
OUT = os.path.join(ROOT, 'server/beta3/reference/caltrain-boarding-times.json')
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def sheet_rows(path, sheet):
    z = zipfile.ZipFile(path)
    ss = [''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
    root = ET.fromstring(z.read(f'xl/worksheets/{sheet}.xml'))
    for row in root.iter('{%s}row' % NS['m']):
        out = {}
        for c in row.findall('m:c', NS):
            col = re.match(r'[A-Z]+', c.get('r')).group(0)
            v = c.find('m:v', NS)
            if v is None:
                is_ = c.find('m:is', NS)
                out[col] = ''.join(t.text or '' for t in is_.iter('{%s}t' % NS['m'])) if is_ is not None else None
                continue
            out[col] = ss[int(v.text)] if c.get('t') == 's' else v.text
        yield out


def period(minutes):
    h = (minutes // 60) % 24
    return 'AM' if 6 <= h < 10 else 'MD' if 10 <= h < 15 else 'PM' if 15 <= h < 19 else 'NT'


# GTFS: each weekday train's time at each station (parent station name)
g = zipfile.ZipFile(os.path.join(RAW, 'gtfs/caltrain.zip'))
rd = lambda n: csv.DictReader(io.TextIOWrapper(g.open(n), 'utf-8-sig'))
stops = {r['stop_id']: r for r in rd('stops.txt')}
def station(sid):
    s = stops[sid]
    p = s.get('parent_station') or sid
    return re.sub(r' (Caltrain )?Station$', '', stops.get(p, s)['stop_name'])
cal = {r['service_id']: r for r in rd('calendar.txt')}
trips = {r['trip_id']: r for r in rd('trips.txt') if cal.get(r['service_id'], {}).get('wednesday') == '1'}
at = defaultdict(dict)  # train number -> station -> minutes
for r in rd('stop_times.txt'):
    t = trips.get(r['trip_id'])
    if not t:
        continue
    hh, mm, _ = (int(x) for x in r['departure_time'].split(':'))
    at[t['trip_short_name']][station(r['stop_id'])] = hh * 60 + mm

rows = list(sheet_rows(os.path.join(RAW, 'caltrain/caltrain_css_2025_raw.xlsx'), 'sheet1'))
hdr_i = next(i for i, r in enumerate(rows) if r.get('A') == 'sys_RespNum')
hdr = rows[hdr_i]
col = {v: k for k, v in hdr.items()}
counts = defaultdict(lambda: defaultdict(int))
unmatched = 0
# survey station names -> GTFS names; output keys use regional-od.json's names
GTFS_NAME = {'San Francisco (4th & King)': 'San Francisco', 'California Ave': 'California Avenue'}
REF_NAME = {'San Francisco (4th & King)': 'San Francisco', 'California Avenue': 'California Ave'}
for r in rows[hdr_i + 1:]:
    if r.get(col['PERIOD']) not in ('1', '2'):
        continue  # weekdays only (1 peak, 2 off-peak)
    train, d, board = r.get(col['Train']), r.get(col['DIR']), (r.get(col['BOARD']) or '').strip()
    if not train or not board or board == 'Blank' or d not in ('N', 'S'):
        continue
    name = REF_NAME.get(board, board)
    tt = at.get(str(int(float(train))))
    if not tt:
        unmatched += 1
        continue
    m = tt.get(GTFS_NAME.get(board, board))
    if m is None:
        m = min(tt.values())  # not a stop of that train now: its first departure
        unmatched += 1
    counts[f'{name}|{"NB" if d == "N" else "SB"}'][period(m)] += 1

out = {
    'source': '2025 Caltrain Customer Satisfaction Survey, respondent file (weekdays, May 6-29, 2025): boarding station, direction and train; train times at each station from the Caltrain GTFS weekday timetable (January 2026)',
    'url': 'https://www.caltrain.com/media/36020',
    'rawFile': 'data/beta3/raw/caltrain/caltrain_css_2025_raw.xlsx',
    'note': 'Unweighted respondent counts; the survey sampled trains in proportion to peak and off-peak ridership. Times are the timetable time of each train at the boarding station; trains whose number no longer stops there get their first departure.',
    'periods': {'AM': '06:00-09:59', 'MD': '10:00-14:59', 'PM': '15:00-18:59', 'NT': '19:00-05:59'},
    'respondentsTimedApproximately': unmatched,
    'counts': {k: dict(v) for k, v in sorted(counts.items())},
}
json.dump(out, open(OUT, 'w'), indent=1)
tot = defaultdict(int)
for k, v in counts.items():
    for p, n in v.items():
        tot[(k.split('|')[1], p)] += n
print(sum(sum(v.values()) for v in counts.values()), 'weekday respondents;', dict(tot), 'approx timed', unmatched)
