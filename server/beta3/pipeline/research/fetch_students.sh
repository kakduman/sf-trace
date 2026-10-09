#!/bin/sh
# Downloads behind reference/student-travel.json (students.py): school and college travel in San
# Francisco. Files go to $BETA3_RAW/students (default data/beta3/raw/students).
# Run: sh server/beta3/pipeline/research/fetch_students.sh
set -e
RAW=${BETA3_RAW:-$(cd "$(dirname "$0")/../../../.." && pwd)/data/beta3/raw}
OUT=$RAW/students
mkdir -p "$OUT"
cd "$OUT"
UA="interchange-beta3 (transit model research)"
get() { curl -sSL -A "$UA" -o "$1" "$2"; echo "$1"; }
# SFCTA School Access Plan (May 2023): SFUSD K-5 home-to-school distance (2017) and mode (2019), yellow buses
get sfcta_school_access_plan_2023.pdf "https://web.archive.org/web/20240916150655id_/https://www.sfcta.org/sites/default/files/2024-07/SF_School_Access_Plan_Report_2023-05-04_FINAL.pdf"
# Mentzer (2023), Stanford PhD thesis on SFUSD student assignment (average distance to assigned school)
get mentzer_2023_sfusd_assignment_thesis.pdf "https://stacks.stanford.edu/file/druid:ct364nd4124/mentzer_thesis_icme-augmented.pdf"
# San Francisco State University transportation surveys (2018: residence by county, arrival mode; 2023: modes, schedules)
get sfsu_transportation_survey_2018.pdf "https://sustain.sfsu.edu/sites/default/files/documents/2018_TransportationMonitoring_Final_with_appendix.pdf"
get sfsu_transportation_survey_2023.pdf "https://sustain.sfsu.edu/sites/default/files/documents/2023TransportationSurveyResultsReport.pdf"
get sfsu_tdm_plan_update_2025.pdf "https://sustain.sfsu.edu/sites/default/files/documents/TDMPlanUpdate2025.pdf"
# City College of San Francisco fact sheets: residence of credit students; headcount
get ccsf_factsheet-student-residence.pdf "https://www.ccsf.edu/sites/default/files/2023/document/factsheet-student-residence.pdf"
get ccsf_factsheet-student-demographics.pdf "https://www.ccsf.edu/sites/default/files/2024/document/factsheet-student-demographics.pdf"
# IPEDS: institutions (HD2024) and fall 2023 enrollment by distance-education status (EF2023A_DIST)
for f in HD2024 EF2023A_DIST; do get ipeds_$f.zip "https://nces.ed.gov/ipeds/datacenter/data/$f.zip"; unzip -oq ipeds_$f.zip; done
# Travel Model One's school location choice as ported to ActivitySim (prototype_mtc): distance terms by school level
for f in school_location_coefficients.csv school_location.csv destination_choice_size_terms.csv constants.yaml; do
  get asim_$f "https://raw.githubusercontent.com/ActivitySim/activitysim/main/activitysim/examples/prototype_mtc/configs/$f"
done
