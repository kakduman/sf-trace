"""
School and college travel in San Francisco: the inputs behind the model's school and college demand
(params.ts SCHOOL_LEVELS, COLLEGE; demand.ts). Reads the downloads of fetch_students.sh and the ACS
tract file of fetch-data.ts, adds the figures transcribed from the PDF reports (page numbers given),
and writes server/beta3/reference/student-travel.json.
Run: sh server/beta3/pipeline/research/fetch_students.sh && python3 server/beta3/pipeline/research/students.py
"""
import csv, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..'))
RAW = os.environ.get('BETA3_RAW', os.path.join(ROOT, 'data/beta3/raw'))
ST = os.path.join(RAW, 'students')
OUT = os.path.join(ROOT, 'server/beta3/reference/student-travel.json')

# ---- IPEDS: San Francisco's colleges, fall 2023 enrollment by distance-education status ----
hd = {r['UNITID']: r for r in csv.DictReader(open(os.path.join(ST, 'HD2024.csv'), encoding='utf-8-sig', errors='replace'))}
sf = {u: r for u, r in hd.items() if r['STABBR'] == 'CA' and r['COUNTYCD'] == '6075'}
num = lambda v: int(v) if v.strip() else 0
inst = []
for r in csv.DictReader(open(os.path.join(ST, 'ef2023a_dist.csv'), encoding='utf-8-sig')):
    if r['UNITID'] in sf and r['EFDELEV'].strip() == '1':
        h = sf[r['UNITID']]
        tot, exc, some = num(r['EFDETOT']), num(r['EFDEEXC']), num(r['EFDESOM'])
        inst.append({'unitid': r['UNITID'], 'name': h['INSTNM'], 'lat': float(h['LATITUDE']), 'lon': float(h['LONGITUD']),
                     'enrolled': tot, 'exclusivelyDistance': exc, 'someDistance': some, 'inPerson': tot - exc})
inst.sort(key=lambda x: -x['enrolled'])
ipeds = {
    'source': 'IPEDS (NCES), HD2024 institutional characteristics and EF2023A_DIST fall 2023 enrollment by distance-education status, all students (EFDELEV 1), institutions in San Francisco County (COUNTYCD 6075)',
    'url': 'https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx',
    'retrieved': '2026-10-06',
    'institutions': inst,
    'totals': {'enrolled': sum(x['enrolled'] for x in inst), 'exclusivelyDistance': sum(x['exclusivelyDistance'] for x in inst), 'inPerson': sum(x['inPerson'] for x in inst)},
    'note': 'inPerson = enrolled less exclusively distance education: students who take at least one class on campus. Fall 2023 is the latest distance-education file published (EF2024A_DIST returned 404 on 2026-10-06).',
}

# ---- ACS: San Francisco residents enrolled in school, by level (tract table, summed) ----
rows = list(csv.DictReader(open(os.path.join(RAW, 'census/acs_b14001_tract.dat')), delimiter='|'))
S = lambda k: sum(float(x['B14001_' + k] or 0) for x in rows)
acs = {'kindergarten': S('E004'), 'grades1to4': S('E005'), 'grades5to8': S('E006'), 'grades9to12': S('E007'), 'collegeUndergraduate': S('E008'), 'graduate': S('E009')}
lev = {'elementary': acs['kindergarten'] + acs['grades1to4'] + acs['grades5to8'] / 4, 'middle': acs['grades5to8'] * 3 / 4, 'high': acs['grades9to12']}
k12 = sum(lev.values())
acsEnrollment = {
    'source': 'ACS 2020-2024 5-year, table B14001 (school enrollment by level of school for the population 3 years and over), San Francisco tracts',
    'byLevel': {k: round(v) for k, v in acs.items()},
    'pupilsByModelLevel': {k: round(v) for k, v in lev.items()},
    'modelLevelShares': {k: round(v / k12, 4) for k, v in lev.items()},
    'note': 'The model\'s levels follow the schools\' grade bands: elementary TK-5 (kindergarten, grades 1-4, and a quarter of grades 5-8), middle 6-8 (three quarters of grades 5-8), high 9-12.',
}

# ---- Travel Model One school location choice (ActivitySim prototype_mtc) ----
coef = {r['coefficient_name']: float(r['value']) for r in csv.DictReader(open(os.path.join(ST, 'asim_school_location_coefficients.csv'))) if not r['coefficient_name'].startswith('#')}
pw = lambda a, b, c, d, e: [coef[a], coef[b], coef[c], coef[d], coef[e]]
tm1 = {
    'source': 'ActivitySim prototype_mtc (Travel Model One), configs/school_location.csv and school_location_coefficients.csv',
    'url': 'https://github.com/ActivitySim/activitysim/tree/main/activitysim/examples/prototype_mtc/configs',
    'retrieved': '2026-10-06',
    'piecewiseMiles': ['0-1', '1-2', '2-5', '5-15', '15+'],
    'utilityPerMile': {
        'gradeschool': pw('coef_grade_dist_0_1', 'coef_high_grade_dist_1_2', 'coef_high_grade_dist_2_5', 'coef_grade_dist_5_15', 'coef_grade_dist_15_up'),
        'highschool': pw('coef_high_dist_0_1', 'coef_high_grade_dist_1_2', 'coef_high_grade_dist_2_5', 'coef_high_dist_5_15', 'coef_high_dist_15_up'),
        'university': pw('coef_univ_dist_0_1', 'coef_univ_dist_1_2', 'coef_univ_dist_2_5', 'coef_univ_dist_5_15', 'coef_univ_dist_15_up'),
    },
    'modeChoiceLogsum': coef['coef_mode_logsum'],
    'gradeSchoolMaxAge': 14,
    'shadowPricing': 'school_location.yaml: shadow prices on the size terms so that each zone receives its enrollment (CTRAMP method)',
}

out = {
    'title': 'School and college travel in San Francisco: enrollment, assignment, trip length, mode, and fares',
    'built': '2026-10-06',
    'script': 'server/beta3/pipeline/research/students.py (downloads: fetch_students.sh)',
    'ipeds': ipeds,
    'acsEnrollment': acsEnrollment,
    'tm1SchoolLocation': tm1,
    'sfusd': {
        'assignment': 'Elementary: citywide choice by ranked application and lottery, with attendance-area and CTIP1 tiebreakers (zones from 2026-27 kindergarten entry). Middle: feeder patterns from elementary schools, with choice. High: citywide choice; Lowell and Ruth Asawa SOTA admit by application. SFUSD, Student Assignment Policy, https://www.sfusd.edu/schools/enroll/student-assignment-policy (accessed 2026-10-06).',
        'k5Distance2017': {'source': 'SFCTA, San Francisco School Access Plan (May 2023), Figure 5 (p. 16), from SFUSD\'s 2017 travel analysis', 'lessThan1mi': 0.506, 'mi1to2': 0.215, 'mi2plus': 0.278,
                           'outsideHomeRegion': 0.44, 'note': 'SFUSD K-5 students; how distance was measured is not stated. Southeast residents: 82% attend school in another of nine regions (Table 1, p. 17).'},
        'k5MeanDistanceMentzer2023': {'miles': 1.39, 'source': 'Mentzer (2023), Stanford PhD thesis, abstract: simulated average distance to the assigned school under the status quo policy (incoming kindergarten)'},
        'k5Mode2019': {'source': 'SFCTA School Access Plan, Figures 7 and 8 (p. 17), SFUSD survey', 'kindergarten': {'anyCar': 0.527, 'anyBus': 0.161, 'walk': 0.274, 'bike': 0.025, 'other': 0.013},
                       'grade5': {'anyCar': 0.560, 'anyBus': 0.164, 'walk': 0.259, 'bike': 0.007, 'other': 0.010}, 'note': '"Any bus" is Muni and yellow school buses together.'},
        'yellowBus': {'source': 'SFCTA School Access Plan, p. 18', 'generalEducationBuses': 25, 'schoolsServed': 46, 'studentsDaily': 2000},
        'publicK5Enrollment2025': 23476,
        'schoolTrippers': 'Muni school trippers: extra afternoon trips on regular routes starting at middle and high schools (School Access Plan, p. 19).',
    },
    'sfsu': {
        'enrollmentFall2025': 20713,
        'residence2018': {'source': 'SF State 2018 Transportation Survey Results (Nelson\\Nygaard), Figure 3-4 (p. 10): affiliates by county of residence (ZIP code)',
                          'shares': {'San Francisco': 0.41, 'Alameda': 0.19, 'San Mateo': 0.20, 'Contra Costa': 0.11, 'Santa Clara': 0.03, 'Marin': 0.02, 'Solano': 0.01}},
        'arrivalMode2018': {'source': 'SF State 2018 survey, Figure 3-6 (p. 11): mode of arrival on campus, all affiliates on campus May 2, 2018 (n = 3,273)',
                            'shares': {'muni': 0.314, 'driveAlone': 0.231, 'sfsuShuttle': 0.171, 'walk': 0.140, 'rideHail': 0.053, 'carpool': 0.022, 'droppedOff': 0.022, 'otherBus': 0.022, 'bike': 0.014, 'other': 0.007, 'motorcycle': 0.004}},
        'studentModes2023': {'source': 'SF State Transportation Survey Results Report 2023, Table 2-4 (p. 6): share of students reporting each mode to campus in the week of May 1, 2023 (several modes per day allowed)',
                             'shares': {'driveAlone': 0.41, 'muni': 0.27, 'bart': 0.22, 'walk': 0.16, 'carpool': 0.085, 'samtrans': 0.058, 'acTransit': 0.042, 'caltrain': 0.033, 'taxi': 0.023, 'bike': 0.019, 'ggTransit': 0.009, 'motorcycle': 0.009, 'ebike': 0.008, 'ferry': 0.006}},
        'schedule2023': 'Most students come to campus 2-4 days a week (2023 report, Key Findings, p. 2; TDM Plan Update 2025, PDF p. 7: "students attending campus 2-4 days per week"); the academic year is 30 weeks of classes and finals (2023 report, p. 9).',
        'driveAlone2023': {'students': 0.41, 'source': 'SF State TDM Plan Update 2025 (PDF p. 13, objective 14: "Reduce the student drive-alone rate to below 30% by 2030 (currently 41%)"), from the 2023 survey, Table 2-4', 'url': 'https://sustain.sfsu.edu/sites/default/files/documents/TDMPlanUpdate2025.pdf'},
        'shuttle': 'The free SF State shuttle from Daly City BART was discontinued in fall 2024; Muni serves the link (TDM Plan Update 2025, PDF p. 12).',
        'starsCommuteModalSplit': {'urls': ['https://reports.aashe.org/institutions/san-francisco-state-university-ca/report/2023-07-21/OP/transportation/OP-16/', 'https://reports.aashe.org/institutions/san-francisco-state-university-ca/report/2017-02-15/OP/transportation/OP-16/'],
                                   'status': 'AASHE STARS credit pages require a login (checked 2026-10-06); not used.'},
        'gatorPass': {'muniSince': '2017-18 (unlimited Muni, 25% off BART to or from Daly City)', 'bayPassSince': '2024-08-26',
                      'covers': 'unlimited rides on all Bay Area operators that take Clipper (Clipper BayPass), fall and spring semesters', 'feePerSemester': 130,
                      'sources': ['https://news.sfsu.edu/news/sfsu-students-gain-unlimited-free-rides-bay-area-public-transportation (2024-09-24)', 'https://vpsaem.sfsu.edu/gator-pass-transit-fee']},
    },
    'ccsf': {
        'residence': {'source': 'CCSF Office of Research and Planning, Fact Sheet: Student Residence (May 2023): credit students by region of residence',
                      '2021-22': {'San Francisco': 0.720, 'East Bay': 0.081, 'Marin': 0.012, 'Peninsula': 0.068, 'South Bay': 0.013, 'Other non-Bay Area': 0.056, 'Unknown': 0.049}},
        'headcount2025_26': {'credit': 28491, 'noncredit': 11792, 'all': 39315, 'source': 'CCSF Fact Sheet: Student Demographics (August 2026); annual unduplicated headcount'},
        'transitPass': 'No student transit pass as of 2025 (The Guardsman; Free City funds tuition only).',
        'transit2018': {'share': 0.48, 'source': 'The Guardsman, "Could a Transit Pass Be in City College Students\' Future?" (2025), citing a 2018 CCSF survey of students\' modes of transportation: 48 percent used transit. The survey itself was not found; secondary, used only as a check.',
                        'url': 'https://www.theguardsman.com/could-a-transit-pass-be-in-city-college-students-future/'},
    },
    'attendance': {
        'daysPerWeek': 3, 'weeksPerYear': 30,
        'note': 'Assumed: a student who takes classes on campus comes 3 days a week (SF State 2023: "2-4 days") for 30 weeks a year (SF State\'s academic year), so on an average weekday of the year 3/5 x 30/52 of them travel to campus.',
    },
}
json.dump(out, open(OUT, 'w'), indent=1, ensure_ascii=False)
print(f"written {OUT}: {len(inst)} institutions, {ipeds['totals']['inPerson']} in person; ACS K-12 {round(k12)} {acsEnrollment['modelLevelShares']}")
