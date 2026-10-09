# Validation standards and benchmarks

Machine-readable version: `validation-standards.json`. Source PDFs are in `data/beta3/raw/standards/` (gitignored). Every value below was read from a fetched document. Every guidance source here says its thresholds are guidelines, not pass/fail standards.

## Transit assignment targets

| Measure | Target | Source |
|---|---|---|
| Boardings by mode (light rail, bus, ...) | ±10% | CTC RTP Guidelines 2017 p.49; 2024 p.55 |
| Boardings by route group (local, express, ...) | ±20% | CTC 2017 p.49; 2024 p.55 |
| Regional boardings | ±9% acceptable, ±3% preferable | FHWA 2010 Table 9.9 (Florida) |
| Transit screenlines | ±20% / ±10% | FHWA 2010 Table 9.9 |
| Line, under 1k riders/day | ±150% / ±100% | FHWA 2010 Table 9.9 |
| Line, 1-2k riders/day | ±100% / ±65% | FHWA 2010 Table 9.9 |
| Line, 2-5k riders/day | ±65% / ±35% | FHWA 2010 Table 9.9 |
| Line, 5-10k riders/day | ±35% / ±25% | FHWA 2010 Table 9.9 |
| Line, 10-20k riders/day | ±25% / ±20% | FHWA 2010 Table 9.9 |
| Line, over 20k riders/day | ±20% / ±15% | FHWA 2010 Table 9.9 |
| Corridor or stop groups | <15% for 95% of groups | UK TAG M3.2 Tables 4-5 |
| Individual services or stops | <25% for 95% (not applied below 150 passengers/hour) | UK TAG M3.2 Table 5 |
| Annual patronage | under 5% for services with significant patronage | TAG M3.2 §4.3.17 |
| Boardings per linked trip | typically 1.2-1.6 (higher with grid buses and rail) | FHWA 2010 §9.2.5 |

## Highway assignment targets

- **CTC (California):** at least 75% of links within the Caltrans deviation allowance; correlation coefficient at least 0.88; %RMSE below 40%.
- **Caltrans 1992:** volume/count error by class: freeways under 7%, principal arterials under 10%, minor arterials under 15%, collectors under 25%. 75% of freeway and principal arterial links, and all screenlines, within the maximum desirable deviation.
- **Florida FSUTMS 2008 %RMSE by daily volume** (acceptable / preferable, as reprinted in Tennessee 2016 Table 10):

  | Daily volume | Acceptable | Preferable |
  |---|---|---|
  | under 5k | 100% | 45% |
  | 5-10k | 45% | 35% |
  | 10-15k | 35% | 27% |
  | 15-20k | 30% | 25% |
  | 20-30k | 27% | 15% |
  | 30-50k | 25% | 15% |
  | 50-60k | 20% | 10% |
  | 60k and up | 19% | 10% |
  | Areawide | 45% | 35% |

  FHWA 2010 Figure 9.8 shows these curves as a chart only.
- **Screenlines:** Michigan 5% and cutlines 10% (FHWA 2010 p.9-18). UK TAG M3.1: within 5% for 95% of screenlines.
- **GEH (UK TAG M3.1 Table 2):** GEH < 5 for more than 85% of hourly link flows. Alternatively, more than 85% of flows within 100 veh/h (flows under 700), 15% (700-2,700) or 400 veh/h (over 2,700). FHWA 2010 does not mention GEH.

## Reasonableness ranges (FHWA 2010 unless noted)

- **Trip distribution:** average trip length within 5% of observed; coincidence ratio at least 70%; intrazonal share within 3 points of observed.
- **Trip rates, 2001 NHTS, metros over 3M** (all modes, per household): HBW 1.54, HBNW 5.84, NHB 3.27, total 10.65. Zero-auto households: total 5.60.
- **Trip rates, NCHRP 716 (2009 NHTS):** HBW 1.4, HBNW 5.6 (urban areas over 500k), NHB 3.0.
- **Mean transit trip time, 1M+ areas with rail (NCHRP 716 Table C.10):** HBW 55 min, NHB 42 min, all trips 48 min.
- **Mode choice parameters:** OVT/IVT about 2-3. FTA guidance: HBW IVT coefficient -0.02 to -0.03 per minute; HBO IVT 0.1-0.5 × HBW; OVT 2-3 × IVT. Nest coefficients must be between 0 and 1 and decrease down the tree.
- **Wait/IVT in MPOs over 1M (NCHRP 716 Table 4.30):** mean 2.1 (range 1.5-2.6).

## Elasticities (sensitivity checks)

- **Bus fare:** about -0.40 (APTA, ±0.18 SD, range -0.12 to -0.85); Simpson-Curtin is equivalent to -0.39 to -0.41. Heavy rail: -0.17 to -0.18 short-run. Off-peak riders are about 2× as sensitive as peak riders. Larger cities are less elastic (-0.24 for central cities over 1M). Source: TCRP 95 Ch. 12.
- **Service frequency:** about +0.5 on average; observed values cluster around +0.3 (central-city systems) and +1.0 (suburban). Headway elasticity by starting headway: under 10 min -0.22, 10-50 min -0.46, over 50 min -0.58. Source: TCRP 95 Ch. 9.
- **Service expansion:** +0.6 to +1.0 (average +0.7 to +0.8). Source: TCRP 95 Ch. 10.
- **UK TAG M2.1 realism ranges (long-run):** PT fare -0.2 to -0.9; bus -0.35 to -0.9; London Underground -0.2 to -0.6; car fuel cost -0.15 to -0.35; car journey time no stronger than -0.75.
- **FHWA 2010:** level-of-service elasticities are "usually well under 1.0" in absolute value.

## San Francisco and Bay Area benchmarks (for like-for-like comparison)

- **MTC Travel Model One, 2005, Muni boardings by route vs the SFMTA on-board survey:** %RMSE 66% overall ("acceptable"). By submode: local 68%, limited 77%, Metro 38%, cable car 75%. Total Muni boardings -26%.
- **TM1 operator totals:**
  - 2000: Muni bus -17%, Muni Metro -25%, BART -4%.
  - 2005: Muni bus -21%, Muni Metro -17%, BART -7%.
- **TM1.5.2, 2015:** regional total -1%; Muni bus -4%; Muni light rail -6%; BART +5%; Caltrain +5%.
- **TM1.6.1, 2023 freeways:** daily R² 0.96 and %RMSE 24%. MTC reads FHWA as "about 20% reasonable for high-volume links, 40% for low-volume links".
- **SF-CHAMP 3 (year-2000 counts, 2007 report):** 79 Muni routes, %RMSE 38%, r = 0.94, 43% within ±25% (computed from its Table 68); BART at 8 city stations %RMSE 16%. Muni total within 1%.
- **TM1 v0.3, 2010:** 74 Muni routes, R² 0.79 (published), %RMSE 52% (computed); Muni total -24%, BART -2%.
- **Other U.S. models and FTA STOPS:** see `benchmarks.json` (route-level %RMSE, r or R², share within ±25%, rail stations, with sources and what each compared).
- **SF-CHAMP original (1998 base):** all modes within 5% of observed boardings (8% over by route group). Screenline target ±10%, met by 8 of 10.
- **TAMDM (built on Travel Model Two), 2015:** BART -3%, Caltrain -34%.

## Not found

- The original FDOT report; FDOT values come from the Tennessee 2016 reprint.
- Numeric values for the Ohio and Oregon %RMSE curves (chart only).
- Caltrans 2014 guidelines. Caltrans says its last guidance is from November 1992.
- Validation results for SF-CHAMP 5, 6, and 7. SFCTA publishes scripts only, not results; SF-CHAMP 3 and 4.1 results were found in EIR/EIS appendices (`benchmarks.json`).
- A Travel Model Two validation report (still none as of 2026-10-05).
- Row-level values in TCRP Table 12-3 (including BART).
- A transit in-vehicle-time elasticity.

Details are in `notFound` in the JSON.
