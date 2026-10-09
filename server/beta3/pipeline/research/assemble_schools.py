import os
import json
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..'))
WORKR = os.path.join(ROOT, 'data/beta3/work/research')  # intermediates (gitignored)
SP = WORKR
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '/server/beta3/reference/sf-schools.json'
core = json.load(open(f'{SP}/schools_core.json'))
S = core['schools']; T = core['totals']

ORDER = ['cds', 'name', 'type', 'grades', 'enrollment', 'tk', 'k5', 'g68', 'g912', 'lat', 'lon', 'year', 'street', 'zip', 'district',
         'schoolType', 'edOps', 'nontraditional', 'geocode', 'bell', 'note']
schools = []
for s in sorted(S, key=lambda x: ({'public': 0, 'charter': 1, 'private': 2}[x['type']], x['name'].lower())):
    if 'year' not in s: s['year'] = '2025-26'
    schools.append({k: s[k] for k in ORDER if k in s})

pubs_all = [s for s in schools if s['type'] != 'private']
sfusd_bell = [s for s in schools if 'bell' in s]

out = {
  'title': 'San Francisco K-12 schools: enrollment, grade span, location; school travel; senior/youth Muni fare programs',
  'built': '2026-10-04',
  'sources': [
    {'id': 'cde-directory', 'publisher': 'California Department of Education (CDE)', 'name': 'Public Schools and Districts directory (pubschls.txt)',
     'url': 'https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt', 'landing': 'https://www.cde.ca.gov/ds/si/ds/pubschls.asp',
     'retrieved': '2026-10-04', 'period': 'directory as of retrieval date',
     'method': 'Kept County = San Francisco, StatusType = Active, School != "No Data". Coordinates, street, grade span (GSserved), SOCType and EdOpsName come from here.'},
    {'id': 'cde-census-enrollment', 'publisher': 'CDE, Educational Data Management Division', 'name': 'Census Day Enrollment by school, 2025-26 (cdenroll2526.txt)',
     'url': 'https://www3.cde.ca.gov/demo-downloads/census/cdenroll2526.txt', 'landing': 'https://www.cde.ca.gov/ds/ad/filesenrcensus.asp',
     'retrieved': '2026-10-04', 'period': '2025-26 Census Day (first Wednesday of October 2025)',
     'method': 'Rows with AggregateLevel = S, CountyCode = 38, ReportingCategory = TA (total). CDS = CountyCode + DistrictCode + SchoolCode, joined to the directory. Bands: k5 = GR_TK + GR_KN..GR_05 (TK counted in k5 and also reported separately as tk), g68 = GR_06..GR_08, g912 = GR_09..GR_12. The file-layout page (fsenrcensus.asp) was behind a bot-check and could not be read; the column names are self-describing.'},
    {'id': 'cde-private-2526', 'publisher': 'CDE, Educational Data Management Division', 'name': '2025-26 Private School Data for Schools with Six or More Students (Private School Affidavits)',
     'url': 'https://www.cde.ca.gov/ds/si/ps/documents/privateschooldata2526.xlsx', 'landing': 'https://www.cde.ca.gov/ds/si/ps/',
     'retrieved': '2026-10-04', 'period': '2025-26 school year (affidavits filed Oct 2025; file revised 9/25/2026)',
     'method': 'Rows with County = San Francisco. Enrollment by grade K-12 is as self-reported on the affidavit. The file has no addresses.'},
    {'id': 'cde-private-2425', 'publisher': 'CDE', 'name': '2024-25 Private School Data (Private School Affidavits)',
     'url': 'http://web.archive.org/web/20260604193439id_/https://www.cde.ca.gov/ds/si/ps/documents/privateschooldata2425.xlsx',
     'original': 'https://www.cde.ca.gov/ds/si/ps/documents/privateschooldata2425.xlsx', 'retrieved': '2026-10-04 (Wayback capture of 2026-06-04; cde.ca.gov served a bot-check)',
     'period': '2024-25 school year (file created 7/01/2025)',
     'method': 'Used only for SF schools that have no 2025-26 affidavit. Those records carry year = "2024-25". The 2023-24 file was also downloaded for checking but not used.'},
    {'id': 'osm', 'publisher': 'OpenStreetMap contributors (ODbL)', 'name': 'Overpass API extracts',
     'url': 'https://overpass-api.de/api/interpreter',
     'files': ['data/beta3/raw/pois.json (existing POI extract, OSM base 2026-10-04)', 'data/beta3/raw/schools/osm_extra_names.json', 'data/beta3/raw/schools/osm_extra_names2.json'],
     'retrieved': '2026-10-04',
     'method': 'Private schools were geocoded by matching the affidavit name to OSM school features. A token-overlap pass found candidates, and each match was reviewed by hand (multi-campus schools were assigned by grade span or street). Two targeted name queries found six schools that pois.json lacks. Points are way/relation centroids or nodes.'},
    {'id': 'sfusd-bell', 'publisher': 'San Francisco Unified School District', 'name': 'School Start and End Times for 2025-26',
     'url': 'https://www.sfusd.edu/schools/enroll/resources/school-start-and-end-times-2025-26', 'retrieved': '2026-10-04', 'period': '2025-26 school year',
     'method': 'Parsed the HTML tables (Elementary, K-8, Middle, High, County). Rows were matched to CDE school names by name tokens, with manual overrides for ambiguous names. Preschool/EES, SDC and "(Access)" program rows are not attached to schools.'},
    {'id': 'sfcta-cts', 'publisher': 'San Francisco County Transportation Authority', 'name': 'Child Transportation Study: Findings of the Child Transportation Survey, Final Report',
     'url': 'http://web.archive.org/web/20231201031939id_/https://www.sfcta.org/sites/default/files/2019-03/Child_Transportation_FINAL.pdf',
     'original': 'https://www.sfcta.org/sites/default/files/2019-03/Child_Transportation_FINAL.pdf', 'landing': 'https://www.sfcta.org/projects/child-transportation-study',
     'retrieved': '2026-10-04 (sfcta.org returned 403; Wayback capture)', 'period': 'survey conducted 2015-16, published 2016',
     'method': 'Survey of more than 1,700 SF parents of school-age children (SFUSD, private and other schools), in English, Spanish and Chinese. Table 3 gives mode shares.'},
    {'id': 'sfcta-sap', 'publisher': 'San Francisco County Transportation Authority (with SFMTA, SFUSD, DCYF)', 'name': 'San Francisco School Access Plan, Final Report (May 2023)',
     'url': 'https://web.archive.org/web/20240916150655id_/https://www.sfcta.org/sites/default/files/2024-07/SF_School_Access_Plan_Report_2023-05-04_FINAL.pdf',
     'original': 'https://www.sfcta.org/sites/default/files/2024-07/SF_School_Access_Plan_Report_2023-05-04_FINAL.pdf', 'landing': 'https://www.sfcta.org/projects/school-access-plan',
     'retrieved': '2026-10-04 (Wayback capture 2024-09-16; sfcta.org returned 403)', 'period': 'report May 2023; SFUSD mode survey 2019 (Figures 7 and 8); SFUSD distance analysis 2017',
     'method': 'Figures 1/5, 7 and 8 and the yellow-bus text on pp. 17-18 were transcribed.'},
    {'id': 'sfmta-fares', 'publisher': 'SFMTA', 'name': 'Fares; Single Ride - Discount; Muni Fare Changes Effective July 1, 2025; fare table FY24-FY26',
     'url': ['https://www.sfmta.com/getting-around/muni/fares', 'https://www.sfmta.com/fares/single-ride-discount',
             'https://www.sfmta.com/notices/muni-fare-changes-effective-july-1-2025', 'https://www.sfmta.com/media/41081/download'],
     'retrieved': '2026-10-04', 'period': 'fares in effect since 2025-07-01 (FY25-26), still listed as current on 2026-10-04'},
    {'id': 'sfmta-fare-proposal-fy27', 'publisher': 'SFMTA', 'name': 'Proposed Changes to Fares, Fees and Fines (FY 2026-27 and FY 2027-28)',
     'url': 'https://www.sfmta.com/project-updates/proposed-changes-fares-fees-and-fines-fy-2026-27-and-fy-2027-28', 'retrieved': '2026-10-04', 'period': 'proposal heard April 2026'},
    {'id': 'sfmta-board-2025-12', 'publisher': 'SFMTA Board of Directors', 'name': 'Enterprise Revenue and Fare Policy Options (Dec. 16, 2025), slide 7 "Transit Fare Discount Programs"',
     'url': 'https://www.sfmta.com/media/44089/download?inline=', 'retrieved': '2026-10-04', 'period': 'participants and cost for FY24-25'},
    {'id': 'sfmta-asna-2024', 'publisher': 'SFMTA', 'name': 'Accessibility Strategy Needs Assessment 2024, section 4.2 Affordable Muni',
     'url': 'https://www.sfmta.com/accessibility-strategy-needs-assessment-2024/muni-service-planning-and-policy/42-affordable-muni', 'retrieved': '2026-10-04',
     'period': 'Clipper Access count as of Dec 2023; Clipper tag table 7/2018-2/2023'},
    {'id': 'sf-controller-2023', 'publisher': 'Office of the Controller, City and County of San Francisco', 'name': 'SFMTA Should Strengthen the Eligibility Screening Process for Its Free Muni Program (memo, March 30, 2023)',
     'url': 'https://www.sf.gov/sites/default/files/2023-03/SFMTA%20Free%20Fare%20Audit%20Memo%2003.30.23.pdf', 'retrieved': '2026-10-04'},
    {'id': 'sfmta-free-muni-pages', 'publisher': 'SFMTA', 'name': 'Free Muni for All Youth; Free Muni for Seniors',
     'url': ['https://www.sfmta.com/fares/free-muni-all-youth-18-years-and-younger', 'https://www.sfmta.com/fares/free-muni-seniors'], 'retrieved': '2026-10-04'},
    {'id': 'cci-2026', 'publisher': 'California Climate Investments', 'name': "San Francisco's Free Muni Program Makes Public Transit More Accessible and Equitable (2026 profile)",
     'url': 'https://www.caclimateinvestments.ca.gov/2026-profiles/sf-free-muni-program-makes-public-transit-more-accessible-and-equitable', 'retrieved': '2026-10-04'},
    {'id': 'mtc-2011', 'publisher': 'MTC / SFMTA news release', 'name': 'SFMTA Reminds Muni Senior Pass Customers that Now is the Time to Switch to Clipper (June 11, 2011)',
     'url': 'https://mtc.ca.gov/news/sfmta-reminds-muni-senior-pass-customers-now-time-switch-clipper', 'retrieved': '2026-10-04'},
  ],
  'fields': {
    'cds': '14-digit CDE County-District-School code (private: the affidavit CDS code)',
    'type': 'public (SFUSD or SF County Office of Education, non-charter) | charter | private',
    'grades': 'public: CDE GSserved (grades served); private: lowest to highest grade with enrollment > 0 on the affidavit (K-12 only, so no preschool)',
    'enrollment': 'public: 2025-26 Census Day TOTAL_ENR (includes TK); private: affidavit Total Enrollment (K-12)',
    'tk': 'public only: transitional kindergarten (also counted in k5)', 'k5': 'TK/K through grade 5', 'g68': 'grades 6-8', 'g912': 'grades 9-12',
    'year': 'school year of the enrollment figure',
    'nontraditional': 'true for schools whose CDE EdOpsName is not "Traditional" (continuation, alternative of choice, juvenile court, county community, opportunity, special education), and for Five Keys (Sheriff\'s Office adult-learner charter)',
    'geocode': 'where lat/lon came from', 'bell': 'SFUSD 2025-26 start/end times (K-8 schools have separate K-5 and 6-8 rows)',
  },
  'schools': schools,
  'totals': {
    'note': 'Counts of school records and students. The Waldorf affidavit is split into two campus records, so private records number one more than private affidavits.',
    'public': T['public'], 'charter': T['charter'], 'publicAndCharter': T['publicAndCharter'],
    'publicAndCharterTraditionalOnly': T['publicAndCharterTraditionalOnly'], 'publicTK': T['publicTK'],
    'private': T['private'], 'private2025_26AffidavitsOnly': T['private2025_26AffidavitsOnly'],
    'all': T['all'], 'byBand': T['byBand'], 'byBandExcludingNontraditional': T['byBandExcludingNontraditional'],
    'geocoded': T['geocoded'],
    'publicExcluded': {
      'notActiveInDirectory': core['dropped_public'],
      'noSchoolSite': core['public_no_dir'],
      'note': 'Five Keys Charter and The Academy - SF @McAteer reported 2025-26 Census Day enrollment but are Closed in the current directory, so they are excluded. "District Office" (257, all TK) and "Nonpublic, Nonsectarian Schools" (43) are accounting rows with no school site.',
    },
  },
  'bellTimes': {
    'source': 'sfusd-bell', 'period': '2025-26',
    'summary': {
      'elementary': 'Three tiers: 27 schools 7:50 AM-2:05 PM, 23 schools 8:40 AM-2:55 PM, 14 schools 9:30 AM-3:45 PM. Wednesday early release is 75 minutes earlier (12:50, 1:40 or 2:30 PM).',
      'k8': 'K-5 grades 9:30 AM-3:45 PM; 6-8 grades 9:30 AM-4:00 PM (all 8 K-8 schools). Wednesday release is 2:30 PM for K-5 and 2:15 PM for 6-8.',
      'middle': 'All 13 middle schools 9:30 AM-4:00 PM; Wednesday 2:15 PM.',
      'high': 'Comprehensive high schools start at 8:40 AM and end 3:35-3:50 PM (Asawa SOTA 3:35, Burton/Galileo/Lowell/Mission 3:40, Lincoln/McAteer/O\'Connell/Wallenberg/Washington 3:45, Marshall 3:47, Balboa/June Jordan/SF International 3:50). Wednesday early release is 1:15-2:45 PM. Downtown and Ida B. Wells (continuation) start at 9:30 AM; Independence starts at 10:20 AM.',
      'county': 'County schools (Civic Center Secondary, Hilltop, Youth Chance, CARE, McAuley) start at 9:20-9:30 AM and end 2:00-4:00 PM.',
    },
    'schoolsWithBellTimes': len(sfusd_bell),
    'note': 'Bell times are attached per school under schools[].bell. Charter and private schools are not covered by this source.',
  },
  'travel': {
    'sfusdK5_2019': {
      'source': 'sfcta-sap', 'what': 'Transportation mode share of SFUSD students (SFUSD survey), from School Access Plan Figures 7-8',
      'kindergarten_2019': {'anyCar': 0.527, 'anyBus': 0.161, 'walk': 0.274, 'bike': 0.025, 'other': 0.013},
      'grade5': {'anyCar': 0.560, 'anyBus': 0.164, 'walk': 0.259, 'bike': 0.007, 'other': 0.010},
      'note': '"Any bus" combines Muni and yellow school bus. Figure 8 (5th grade) carries no year label; it sits beside the 2019 kindergarten figure.',
    },
    'sfusdK5Distance_2017': {'source': 'sfcta-sap', 'lessThan1mi': 0.506, 'mi1to2': 0.215, 'mi2plus': 0.278,
                             'outsideHomeRegion': 0.44, 'k5LivingOver1mi': 'more than 11,000'},
    'sfusdYellowBus': {'source': 'sfcta-sap', 'generalEducationBuses': 25, 'schoolsServed': 46, 'studentsDaily': 2000,
                       'iepVehicles': 150, 'annualBudgetUSD': 30000000, 'operator': 'Zum (contract)', 'asOf': 'report May 2023'},
    'childTransportationSurvey_2016': {
      'source': 'sfcta-cts', 'respondents': 'more than 1,700 parents (SFUSD, private and other schools)',
      'table3': {
        'dropoffAtSchool': {'drivenFamilyOnly': 0.565, 'transitMuniBartLightRail': 0.140, 'carpoolOtherFamilies': 0.082, 'walk': 0.078, 'yellowOrOtherBus': 0.076, 'bike': 0.033, 'other': 0.022, 'scooterSkateboard': 0.003, 'taxiRideshare': 0.001, 'shuttleMultipleChildren': 0.001},
        'pickupAtBell': {'drivenFamilyOnly': 0.521, 'transitMuniBartLightRail': 0.267, 'carpoolOtherFamilies': 0.016, 'walk': 0.106, 'yellowOrOtherBus': 0.068, 'bike': 0.007, 'other': 0.008, 'scooterSkateboard': 0.003, 'taxiRideshare': 0.006, 'shuttleMultipleChildren': 0.000},
        'pickupFromAftercare': {'drivenFamilyOnly': 0.700, 'transitMuniBartLightRail': 0.182, 'carpoolOtherFamilies': 0.030, 'walk': 0.041, 'yellowOrOtherBus': 0.019, 'bike': 0.015, 'other': 0.008, 'scooterSkateboard': 0.000, 'taxiRideshare': 0.005, 'shuttleMultipleChildren': 0.000},
      },
      'otherFindings': ['About 20% of respondents have school commutes longer than four miles.', 'For 65% of parents, school is not on the way to work.',
                        'The report cites the SFUSD Student Transportation Survey (grades K, 5, 6, 9): about half of public elementary students are driven, about a quarter walk, about 10% take public transit and about 10% take yellow school buses; 52% of public elementary and middle school trips are made with only the student and the driver in the vehicle.'],
      'note': 'Respondents skew toward parents of younger children; the report labels the shares as K-5 school trips.',
    },
    'freeMuniYouth': 'All youth 18 and under ride Muni free (no application) since August 2021; see seniorsFares.youthPolicy.',
    'notFound': 'No SFUSD or SFMTA mode-share figure for middle or high school students (grades 6 and 9 are surveyed by SFUSD, but no published results were found). The sfsaferoutes.org commute-study page is gone (404 since 2022); only 2012-13 per-school tally PDFs remain in the Wayback Machine, and they were not used.',
  },
  'seniorsFares': {
    'freeMuniSeniorsAndDisabled': {
      'program': 'Free Muni for Seniors (65+) and People with Disabilities: SF residents with gross household income at or below 100% of Bay Area Median Income; Clipper card with an application; includes cable cars. Started 2015 (Controller memo).',
      'participantsFY24_25': 45379, 'annualCostFY24_25_USDm': 14.4, 'source': 'sfmta-board-2025-12',
      'seniorShareOfParticipants': 0.85, 'disabledShareOfParticipants': 0.15, 'shareSource': 'sfmta-asna-2024 ("since the program\'s inception in 2013, seniors have made up about 85% of the active participants")',
      'derivedSeniorParticipants': round(45379 * 0.85), 'derivedNote': 'Derived as 45,379 x 0.85; not a published figure.',
      'programExtendedTo': 'card expiry dates updated to 2028 on July 1, 2025 (SFMTA Free Muni for Seniors page)',
      'otherFigures': {'asna2024': '"Free Muni is critical for more than 100,000 people" (ASNA section on older adults and people with disabilities; the figure is not broken down and is much larger than the 45,379 FY24-25 participants)',
                       'controller2023': '275,199 Free Muni applications processed through May 2022 (all categories); 2022 forgone fare revenue estimate about $13.3M',
                       'cci2026': 'Free Muni (all groups) is estimated at over 16.5 million trips a year, over $41 million in free trips'},
    },
    'discountCards': {
      'clipperAccessSFResidents': {'value': 19694, 'asOf': '2023-12', 'source': 'sfmta-asna-2024', 'note': 'Active Clipper Access (formerly RTC) participants with SF residency, 29.6% of the Bay Area total. These are disability discount cards, not senior cards.'},
      'seniorClipperCards': {'value': None, 'historical': {'value': 'nearly 31,000 Senior Clipper cards issued', 'asOf': '2011-06', 'source': 'mtc-2011'},
                             'note': 'No current count of Senior Clipper cards held by SF residents was found in SFMTA or MTC publications.'},
    },
    'boardingShares': {
      'freeMuniClipperTags_2018_07_to_2023_02': {'source': 'sfmta-asna-2024', 'seniorFreeMuniTags': 53194844, 'disabledFreeMuniTags': 11671955,
                                                 'totalMuniClipperTags': 245820264, 'seniorShareOfAllClipperTags': 0.216, 'disabledShareOfAllClipperTags': 0.047},
      'freeVsDiscountedSeniorBoardings': None,
      'note': 'No published split of senior boardings into free (Free Muni pass) and paid discount fares was found. The ASNA tag table gives free-program tags as a share of all Muni Clipper tags only; senior discount-fare tags are not reported.',
    },
    'seniorFare': {
      'singleRideClipperOrMuniMobile': 1.40, 'singleRideCash': 1.50, 'monthlyPassDiscount': 43.00, 'cableCarSeniorOffPeak': 4.00,
      'effective': '2025-07-01 (FY25-26); still listed as current on sfmta.com on 2026-10-04', 'history': {'FY24': 1.25, 'FY24-25 (from 2025-01-01)': 1.35, 'FY25-26 (from 2025-07-01)': 1.40},
      'confirmed': 'Yes: $1.40 on Clipper/MuniMobile, $1.50 cash. Clipper START single ride is also $1.40.',
      'pending': 'SFMTA proposed (spring 2026, FY26-27/FY27-28 budget) removing the Clipper discount, with Year-1 fare changes taking effect January 4, 2027. Adoption is not confirmed in the fetched pages. SFMTA said it recommends keeping all free and reduced-fare programs.',
      'source': 'sfmta-fares; sfmta-fare-proposal-fy27',
    },
    'youthPolicy': {
      'policy': 'Free Muni for All Youth: everyone 18 and under (i.e. under 19) rides all regular Muni service free, regardless of income or residency, with no application, card or proof of payment. Cable cars are excepted (free with a youth Clipper/cable-car pass; free for ages 4 and under). Ages 19-22 in SFUSD English Learner or Special Education programs are also eligible.',
      'universalSince': '2021-08 (Controller memo: "In August 2021 SFMTA expanded Free Muni to all youth (regardless of income and residency)")',
      'originalProgram': '2013-03-01 pilot for low/moderate-income SF resident youth 5-17; 18-year-olds added in 2014',
      'source': 'sfmta-free-muni-pages; sf-controller-2023; cci-2026',
    },
  },
  'notes': [
    'All enrollment numbers come from the CDE files listed in sources. Nothing was estimated except derivedSeniorParticipants.',
    f"Public + charter total ({T['publicAndCharter']['schools']} schools, {T['publicAndCharter']['students']:,} students) includes TK ({T['publicTK']:,}), SF County Office of Education programs, and Five Keys Independence HS (2,734, mostly adult learners in Sheriff programs). Excluding the nontraditional schools leaves {T['publicAndCharterTraditionalOnly']['schools']} schools and {T['publicAndCharterTraditionalOnly']['students']:,} students.",
    'Private: the 2025-26 affidavit file lists 99 SF schools (20,085 students). Seventeen SF schools filed in 2024-25 but not 2025-26 (as of the 9/25/2026 revision), including St. Ignatius (1,555), Archbishop Riordan (1,192), SF University HS (488) and Hamlin (437). They are carried forward with 2024-25 enrollment and year = "2024-25", which adds 4,232 students. Some of them, mostly microschools, may have closed.',
    'Private affidavits are self-reported, and schools with fewer than six students are not published. Well-known SF schools absent from all three years checked (2023-24 to 2025-26) include Mercy High School SF, Star of the Sea (now Stella Maris Academy, which is included), Lisa Kampner Hebrew Academy and Corpus Christi, so they are not in this file.',
    f"Geocoding: {T['geocoded']['withCoords']} of {len(S)} records have coordinates." + ' All public and charter schools use CDE directory coordinates. Of the private records, 77 matched OSM and 40 did not (2,302 students, mostly microschools, online programs and small schools; the largest are Aloha Micro Academy 480, Drew School 280, the three Stratford campuses 329 combined, Proof School 129 and Lavenia Rochelle Academy 125). Unmatched records keep lat/lon null and geocode = "unmatched". The public directory was checked as a fallback but contains no private schools.',
    'Private-school grade bands use K-5 / 6-8 / 9-12 from the affidavit grade columns (no TK or preschool). Public k5 includes TK.',
    'cde.ca.gov served a Radware bot-check (CAPTCHA) after the first few requests. It was not bypassed; the 2024-25 and 2023-24 private files came from Wayback captures of the same CDE URLs.',
    'Raw downloads are in data/beta3/raw/schools/ (seniors/ subfolder for fare documents).',
  ],
}
json.dump(out, open(OUT, 'w'), indent=1, ensure_ascii=False)
json.load(open(OUT))
print('ok', len(schools))
