# Mode choice and tour specification: audit against TM1, TM2, SF-CHAMP, and ActivitySim

October 2026. Audited: `shared/beta3/demand.ts` (`leg`, `choose`, `nlogit`, person types, income
classes, tours and stops), `shared/beta3/params.ts`, `server/beta3/pipeline/calibrate.ts`.

## Sources read

| Source | File / location | Used for |
|---|---|---|
| MTC Travel Model One, tour mode choice | `BayAreaMetro/travel-model-one` `model-files/model/ModeChoice.xls` (all ten purpose sheets) | tour coefficients, nest structure, terminal, parking, transfers, density |
| TM1 trip mode choice | `model-files/model/TripModeChoice.xls` | trip coefficients, origin density, terminal ends |
| TM1 value of time | `core/projects/mtc/src/java/com/pb/mtc/ctramp/MtcHouseholdDataManager.java` (`setDistributedValuesOfTime`); `model-files/runtime/mtcTourBased.properties` | VOT distribution, children's VOT |
| TM1 free parking | `model-files/model/FreeParkingEligibility.xls` | share of SF commuters with free parking |
| TM1 2023 land use | `tm1_TAZ1454_2023_LandUse.csv` (RESACRE, CIACRE, PRKCST, OPRKCST, TERMINAL) | density index form, parking and terminal inputs |
| MTC Travel Model Two | `BayAreaMetro/travel-model-two` `uec/TourModeChoice.xls` | estimated tour coefficients, nesting, SR cost shares, age terms |
| ActivitySim prototype_mtc | `activitysim/examples/prototype_mtc/configs/tour_mode_choice*.{yaml,csv}`, `trip_mode_choice*`, `annotate_landuse.csv`, `settings.yaml` | the TM1 port: nests, constants, VOT draw (μ multiplier 0.684, σ 0.85) |
| SF-CHAMP | SFCTA/Cambridge Systematics, *San Francisco Travel Demand Forecasting Model Development* (2002), ch. 4 | tour vs trip mode choice, round-trip LOS |
| BATS 2023 | MTC dashboard extract, `server/beta3/reference/sf-mode-by-area.json` (`mode_label`, "2023 \| Under 18") | youth mode shares; drive-to-transit share |
| SFUSD / SFCTA | *San Francisco School Access Plan* (2023), figs. 7–8; *Child Transportation Survey* (2016) | cross-check on school mode shares |

## Findings

Each finding lists what the model did, what the sources do, the likely effect, and what was done.
"Fixed" items are on branch `beta3-modechoice`.

### 1. Home-based tours used trip coefficients on the average of the two legs (fixed)

- **Model:** `choose()` took 0.5 × (outbound + return) utilities with TM1's *trip* coefficients
  (work −0.022, school/university −0.0271, other −0.0279 a minute).
- **TM1:** the tour mode, which fixes auto vs transit vs walk for the whole tour, is chosen by
  `ModeChoice.xls`, whose utilities *sum* the two legs (`c_ivt*(SOV_TIME[out]+SOV_TIME[in])`) with
  *tour* coefficients: work −0.0134, school and university −0.0224, the six non-mandatory purposes
  −0.0175, at-work −0.0188. The trip coefficients are only used for trips within a tour after its mode
  is chosen, mostly among transit submodes and walk. SF-CHAMP's tour models likewise "include the
  round-trip travel (both half-tours) characteristics" (2002 report, ch. 4). TM2 (estimated) uses
  −0.016 (work) per leg on the same summed form.
- **Effect:** per round-trip minute the model used −0.011 (work), −0.0140 (non-work), −0.0136
  (school), against TM1's −0.0134, −0.0175, −0.0224: tours were 18%, 20%, and 40% less sensitive to
  time and cost than TM1 says. This also halved the transfer term: 15 × IVT on the averaged leg is
  7.5 × −0.022 = −0.165 a transfer, against TM1's 30 × −0.0134 = −0.40 per transfer per leg.
- **Fix:** `TOUR_COEFFS` (params.ts) for work, school, univ, shop, other, social; `choose()` sums the
  legs for these. The calibrated constants (segment constants, applied per leg in `leg()`) are added at
  half weight on each leg so a tour counts each constant once; constants added in `choose()` (income,
  neighborhood, county, youth) are once a tour already. The tour form also brings TM1's tour details: walk threshold 1.5 miles (30 min) a leg
  instead of the trip model's 1 mile; transfers 30 × IVT; destination density once a tour and no
  origin density term (the tour sheets have none). Trip-level choices (trips not from home, hotel
  visitors, air travelers, regional visitors) keep `COEFFS`. Consumer-surplus logsums are divided by
  two for tours so benefits stay in minutes per trip (`lsMinutes`).

### 2. One value of time per income class; TM1 draws a distribution (fixed)

- **Model:** cost coefficient 60 · c_ivt / VOT with VOT at TM1's class *mean* (2000 $ 6.01, 8.81,
  10.44, 12.86 × 1.98), harmonic-averaged over a zone's bands.
- **TM1:** each household draws VOT from a lognormal, μ = ln(0.684 × mean), σ = 0.87, truncated to
  $1–50 (2000 $); persons under 18 get 0.667 of it (`MtcHouseholdDataManager.java`). ActivitySim's
  port uses the same (σ 0.85).
- **Effect:** utility is linear in 1/VOT. For that lognormal E[1/VOT] ≈ 2.0 / mean (computed with the
  truncation: 1.96–2.03 by class), so one value at the mean made the population about half as
  sensitive to fares, parking, tolls, and running cost as TM1's. This is consistent with the model's
  low fare elasticity (−0.21, TCRP 95 central −0.4) and car-cost elasticity (−0.15, at the bottom of
  TAG's −0.15 to −0.35).
- **Fix:** `mixLogit()` in demand.ts: each class's shares are the mixture of nested logits at three
  values of time (Gauss–Hermite points z = 0, ±√3, weights 2/3, 1/6, 1/6), which integrate E[1/VOT]
  exactly; the logsum is the weighted mean. Youth use 0.667 × VOT. In-commuters, visitors, and air
  travelers get the same spread around their values.

### 3. Shared-ride cost sharing (fixed)

- **Model:** all of shared ride's money (running cost, parking, tolls) ÷ 2.0, labelled "TM1".
- **TM1:** only parking and bridge tolls are divided (1.75 for SR2, 2.5 for SR3+); the running cost is
  not (the household's car either way). TM2 divides by 1.11 and 1.25.
- **Effect:** carpool slightly too cheap against driving alone; shifts within the auto nest only, and
  the constants absorb the level.
- **Fix:** `oc[1] = run + (parking + toll) / SR_COST_SHARE`, with the divisor the harmonic mix of
  TM1's two for a 2.3-person average carpool (77% two riders): 1.88.

### 4. Terminal time weighted 1.5 and counted at home (fixed)

- **Model:** `time = at + 1.5 × (τ_o + τ_d)` on each leg: both ends, weight 1.5 (no source).
- **TM1:** terminal minutes are weighted at `c_walkTimeShort` (2 × IVT). Tours count the destination
  only (`2*terminalTime`, the destination TAZ's); trips count both ends but not home
  (`originTerminalTime = 0` on the first outbound trip, `destTerminalTime = 0` on the last inbound).
- **Effect:** residents of dense areas (area types 0–1) paid ~7.5 IVT-minutes a leg for parking at
  home that TM1 doesn't charge; total terminal penalty to downtown was similar, so mainly a spatial
  shift of auto disutility from destination to origin.
- **Fix:** `Coeffs.terminal = 2 × ivt`; tours count the tour destination's terminal time each leg;
  trip-level choices count both ends.

### 5. Origin density applied to commutes and school (resolved by finding 1)

- **Model:** TM1's trip origin-density term (−0.6 × IVT × index, capped at 15 minutes) on every
  purpose.
- **TM1:** `originDensityApplied` is 0 on the Work, University, and School trip sheets, and the tour
  sheets have no origin term at all. (TM1's own cell reads `max(c·index, c_max)` with both positive,
  which is a floor rather than the cap the label describes; the model's `min` follows the label.
  ActivitySim's sign-flipped port saturates at index 1.)
- **Fix:** tours now have no origin term; the trip-level choices (all non-mandatory) keep the capped
  term, as TM1's trip model applies it to those purposes.

### 6. Persons under 18 had no mode constants of their own (fixed)

- **Model:** school tours and youth non-work tours used the adults' non-work constants. Base run:
  school trips 47% shared ride, 13% transit, 36% walk, 3% bike.
- **Data:** BATS 2023, SF residents under 18: 51% shared ride (plus 5% driving, 2% ride-hail, 1% school
  bus), 28% walk, 10% transit, 3% bike. SFUSD's 2019 kindergarten and 5th-grade counts: 53–56% by car,
  16% by bus (school buses included), 26–27% walk. TM1 calibrates school-tour constants of their own,
  and adds a transit penalty for children 10 or under on school tours (`c_age010_trn` = 69.41 ×
  c_ivt = −1.555).
- **Fix:** `calib.youthAsc` (transit, walk, bike against shared ride), fitted in calibrate.ts to the
  BATS under-18 shares (driving, ride-hail, school bus folded into shared ride, since the model's youth
  don't drive or hail rides alone); TM1's age term on school tours of the 45.4% of 5–17-year-olds aged
  10 or under (ACS B01001).

### 7. No free parking at work (fixed)

- **Model:** every commuter to a pay zone paid 8 hours at the long-term rate.
- **TM1:** a free-parking eligibility model, calibrated to 5.9% of SF employees in charging zones.
  TM2 adds reimbursement.
- **Effect:** small; free parkers drive at much higher rates, so averaging them in slightly understates
  downtown driving for a given constant.
- **Fix:** commutes to SF pay zones are a 94.1/5.9 mixture of paying and free parkers
  (`FREE_PARKING_SF`).

### Checked and consistent with the sources

- **Nesting and `nlogit()`:** TM1's level-2 nests (auto, non-motorized, transit, ride-hail) are all
  0.72 (ActivitySim: same; lower nests 0.35 DA/SR, 0.5 walk/drive access, 0.36 ride-hail). The model
  has one alternative in the transit and ride-hail nests (equivalent to placing them at the root) and
  {DA, SR} at 0.72, which is TM1's AUTO nest with its single-alternative sub-nests collapsed. Within a
  nest utilities are divided by 0.72 and the nest's logsum multiplied by it: correct. TM2 uses 0.6/0.4.
- **Cost coefficient formula:** 60 · c_ivt / VOT per dollar ≡ TM1's 0.6 · c_ivt / VOT per cent, VOT in
  $/h; VOT and costs consistently in 2025 $ (2000 $ × 1.98).
- **Units:** auto distance (10 m units ÷ 160.934 → miles), operating cost $/mile, parking $/h × hours,
  TNC $/min × congested minutes, fares $ per trip, transit perceived minutes: all consistent.
- **Transit time components:** skim `g` = factored IVT + 2 × wait + 2 × walk (+ calibrated mode bias);
  TM1's mode choice has 2 × the first 10 minutes of initial wait and 1 × beyond, and the model's
  effective headway (h > 20 counts half beyond 20) reproduces exactly 20 + 0.5 (h − 20) perceived
  minutes. Transfer wait 2× (TM1 2×). The path-choice transfer penalty (4 min) is not in `g`, so
  mode choice's transfer term is not double-counted.
- **IVT factors by submode:** LRT 0.9, ferry 0.8, BART 0.8, Caltrain 0.7 (calibrated), express 1.0:
  TM1's `c_ivt_*` ratios, applied in the path skims rather than to a key-mode IVT.
- **Walk/bike forms:** short/long split with 2×/10× (walk) and 4×/20× (bike, 6 mi = 30 min) as TM1.
  Network walk and bike times include grades, so TM1's topology dummies (15×, 20×, 2.2× IVT on
  hilly destinations) are not added (they would double count).
- **Walk access to transit:** TM1 uses zonal short/long walk shares with fixed times (0.33/0.67 mi);
  the model's block-level walk to each stop is finer and keeps the 2× weight.
- **Ride-hail:** wait 1.5 × IVT by TM1's density bins (3.0–10.3 min, same bins), in-vehicle at auto
  time, fares updated to 2025 published rates (TM1's are 2015-era). TM1's shared TNC and taxi
  alternatives are not modeled; BATS 2023 puts all ride-hail at 2.6% of residents' trips.
- **Density index:** the model's 2·hh·emp/(hh+emp)/total acres differs in form from TM1's
  hh·emp/(hh+emp) per *developed* acre (RESACRE + CIACRE), but SF's developed share is 52% of total
  acres, so the factor 2 nearly offsets it: SF TAZ deciles 3.5 / 10.7 / 45 (TM1 form) against 4.0 /
  11.9 / 47 (model form). Left as is.
- **Parking and terminal inputs:** match TM1 2023 SF TAZ inputs by area type (employment-weighted
  PRKCST 192/66/26/0 2000 ¢/h → $3.80/1.30/0.52/0; OPRKCST → $12.18/3.35/1.50/0).
- **Auto ownership:** TM1 segments by auto sufficiency (0, fewer than workers, at least workers) and
  makes DA unavailable without a car; the model segments by 0/1/2+ cars against ACS B08141 and keeps
  DA open to zero-car households because the ACS counts 9,900 such commuters driving alone. Consistent
  with its targets.
- **Drive to transit for residents:** TM1 offers it to car-owning households. BATS 2023 puts SF
  residents' drive-to-transit trips at under 0.01% (`DRIVETRAN` 6e-5, adults), so its absence for
  residents is immaterial; outside zones have park-and-ride lots.
- **Youth availability:** TM1 bars DA under 16; the model bars DA and ride-hail for 5–17 (BATS: 5% of
  under-18 trips are driving, folded into shared ride in the youth target).

### Differences kept, with reasons

- **Household-size and age terms** (TM1 `c_hhsize1_sr` −0.73 on work tours; TM2's estimated age, sex,
  household-size terms, e.g. 65+ transit −1.12 and non-motorized −1.45 on work tours): the model has
  no household size or sex, and seniors are a person type for rates and fares only. No SF senior
  mode-share target is available in the BATS extract; NHTS 2017 (metro, pre-pandemic) could supply a
  relative senior constant like the income one. Not done here.
- **Transit submode constants** (TM1's WALK_LOC/LRF/EXP/HVY/COM ASCs): the single strategy-based
  transit alternative uses calibrated per-ride biases (bus vs light rail) and fitted Caltrain and ferry
  IVT factors instead.
- **Destination-choice logsum coefficient** (0.75, assumed): the tour logsum is now ~1.2–1.65× larger
  per unit of round-trip disutility, so this effectively strengthens accessibility; the calibrated
  distance terms re-fit trip lengths.

## Tests

All runs with `experiment.ts` (2 passes, warm-started from the saved base run's crowding) and a quick
elasticity script (the validation's Muni fare ±10%, car running cost +10%, and 14/14R 10% faster
tests, 2 passes each; validate.ts uses 3 passes, so its levels differ slightly).

| Run | Muni routes r | %RMSE | within ±25% | Muni total | BART exits r / %RMSE / total | Caltrain SF | T | residents' transit |
|---|---|---|---|---|---|---|---|---|
| Baseline (branch start) | 0.933 | 36.7 | 46% | 538k / 516k | 0.953 / 19.1 / −1.7% | 11.1k / 11.8k | 8.3k / 25.0k | 12.2% |
| All fixes, constants not refit | 0.924 | 43.5 | 46% | 419k | — | — | — | 8.6% |
| All fixes, recalibrated (4 + 4 iterations) | 0.931 | 36.5 | 49% | 515k / 516k | 0.959 / 18.7 / −3.0% | 10.7k / 11.8k | 7.5k / 25.0k | 12.0% |

| Elasticity (2-pass) | Baseline | Recalibrated | Reference |
|---|---|---|---|
| Muni boardings / Muni fare | −0.14 | −0.25 | TCRP 95: −0.12 to −0.85, central −0.4; large cities ≈ −0.24 |
| Vehicle-km / car running cost | −0.17 | −0.18 | TAG: −0.15 to −0.35 |
| 14 + 14R boardings / running time | −1.13 | −1.17 | indicative −0.3 to −0.9 |

Calibration (weekday only, 4 iterations from the baseline constants, then 4 more after switching the
VOT mixture from three points to two) converged: residents 26.6 / 21.6 / 2.6 / 12.1 / 34.2 / 2.9
(DA / SR / TNC / transit / walk / bike) against BATS 26.7 / 21.8 / 2.6 / 12.0 / 34.0 / 2.9; one-car
commuters' transit 31.6 / 31.6%; youth 57.9 / 10.0 / 28.6 / 3.4 against BATS 58.3 / 10.4 / 27.9 / 3.4
(SR / transit / walk / bike; school trips had been 47 / 13 / 36 / 3). Without refitting, the
constants calibrated for the averaged form under-predict transit (8.6%), as expected from a change in
scale; the experiment row is there only to show the size of the change.

Reading: the route and station fit is unchanged within noise (Muni %RMSE 36.7 → 36.5, BART %RMSE
19.1 → 18.7, more routes within ±25%), the Muni total comes onto the count, and the fare elasticity
nearly doubles, from below the large-city figure to just above it. Caltrain's SF boardings and the T
fall slightly (10.7k and 7.5k), the T remaining the largest miss as before. The car running-cost
elasticity barely moves: with values of time spread out, drivers are mostly the high-value-of-time
households whose response is small. The 14/14R running-time elasticity is a path-choice result (the
two routes against the 49) and was already above the band.

## Needs recalibration or further work to judge

- **Full recalibration** (14 iterations, with weekends): the weekend transit constants and regional
  visitor rates were carried over, not refit; the ferry and Caltrain in-vehicle factors, the light-rail
  bias, and the transfer factor moved only over the 8 weekday iterations.
- **validate.ts sensitivity and the backcast** should be rerun on the recalibrated bundle; the fare
  elasticity here is from a 2-pass script.
- **Destination choice:** the tour logsum is larger per minute than the averaged one, so accessibility
  weighs more in destination choice; trip lengths re-fit to NHTS (shop 3.8 km, other 4.9 km), but
  `DEST_LOGSUM` (0.75, assumed) could be revisited against TM1's destination choice logsum coefficients.
- **Seniors:** TM2's estimated 65+ terms (transit −1.12, non-motorized −1.45 on work tours) have no SF
  target here; an NHTS 2017 relative senior constant, like the income one, is the available fix.
- **The paper** (`client/beta3/paper/sections/model.ts`) still writes the utilities in the old form
  (1.5 × terminal at both ends, shared-ride cost ÷ 2, one value of time, trip coefficients).

**Run time.** The VOT mixture evaluates the nested logit twice per choice; with `nlogit()` rewritten
(one multiply instead of a divide per exponent, `s^θ` for the nest's exponentiated logsum) demand
takes the same time as before, measured back to back on the same machine: 27.6 and 35.7 s (baseline)
against 26.8 and 29.9 s.
