# Beta3 model parameters: sources

`params.json` holds the values. Each block names its source id (see `sources` in the JSON). Raw downloads are in `data/beta3/raw/params/`, which is gitignored. Everything was fetched on 2026-10-04. A value marked `derived` was computed here from a fetched source; nothing was made up.

## Units to watch
- **MTC TM1/TM2 money is in year-2000 cents.** `c_cost = 0.6*c_ivt/VOT`, with VOT in 2000 $/hour, so `c_cost` is utility per 2000-cent. To convert to 2025 $, use MTC's CPI factor of 1.98 (`inflation_cpi_2000_base`). The table has no 2026 factor.
- Transit skim times are minutes x100. The UECs divide them by 100.
- SF-CHAMP tolls are in 1989 cents. Fares, tolls and NTD costs are in nominal dollars for the year shown.

## 1. Mode choice (MTC Travel Model One, current master)
- `ModeChoice.xls` (tour level) and `TripModeChoice.xls`, for 10 purposes: Work, University, School, Escort, Shopping, EatOut, OthMaint, Social, OthDiscr, WorkBased.
  - All coefficients (IVT, wait, walk, transfer, drive access, bike/walk, topology, density) are resolved to numbers.
  - The constants come with their filters: auto sufficiency, joint tours, submode constants, and the to/within/from San Francisco and CBD transit dummies.
- Tour-level Work IVT is -0.0134/min. Other multiples of c_ivt:
  - Initial wait: 2.0 for the first 10 minutes, 1.0 after that.
  - Transfer wait, and walk access/egress/auxiliary time: 2.0.
  - Transfer penalty: 30 (walk access) or 40 (drive access).
  - Rail IVT factors: LRT 0.9, ferry 0.8, BART 0.8, Caltrain 0.7.
- Non-work IVT is -0.0175; school/university -0.0224. Trip-level coefficients are steeper (Work -0.022).
- Nesting: auto submodes 0.35, transit and ride-hail 0.5, upper level 0.72.
- VOT: lognormal, with means of $6.01 / 8.81 / 10.44 / 12.86 (2000 $/hr) for household income under 30k / 30-60k / 60-100k / 100k+ (2000 $). sigma = 0.87. Persons under 18 get 0.667 of the household VOT.
- **Caveat:** TM1 is tour-based (CT-RAMP).
  - Tour-level utilities sum both directions of LOS. The trip model is conditional on tour mode.
  - For a trip-based model, take the time/cost *ratios* and the trip-level coefficients, then recalibrate the constants.
  - The "transit hesitance" constants (Work 55, Rail 108 IVT-min) are 2023 post-COVID calibration adjustments.
- **TM2 (TM2.2):** tour mode choice coefficients, the TAP path-utility weights (`BestTransitPathUtility.xls`), and the tm2py 2023 transit assignment config.

## 2. Transit path weights and crowding
| Source | Wait weights (initial / transfer) | Boarding penalty | Other |
|---|---|---|---|
| TM1 skims | 2.0 / 2.0 | 0/20/45/50/60 by boarding number | walk/drive x2; non-key modes x1.5 |
| TM1 assignment | 2.8 / 2.8 | same as skims | — |
| tm2py 2023 | 1.5 / 3.5 | LOC 4, LRT 4.5, HVY 4 min | walk x2; IVT factors LRT/HVY 0.9, ferry/CR 0.7 |

- **Crowding function** (tm2py, Emme congested assignment): seated weight 1.0 to 1.4 (power 2.2), standing weight 1.4 to 1.6 (power 3.4), as a function of V/C.
- **SF-CHAMP stated preference (2002):** going from high to low crowding is worth 5 minutes of wait for commuters and 9 minutes for non-commuters.
- TM1 itself has no crowding.

## 3. Trip generation
- **NHTS 2017, SF-Oakland CBSA, weekdays.** Computed here from the public microdata:
  - Trips per person, period shares, hourly shares, from-home shares and mean lengths for HBW, school (K-12 and university), HBShop, HBO, HBSocRec and NHB.
  - Example: 3.29 trips/person/weekday; HBW 0.545 with 38.7% of trips in AM.
- **NHTS 2022** (US MSAs of 1M+ with rail) for comparison.
- **BATS 2023** (MTC final report):
  - Regional unlinked trip rate is 4.04 (3.96 in the report summary). Rates by destination purpose are included.
  - For SF residents: purpose shares and mode shares (walk 44%, transit 12.2%, car 37.8%).
- **SF-CHAMP visitor model:** time-of-day split and mode choice parameters.

## 4. Capacities
- **SFMTA SRTP FY19-30** (planning / crowding capacity):

  | Vehicle | Planning | Crowding |
  |---|---|---|
  | LRV, per car | 139 | 168 |
  | Streetcar | 69 | 82 |
  | Powell cable car | 52 | 55 |
  | California cable car | 60 | 63 |
  | 40' bus | 44 | 51 |
  | 60' bus | 69 | 81 |

- **MTC `transitSeatCap.csv`** (total / seats):

  | Vehicle | Total | Seats |
  |---|---|---|
  | 40' bus | 63 | 39 |
  | 60' bus | 94 | 56 |
  | LRV, per car | 119 | 60 |
  | Cable car | 63 | 29 |
  | 10-car BART | 1110 | 550 |
  | Caltrain electric (PCEP) | 1502 | 681 |

- **Caltrain KISS:** 675 seats per 7-car set.
- **BART legacy cars:** 56-60 seats.

## 5. Fares and costs (2026, nominal $)
- **Muni:** $2.85 Clipper, $3.00 cash; M pass $86; cable car $9; 120-minute transfer window.
- **BART** (GTFS, Jan 2026): minimum $2.55, which covers every trip within SF. EMBR-12TH costs $4.50 and EMBR-SFIA $11.80.
- **Caltrain:** $4.00 plus $2.25 per extra zone, up to $15.25.
- **Bay Bridge:** $8.50, or $4.25 for carpools in peak hours.
- **Golden Gate Bridge:** $10.25 FasTrak (from 2026-07-01).
- **Parking:**
  - SF meters $0.50-8/hr.
  - TM1 2023 SF parking costs by area type are in 2000 cents/hr.
- **Auto operating cost:** TM1 2023 uses 15.44 2000-cents/mile.
- **Taxi/TNC:** TM1 parameters, plus 2022 SF taxi meter rates.
- **NTD cost per vehicle revenue hour, 2024:**
  - Muni: bus $301.60, trolleybus $281.30, light rail $412.10 (per car-hour), streetcar $631.19, cable car $871.27.
  - BART $374.50; Caltrain $994.09.
  - NTD fare revenue per unlinked Muni trip is about $0.60. Treat this with caution: SFMTA appears to allocate fare revenue across modes.

## Not found
See `not_found` in the JSON:
- BATS 2023 breakdowns by purpose and time of day: the dashboard is behind a captcha.
- SF-CHAMP mode choice coefficients and transit path weights: only on SFCTA's intranet.
- An official BART per-mile fare formula.
- Seat counts for specific SFMTA vehicle models and for BART D/E cars.
