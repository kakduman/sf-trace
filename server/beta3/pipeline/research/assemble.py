"""Assemble server/beta3/reference/muni-stop-ridership.json from the parsed TEP rows,
the GTFS school-day trips, the SFMTA school-routes page, SFUSD bell times and youth figures."""
import csv, collections, json, os, re
from html.parser import HTMLParser

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..'))
WORKR = os.path.join(ROOT, 'data/beta3/work/research')  # intermediates (gitignored)
SCR = WORKR
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/data/beta3/raw/muni-stops'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/server/beta3/reference/muni-stop-ridership.json'
G = SCR + '/gtfs_muni/'  # data/beta3/raw/gtfs/muni.zip, unzipped

tep = json.load(open(SCR + '/tep_parsed.json'))
rows_in = tep['rows']

# ---- patterns table ----
pat_index = {}
patterns = []
for s in tep['summary']:
    route, title, direction, n, nm, total, rowsum, groute, gdir = s
    key = (route, title, direction)
    pat_index[key] = len(patterns)
    patterns.append({'id': len(patterns), 'route': route, 'gtfsRouteId': groute,
                     'title': title, 'direction': direction,
                     'gtfsDirectionId': int(gdir) if gdir is not None else None,
                     'stops': n, 'stopsMatched': nm,
                     'sourceTotalBoardings': total['on'] if total else None,
                     'sourceTotalAlightings': total['off'] if total else None})

rows = []
for r in rows_in:
    key = (r['route'], r['pattern'], r['direction'] if r['direction'] in ('Inbound', 'Outbound') else None)
    pid = pat_index.get(key)
    if pid is None:
        # bus-format blocks carry direction=None in the summary
        pid = pat_index[(r['route'], r['pattern'], None)]
    p = patterns[pid]
    rows.append({
        'route': r['route'],
        'gtfsRouteId': r['gtfsRouteId'],
        'direction': r['direction'],
        'gtfsDirectionId': r['gtfsDirectionId'],
        'patternId': pid,
        'seq': r['seq'],
        'stopName': r['stopName'],
        'stopId': r['stopId'],
        'stopCode': r['stopCode'],
        'lat': round(r['lat'], 6) if r['lat'] is not None else None,
        'lon': round(r['lon'], 6) if r['lon'] is not None else None,
        'match': r['matchMethod'],
        'boardings': r['boardings'],
        'alightings': r['alightings'],
        'load': r['load'],
        'byPeriod': r['byPeriod'],
    })

# per-pattern row sums
for p in patterns:
    pr = [r for r in rows if r['patternId'] == p['id']]
    p['rowSumBoardings'] = sum(r['boardings'] for r in pr)
    p['rowSumAlightings'] = sum(r['alightings'] for r in pr)

# ---- coverage ----
routes_all = sorted({r['route'] for r in rows})
stops_matched = {r['stopId'] for r in rows if r['stopId']}
tot_on = sum(r['boardings'] for r in rows)
matched_on = sum(r['boardings'] for r in rows if r['stopId'])
per_tot = collections.Counter()
for r in rows:
    for k, v in r['byPeriod'].items():
        per_tot[k] += v[0]
routes_now = {r['gtfsRouteId'] for r in rows if r['gtfsRouteId']}

# ---- by-stop (all routes) aggregate for matched stops ----
by_stop = collections.defaultdict(lambda: {'boardings': 0, 'alightings': 0, 'routes': set()})
for r in rows:
    if r['stopId']:
        a = by_stop[r['stopId']]
        a['boardings'] += r['boardings']; a['alightings'] += r['alightings']; a['routes'].add(r['route'])
        a['lat'], a['lon'] = r['lat'], r['lon']
stop_totals = [{'stopId': k, 'lat': v['lat'], 'lon': v['lon'], 'boardings': v['boardings'],
                'alightings': v['alightings'], 'routes': sorted(v['routes'])}
               for k, v in sorted(by_stop.items(), key=lambda kv: -kv[1]['boardings'])]

# ---- school trips in current GTFS (service M21 vs M11) ----
trips = {t['trip_id']: t for t in csv.DictReader(open(G + 'trips.txt'))}
stops = {s['stop_id']: s for s in csv.DictReader(open(G + 'stops.txt'))}
want = {tid for tid, t in trips.items() if t['service_id'] in ('M11', 'M21')}
first, last, nst = {}, {}, collections.Counter()
for r in csv.DictReader(open(G + 'stop_times.txt')):
    tid = r['trip_id']
    if tid not in want:
        continue
    s = int(r['stop_sequence']); nst[tid] += 1
    if tid not in first or s < first[tid][0]:
        first[tid] = (s, r['departure_time'], r['stop_id'])
    if tid not in last or s > last[tid][0]:
        last[tid] = (s, r['arrival_time'], r['stop_id'])
key = lambda tid: (trips[tid]['route_id'], trips[tid]['direction_id'], first[tid][1], first[tid][2], last[tid][2])
a = collections.Counter(key(t) for t in want if trips[t]['service_id'] == 'M11')
b = collections.Counter(key(t) for t in want if trips[t]['service_id'] == 'M21')
school_trips = []
seen = collections.Counter()
for tid in sorted(want, key=lambda t: key(t)):
    if trips[tid]['service_id'] != 'M21':
        continue
    k = key(tid)
    if b[k] - a[k] > seen[k]:
        seen[k] += 1
        t = trips[tid]
        school_trips.append({
            'tripId': tid, 'route': t['route_id'], 'directionId': int(t['direction_id']),
            'headsign': t['trip_headsign'],
            'firstStopId': first[tid][2], 'firstStop': stops[first[tid][2]]['stop_name'],
            'departs': first[tid][1][:5],
            'lastStopId': last[tid][2], 'lastStop': stops[last[tid][2]]['stop_name'],
            'arrives': last[tid][1][:5], 'stops': nst[tid]})
cal_dates = [r for r in csv.DictReader(open(G + 'calendar_dates.txt'))]
m21_dates = sorted(r['date'] for r in cal_dates if r['service_id'] == 'M21' and r['exception_type'] == '1')
m11_dates = sorted(r['date'] for r in cal_dates if r['service_id'] == 'M11' and r['exception_type'] == '1')


# ---- HTML tables ----
class TP(HTMLParser):
    def __init__(s):
        super().__init__(); s.tables = []; s.row = None; s.cell = None; s.depth = 0
    def handle_starttag(s, t, a):
        if t == 'table': s.depth += 1; s.tables.append([])
        elif t == 'tr' and s.depth: s.row = []
        elif t in ('td', 'th') and s.row is not None: s.cell = ''
        elif t == 'br' and s.cell is not None: s.cell += ' | '
    def handle_endtag(s, t):
        if t == 'table': s.depth -= 1
        elif t == 'tr' and s.row is not None: s.tables[-1].append(s.row); s.row = None
        elif t in ('td', 'th') and s.cell is not None: s.row.append(' '.join(s.cell.replace('\xad', '').split()).strip(' /|')); s.cell = None
    def handle_data(s, d):
        if s.cell is not None: s.cell += d


def tables(path):
    p = TP(); p.feed(open(path, encoding='utf-8').read()); return p.tables


def split_routes(s):
    return [x.strip() for x in re.split(r'\s*\|\s*', s) if x.strip()]


st = tables(RAW + '/youth/sfmta-muni-routes-serving-city-schools.html')
school_routes = []
for level, t in (('high', st[0]), ('middle', st[1])):
    for r in t[1:]:
        if len(r) < 5:
            continue
        school_routes.append({'level': level, 'school': r[0].strip(' /|'), 'address': r[1],
                              'closestRoutes': split_routes(r[3]),
                              'schoolTripperRoutes': split_routes(r[4].replace('Sunset 44', 'Sunset | 44'))})

bt = tables(RAW + '/youth/www.sfusd.edu_schools_enroll_resources_school-start-and-end-times-2025-26.html')
bell = []
for label, ti in (('K-8 (6-8 and K-5 campuses)', 2), ('middle', 3), ('high', 4)):
    for r in bt[ti][1:]:
        bell.append({'level': label, 'schoolId': r[0], 'school': r[1], 'start': r[2], 'end': r[3],
                     'earlyReleaseDay': r[4] or None, 'earlyReleaseEnd': r[5] or None})
for r in bt[5][1:]:
    bell.append({'level': 'other secondary', 'schoolId': None, 'school': r[0], 'start': r[1], 'end': r[2],
                 'earlyReleaseDay': None, 'earlyReleaseEnd': None})

TEP_URL = 'https://archives.sfmta.com/cms/rtep/tepdataindx.htm'
doc = {
    'source': 'SFMTA Transit Effectiveness Project (TEP) "Passenger Activity by Time Period" stop-level APC/ride-check reports, one CSV per route',
    'url': TEP_URL,
    'fileUrlPattern': 'https://archives.sfmta.com/cms/rtep/documents/PassengerActivity_ByTimePeriod_RT_<route>.csv (and Passenger_Activity_ByTimePeriod_<route>.csv for rail, cable car and some bus routes)',
    'publisher': 'San Francisco Municipal Transportation Agency (SFMTA), archived site archives.sfmta.com (marked "not current")',
    'period': 'Weekday service, October 2006 - June 2007 (Fall 2006 - Spring 2007)',
    'fetched': '2026-10-04',
    'warning': ('This is the most recent publicly downloadable, systemwide, stop-level Muni boardings/alightings dataset found. '
                'It is 2006-07 data: the network has changed since (TEP / Muni Forward restructuring 2015+, Central Subway 2023, '
                'route renumbering, stop consolidation). No 2024-2026 stop-level Muni ridership was found in any public source '
                '(see notes.searched). Use it for within-route spatial shape and time-of-day profiles, and scale to recent route '
                'totals (server/beta3/reference/muni-route-ridership.json) rather than using the absolute numbers.'),
    'method': ('Per the source page: SFMTA equipped 10 percent of the bus fleet with Automatic Passenger Counters and deployed them to sample every '
               'scheduled weekday trip at least once (average five samples per trip); samples of the same trip were averaged. Muni Metro light '
               'rail and trolley coaches were counted manually by ride-check staff over the same period. Values are average weekday on/off '
               'counts per stop per route pattern; "load" is passengers on board departing the stop (as given). Stop IDs were not in the source: '
               'each source stop name (Trapeze format, e.g. "Judah St&19th Ave SW-NS/SI") was matched to the current DataSF "Muni Stops" '
               'inventory (dataset i28k-bkz6, data_as_of 2026-04-08) and current Muni GTFS (feed valid 2026-07-23 to 2026-08-28) by: '
               'exact name; else same street pair + orientation; else same street pair among stops the same GTFS route serves today '
               '(nearest to the previously matched stop if several); subway stations by station name and direction. The match method '
               'is recorded per row ("match"). Unmatched rows (stop removed/moved since 2007, or unparseable names) keep stopId/lat/lon null. '
               'gtfsDirectionId is the current GTFS direction whose weekday stop set overlaps the pattern\'s matched stops most '
               '(only set when overlap >= 50%).'),
    'stopIdField': ('stopId = Muni GTFS stops.txt stop_id (= DataSF Muni Stops "stopid"; 3,234 of 3,260 DataSF stopids exist as GTFS stop_id). '
                    'GTFS stop_code is "1" + stop_id (e.g. stop_id 5200 -> stop_code 15200), given as stopCode.'),
    'periods': {
        'labels': ['am', 'midday', 'school', 'pm', 'evening', 'owl'],
        'sourceLabels': 'AM Peak, Midday, School, PM Peak, Evening, Owl (rail files label the last period "Night")',
        'definitions': 'Clock-time boundaries of the periods are not stated in the downloaded CSVs or index page (the user manual PDF linked from the index returns 404).',
        'byPeriodFormat': '{period: [boardings, alightings]}; a period is omitted where the source cell is blank',
    },
    'coverage': {
        'sourceFiles': 81,
        'routes': len(routes_all),
        'routeList': routes_all,
        'routesStillInCurrentGtfs': len(routes_now),
        'patterns': len(patterns),
        'rows': len(rows),
        'rowsMatchedToCurrentStop': sum(1 for r in rows if r['stopId']),
        'distinctCurrentStopsMatched': len(stops_matched),
        'weekdayBoardingsAllRows': tot_on,
        'weekdayBoardingsOnMatchedRows': matched_on,
        'boardingsByPeriodAllRows': dict(per_tot),
        'matchMethods': dict(collections.Counter(r['match'] for r in rows)),
    },
    'notes': [
        'route is the 2006-07 route as named in the source file (e.g. "1AX", "9X", "KT", "L-Owl", "PH" = 60 Powell-Hyde cable car, "C" = 61 California cable car); gtfsRouteId is the same-named route in today\'s GTFS when one exists (KT -> K, C -> CA). Same name does not mean same alignment (e.g. 2006 route 15 Third Street was replaced by the T line; 30X file title in the source is used for both 30X and route 30 - the index labels Passenger_Activity_ByTimePeriod_030.csv "Route 30 data").',
        'direction is the source pattern destination ("to <place>") for bus files, or Inbound/Outbound for the N and L rail files.',
        'Rail N and L files are "Two Cars" ride-check reports; the subway station rows (e.g. "Civic Center Station Inbound") were matched to the current Metro station platform stops.',
        'Some patterns carry branch variants in one block, so a stop can appear twice in one pattern, and row sums do not always equal the source "Total Passenger Boardings" line; both are in patterns[] (e.g. 9 San Bruno to McLaren Park: source total 4,863 on vs row sum 7,739).',
        'The 2006-07 rows sum to ' + format(tot_on, ',') + ' weekday boardings (all files, both directions); this is a 2006-07 level and is not comparable to recent Muni weekday boardings, so scale per route to recent route totals.',
        'stopTotals aggregates matched rows across all routes and patterns by current stop_id (same 2006-07 period).',
    ],
    'searched': [
        'DataSF (data.sfgov.org now redirects to data.sf.gov; full catalog of 1,224 datasets listed via /api/views/metadata/v1): no Muni ridership-by-stop dataset; only stop inventory (Muni Stops i28k-bkz6), routes, GTFS, vehicle locations, fare citations.',
        'MTC open data (data.bayareametro.gov, 3,436 datasets listed; opendata.mtc.ca.gov hub): only Vital Signs operator/mode totals, no stop-level boardings.',
        'SFMTA Transtat public Tableau (transtat-public.sfmta.com): public CSV views found are RidershipbyRoute, RouteRidershipRecovery, SystemwideRidershipRecovery, CrowdingbyRoute, ScheduledServiceRecoveryRidershipRecoverybyRoute (all route or system level). Server does not allow anonymous browsing; ~100 guessed stop-level workbook names (RidershipbyStop, StopRidership, BoardingsbyStop, ...) do not exist (server returns 500 for unknown workbooks, 404 for unknown sheets of known workbooks).',
        'sfmta.com MuniData dashboards: route/system level only. sf.gov "Muni ridership" page: systemwide Power BI.',
        'SFCTA: api.sfcta.org PostgREST (all tables listed) has no stop-level Muni APC table; prospector.sfcta.org did not respond; GitHub sfcta repos reference Muni APC inputs only on internal drives.',
        'SFMTA SFpark Transit Data 2011-2013 (sfmta.com/reports/sfpark-transit-data): trip x parking-district segment APC records, not per stop, so not used.',
        'Muni Metro Capacity Study appendix (Sept 2025, sfmta.com/media/43313): line-level forecasts, no stop/station boardings.',
        'Project documents (e.g. 8 Bayshore stop improvements, MTAB 3-17-26) quote a few per-stop daily boardings for single corridors only.',
    ],
    'patterns': patterns,
    'rows': rows,
    'stopTotals': stop_totals,
    'youth': {
        'freeMuniForYouth': {
            'policy': 'All youth 18 and younger ride Muni free regardless of household income or residency; no Clipper card or proof of payment needed except on cable cars.',
            'policyUrl': 'https://www.sfmta.com/fares/free-muni-all-youth-18-years-and-younger',
            'gtfsFare': 'Current Muni GTFS (raw/gtfs/muni.zip) fare_rider_categories.txt: rider_category 5 "Youth" and 3 "Child" price 0 on fare_id 1 (local fare, $3.00 adult); on fare_id 2 ($9 adult, cable car) Youth 8, Child 0.',
            'shareOfRidership': None,
            'shareNote': 'No published 2024-2026 youth share of Muni boardings (systemwide or by route) was found. Since 2021 youth do not need to tap Clipper, so fare data no longer counts youth trips; the SFMTA 2024 Ridership Survey (sfmta.com/media/40063) samples adult residents only.',
            'figures': [
                {'value': 0.092, 'what': 'Youth Clipper card tags as a share of all Muni Clipper tags, May 2013 (7.1% in May 2012)',
                 'period': 'May 2013', 'source': 'SF Board of Supervisors Budget and Legislative Analyst, Free Muni for Youth policy analysis, 2014-02-18',
                 'url': 'https://sfbos.archive.sf.gov/sites/default/files/FileCenter/Documents/47980-BLA%20FMFY%20021814.pdf',
                 'caveat': 'Clipper tags only (cash/paper excluded), 2013 low/moderate-income pilot.'},
                {'value': 266025, 'what': 'Additional youth Clipper tags on Muni in May 2013 vs May 2012 (+41.1%)', 'period': 'May 2013',
                 'url': 'https://sfbos.archive.sf.gov/sites/default/files/FileCenter/Documents/47980-BLA%20FMFY%20021814.pdf'},
                {'value': 31262, 'what': 'Youth registered for Free Muni for Youth, 78.2% of an estimated 40,000 eligible (same report also prints 31,672 for the same date)',
                 'period': '2014-02-13', 'url': 'https://sfbos.archive.sf.gov/sites/default/files/FileCenter/Documents/47980-BLA%20FMFY%20021814.pdf'},
                {'value': 39350, 'what': 'Active Free Muni for Youth users, about 72% of those eligible (before the program was opened to all youth); SFMTA says the expansion makes Muni free for more than 100,000 young people',
                 'period': '2021-07 (SFMTA blog dated 2021-07-09)', 'url': 'https://www.sfmta.com/blog/young-people-ride-muni-free'},
                {'value': 16500000, 'what': 'Estimated Free Muni trips per July-June year, all Free Muni groups combined (youth, low/moderate-income seniors and people with disabilities), worth over $41M in fares',
                 'period': 'program year (California Climate Investments 2026 profile)',
                 'url': 'https://www.caclimateinvestments.ca.gov/2026-profiles/sf-free-muni-program-makes-public-transit-more-accessible-and-equitable',
                 'caveat': 'Not youth-only.'},
                {'value': round(per_tot['school'] / tot_on, 4), 'what': 'Share of TEP 2006-07 weekday boardings (rows in this file) that fall in the "School" time period',
                 'period': 'Oct 2006 - Jun 2007', 'url': TEP_URL,
                 'caveat': 'A time-of-day window, not a rider-age measure.'},
            ],
        },
        'schoolTrippers': {
            'description': 'SFMTA: "school trippers" are extra afternoon buses on existing lines that begin at a school site, pick up students at the end of the school day (except early dismissal days), then continue along the route.',
            'url': 'https://www.sfmta.com/getting-around/muni/routes-stops/muni-routes-serving-city-schools',
            'pageModified': '2026-08-24',
            'bySchool': school_routes,
            'gtfs': {
                'feed': 'data/beta3/raw/gtfs/muni.zip (calendar 2026-07-23 to 2026-08-28)',
                'method': 'Weekday service M21 (active ' + (m21_dates[0] if m21_dates else '?') + ' to ' + (m21_dates[-1] if m21_dates else '?') +
                          ') compared with weekday service M11 (active ' + (m11_dates[0] if m11_dates else '?') + ' to ' + (m11_dates[-1] if m11_dates else '?') +
                          '): trips present in M21 but not M11 (same route, direction, first stop, first departure, last stop). Every other M21 trip is identical to M11.',
                'm21Dates': m21_dates,
                'extraTrips': school_trips,
                'extraTripCount': len(school_trips),
                'routes': sorted({t['route'] for t in school_trips}, key=lambda x: (len(x), x)),
                'note': 'All extra trips start between 15:35 and 16:10 (afternoon dismissal); no extra morning trips are in the feed. The 2024 GTFS (muni-2024.zip, 2024-06-22 to 2024-08-16) covers summer only and has no school-day service.',
            },
        },
        'sfusdBellTimes': {
            'schoolYear': '2025-26',
            'url': 'https://www.sfusd.edu/schools/enroll/resources/school-start-and-end-times-2025-26',
            'note': 'No 2026-27 page was found (school-start-and-end-times-2026-27 returns 404). Elementary (K-5) and early-education rows are omitted here; they are in the saved raw HTML.',
            'schools': bell,
        },
    },
    'rawFiles': {
        'dir': 'data/beta3/raw/muni-stops/',
        'files': ['tep-2006-07/*.csv (81 route files) + tepdataindx.htm', 'datasf-muni-stops-i28k-bkz6.csv (https://data.sf.gov/resource/i28k-bkz6.csv)',
                  'youth/sfmta-muni-routes-serving-city-schools.html', 'youth/www.sfusd.edu_schools_enroll_resources_school-start-and-end-times-2025-26.html',
                  'youth/sfbos-bla-free-muni-for-youth-2014-02-18.pdf', 'youth/sfmta-blog-young-people-ride-muni-free.html',
                  'youth/www.caclimateinvestments.ca.gov_2026-profiles_sf-free-muni-program-makes-public-transit-more-accessible-and-equitable.html',
                  'youth/sfmta-free-muni-all-youth.html', 'youth/sfmta-ridership-survey-2024-exec-summary.pdf'],
    },
}
BIG = ('patterns', 'rows', 'stopTotals')
head = {k: v for k, v in doc.items() if k not in BIG}
parts = [json.dumps(head, indent=1, ensure_ascii=False)[:-2]]
for k in BIG:
    items = ',\n  '.join(json.dumps(x, separators=(',', ':'), ensure_ascii=False) for x in doc[k])
    parts.append(',\n ' + json.dumps(k) + ': [\n  ' + items + '\n ]')
s = ''.join(parts) + '\n}\n'
json.loads(s)
open(OUT, 'w').write(s)
print('bytes', len(s), 'rows', len(rows), 'patterns', len(patterns), 'stops', len(stop_totals), 'school trips', len(school_trips))
print(json.dumps(doc['coverage'], indent=1)[:1500])
