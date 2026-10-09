"""
How peaked each period is: each hour's share of the period's transit riders against the same hour's
share of Muni's scheduled trips (Muni GTFS, a weekday, by first departure). The rider-weighted ratio,
the sum over hours of (rider share)² / (service share), is the load each rider meets in their hour
relative to the period average; it scales period loads for crowding in model.ts (LOAD_SPREAD).
Riders by hour: BART's October 2025 weekday entries and exits at the eight San Francisco stations
(server/beta3/reference/time-of-day.json, by tap-in hour), the only large post-pandemic hourly count
of riders in the city. NHTS 2017 transit trips by SF–Oakland residents (public bus, subway and light
rail, by start hour) are kept for comparison: a pre-pandemic sample of about 200 trips a period,
which put the morning's busiest hour at 7am (44% of the period) where BART's 2025 counts put it at
8am (37%).
Input: data/beta3/raw/params/nhts2017/csv.zip, data/beta3/raw/gtfs/muni.zip, reference/time-of-day.json
Output: server/beta3/reference/peak-hour.json
Run: python3 server/beta3/pipeline/peak_hour.py
"""
import csv, io, json, os, zipfile
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
OUT = os.path.join(ROOT, 'server/beta3/reference/peak-hour.json')
PERIODS = {'AM': range(6, 10), 'MD': range(10, 15), 'PM': range(15, 19), 'NT': [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5]}
TRANSIT = {'11', '16'}  # public bus; subway, light rail, streetcar (commuter rail left out)

nh = defaultdict(float); n = defaultdict(int)
z = zipfile.ZipFile(os.path.join(RAW, 'params/nhts2017/csv.zip'))
with z.open('trippub.csv') as f:
    for r in csv.DictReader(io.TextIOWrapper(f, 'utf-8')):
        if r['HH_CBSA'] != '41860' or int(r['TRAVDAY']) in (1, 7) or r['TRPTRANS'] not in TRANSIT: continue
        t = int(r['STRTTIME'])
        if t < 0: continue
        nh[t // 100] += float(r['WTTRDFIN']); n[t // 100] += 1

g = zipfile.ZipFile(os.path.join(RAW, 'gtfs/muni.zip'))
def rows(name): return csv.DictReader(io.TextIOWrapper(g.open(name), 'utf-8-sig'))
names = set(g.namelist())
# the services running on one Wednesday in the feed (calendar, then calendar_dates exceptions)
import datetime
cal = list(rows('calendar.txt')) if 'calendar.txt' in names else []
cd = list(rows('calendar_dates.txt')) if 'calendar_dates.txt' in names else []
dates = sorted({r['date'] for r in cd} | {r['start_date'] for r in cal})
wed = next(d for d in (datetime.date(int(x[:4]), int(x[4:6]), int(x[6:])) + datetime.timedelta(days=k) for x in dates[:1] for k in range(14)) if d.weekday() == 2).strftime('%Y%m%d')
svc = {r['service_id'] for r in cal if r['wednesday'] == '1' and r['start_date'] <= wed <= r['end_date']}
for r in cd:
    if r['date'] != wed: continue
    if r['exception_type'] == '1': svc.add(r['service_id'])
    else: svc.discard(r['service_id'])
print('Wednesday', wed, 'services', sorted(svc))
trips = {r['trip_id'] for r in rows('trips.txt') if not svc or r['service_id'] in svc}
first = {}
for r in rows('stop_times.txt'):
    if r['trip_id'] not in trips: continue
    seq = int(r['stop_sequence'])
    if r['trip_id'] not in first or seq < first[r['trip_id']][0]:
        first[r['trip_id']] = (seq, r['departure_time'] or r['arrival_time'])
gh = defaultdict(int)
for _, t in first.values():
    if t: gh[int(t.split(':')[0]) % 24] += 1

sf8 = json.load(open(os.path.join(ROOT, 'server/beta3/reference/time-of-day.json')))['bartSfStations']['sfEightStations']
bh = {h: sf8['entriesByHour'][h] + sf8['exitsByHour'][h] for h in range(24)}

def factor(riders, hrs):
    R = sum(riders[h] for h in hrs); S = sum(gh[h] for h in hrs)
    # the load a rider meets in their own hour, averaged over riders, relative to the period average
    rw = sum((riders[h] / R) ** 2 / (gh[h] / S) for h in hrs if gh[h] > 0)
    peak = max(hrs, key=lambda h: riders[h])
    return {'factor': rw, 'peakHour': peak, 'riderShare': riders[peak] / R, 'serviceShare': gh[peak] / S, 'peakHourFactor': (riders[peak] / R) / (gh[peak] / S),
            'ridersByHour': {h: riders[h] / R for h in hrs}, 'tripsByHour': {h: gh[h] / S for h in hrs}}

out = {'source': 'BART hourly origin-destination, October 2025 weekdays: entries plus exits at the eight San Francisco stations by tap-in hour (reference/time-of-day.json); Muni GTFS weekday service by hour of first departure. NHTS 2017 (CBSA 41860, weekday, TRPTRANS 11/16) for comparison. server/beta3/pipeline/peak_hour.py', 'periods': {}}
for p, hrs in PERIODS.items():
    d = factor(bh, hrs)
    nn = factor(nh, hrs)
    d['nhts2017'] = {'factor': nn['factor'], 'peakHour': nn['peakHour'], 'riderShare': nn['riderShare'], 'sample': sum(n[h] for h in hrs), 'ridersByHour': nn['ridersByHour']}
    out['periods'][p] = d
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps({p: {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items() if k in ('peakHour', 'riderShare', 'serviceShare', 'factor')} | {'nhts': round(d['nhts2017']['factor'], 3)} for p, d in out['periods'].items()}, indent=1))
