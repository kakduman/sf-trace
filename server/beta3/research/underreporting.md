# Survey underreporting by segment: does it explain Muni's misses near home?

October 2026. Question: household travel surveys miss trips, and the literature says some groups miss
more than others. Does a published correction by segment (income, language, car ownership, person
type) for BATS 2023 move Muni's route pattern, where the model is short on the T, 14, 14R, 49, and 8?
Answer: no published factor by segment applies to BATS 2023, and stress tests well beyond the
published range leave the route pattern where it was. Nothing is changed in the model.

## What BATS 2023 is

MTC and RSG, *2023 Bay Area Travel Study Final Report* (Sept. 10, 2025),
https://mtc.ca.gov/sites/default/files/documents/2026-02/BATS2023ConsultantFinalReport.pdf

- Table 10 (pp. 36–37): 357,167 of 365,831 unweighted trips (97.6%) came from the rMove smartphone
  app, which records trips by GPS for up to seven days. Browser diaries gave 7,437 and the call
  center 1,227.
- §5.3 (p. 29): materials and the instrument in English, Spanish, Simplified and Traditional
  Chinese, and Vietnamese, with interpreters for other languages.
- §7.0 (p. 32): weights are raked to 2023 ACS PUMS controls (with imputed income and race), then
  "adjusting the trip-level weights by data collection method (smartphone vs. online vs. call
  center) to account for underreporting biases." The factors are in a weighting memo on MTC's Box,
  which needs a login.
- SFCTA's review of an interim delivery (github.com/sfcta/travel_diary_survey_scripts,
  2022/99-review/notebooks/weights-trip_day.ipynb) shows the form: rMove trips at a factor of 1,
  the others at 1 to 2, adding about 6.9% to weighted trips.

So BATS already carries the standard correction, and it is by diary mode, not by income or language.

## The correction in RSG's other surveys

- NYC DOT, *2024 Citywide Mobility Survey User Guide* (RSG), §3.3 and Table 7, pp. 11–13
  (https://www.nyc.gov/html/dot/downloads/pdf/2024-cms-user-guide.pdf): smartphone trip rates are
  "frequently 15–20% higher" than online diaries. Factors from a Poisson model with a platform
  dummy, capped at 2.0: 2.00 on home-based trips for online and call-center respondents, 1.00 for
  rMove. Income and age enter the model as controls, not as interactions with the platform.
- Utah 2023 HTS Weighting Memo v2 (RSG, July 2025), Tables 23–28, pp. 56–59
  (https://unifiedplan.org/2023-utah-household-travel-survey/documents/Utah2023HTS_WeightingMemo_v2_072825.pdf):
  factors by person type and diary mode (home-based other, browser: full-time workers 2.00,
  non-working adults 1.75, retirees 1.71); no income or race terms.
- PSRC 2015 HTS report (RSG), Table 33, pp. 60–66 (https://psrc.org/media/6333): 372 of 1,604
  rMove days (23%) had at least one trip the respondent said the app missed.
- PSRC 2023 final report, Tables 12 and 14: low-income and Black participants used the web and
  call-center diaries more often (call center: 29.4% under $25,000, against 5.0% of rMove users).
  That is how income enters the correction, through diary mode, and in BATS the non-app diaries are
  2.4% of trips.

## GPS against recall diaries, by segment

These compare recall diaries (CATI or paper) with GPS. They are not a smartphone diary.

- Bricka and Bhat, TRB 2006 paper 06-0459, Table 1: missed trips of 10% (Kansas City 2004) to 81%
  (Laredo 2002, which the authors call not comparable), with in-vehicle GPS. They count vehicle trips
  only, so no transit or walking. Kansas City's model of missed trips kept education, diary use,
  trip chaining, and age; income dropped out.
- Bricka, Sen, Paleti, and Bhat, "An Analysis of the Factors Influencing Differences in
  Survey-Reported and GPS-Recorded Trips" (working paper, July 27, 2010,
  http://caee.webhost.utexas.edu/prof/bhat/ABSTRACTS/gpssurveytrips_unabridged_27July2010.pdf).
  Indianapolis 2009, 265 persons with wearable GPS: 1,533 diary trips against 1,555 GPS trips. On
  non-work trips (Table 6), using transit lowered the expected diary-minus-GPS difference by 28.4%,
  and household income under $40,000 by 2.9%. The sample is small and the diary is CATI.
- FHWA *TMIP Connection*, Spring 2004 (California 2001): 71% of unreported GPS trips were under
  10 minutes.
- No source found gives underreporting by language, limited English, or immigrant status.

## The onboard survey against BATS

MTC, *Snapshot Survey 2023–24 Summary Report*
(https://mtc.ca.gov/sites/default/files/documents/2025-08/MTC_Snapshot_Survey_Summary_Report08-28-2024.pdf):
998,451 weekday riders (p. 7), 44% in households under $50,000 (p. 25). BATS's Table 37 transit
shares by income times its weighted trips give about 438,800 transit trips under $50,000, against
about 439,300 in the Snapshot. This is our arithmetic, regional, and the definitions differ
(boardings against trips, all riders against residents), but it does not show low-income transit
riders missing from BATS.

## Stress tests

`params.ts` UNDERREPORT multiplies residents' home-based shopping, other, and social tours by car
segment and income class, and by limited-English share (ACS 2020–24 C16002 by block group,
`pipeline/language.ts`). It is 1 everywhere in the model. Each test is a two-pass `experiment.ts`
run on the calibrated bundle; route counts are not fitted, and the Muni total is scaled to the
counted 515.6k so only the pattern is compared. Results are in `reference/underreport-results.json`.

Limited-English households are 8.6% of the Mission's and 10.9% of the city's (C16002); households
under $100,000 are 37.1% of the Mission's and 38.8% of the city's (the bundle's ACS bands). A
correction by those segments cannot lift the Mission more than the city.

| Test | Scaled %RMSE | r | Within ±25% | T | 14 | 14R | 49 | 8 | BART exits r |
|---|---|---|---|---|---|---|---|---|---|
| Model as calibrated | 38.0 | 0.923 | 51% | 11.4k | 14.7k | 11.9k | 30.4k | 14.2k | 0.851 |
| Under $100,000 ×1.25 | 38.4 | 0.921 | 47% | 11.3k | 14.8k | 11.8k | 30.7k | 14.4k | 0.850 |
| Limited-English ×2 | 38.2 | 0.922 | 47% | 11.4k | 15.0k | 11.9k | 30.6k | 14.8k | 0.849 |
| All at once, beyond any source | 39.9 | 0.915 | 51% | 11.0k | 15.3k | 11.6k | 31.7k | 15.3k | 0.845 |
| Counted | | | | 25.0k | 22.2k | 22.7k | 35.0k | 18.4k | |

Routes are scaled to the counted total. "All at once": under $100,000 ×1.5, households without a car
another ×1.3, limited-English ×2. Every test makes the pattern worse. The extra trips land
everywhere such households live (Downtown, SoMa, the Western Addition, the Excelsior), and the T stays
at 11k of 25k.

The same runs give Muni's boardings by stop district as shares. The model's Mission share matches
SFMTA's 2006–07 counts (26.4k against 27.7k at the model's total); the Southwest (24.1k against
31.5k) and Bayview–Hunters Point (9.2k against 11.8k) are short, and Mission Bay–Potrero (15.9k
against 8.3k, which has grown since 2006) and the Western Addition (47.5k against 39.4k) are over.
Across all of Muni, then, the Mission's share of boardings is right; the Mission Street routes'
shortfall points to which routes its riders take more than to how many riders there are.
