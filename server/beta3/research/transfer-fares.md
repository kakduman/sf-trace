# Clipper's transfer discount: why the backcast gave it +5.8 points

Research notes for the Beta3 backcast. Compiled 2026-10-06. Raw files are in
`data/beta3/raw/xferfare` (gitignored); each source below names its file. "Model" figures come from
`server/beta3/pipeline/diag-xfer.ts` (two passes from empty vehicles, as the backcast runs), which
follows riders across operators exactly: a strategy is Markovian, so a backward pass gives each node
the chance that the rest of the trip uses an operator, and a forward pass carries which operators a
rider has already used.

## 1. The problem

The backcast's decomposition gave Clipper's transfer discount (July 2024: $0.50 onto Muni only;
July 2026: up to $2.85 off any later operator) +5.8 log points of Muni's 2024–2026 growth. SFMTA's
monthly counts show no step after December 10, 2025 (year-over-year growth 4.3% over July–November
2025, 4.4% over January–June 2026).

## 2. What the discount was, and who had it

- **The rule.** MTC's No-Cost and Reduced Cost Interagency Transfer Pilot MOU (Article II; copy
  signed by Fairfield's FAST, `wheels_xfer_pilot_mou_2024.pdf`): on boarding a different operator
  within 120 minutes, a full-fare adult gets the lesser of that operator's fare and the region's
  highest local fare ($2.50 when signed, $2.85 at launch) off, never below zero, on each later
  operator. Discount categories (youth, senior, Clipper START, RTC) get a discount in proportion to
  their fare. The MOU sets no condition on how the first ride was paid, so a pass ride counts as a
  first boarding. The model applied this rule as written; youth and seniors are handled by scaling
  the whole path fare (PERSON_FARE), which is the proportional rule.
- **Who had it: only cards on the next-generation system.** BART's launch notice (2025-10-21,
  `data/beta3/raw/fares/bart-news-2025-10-21-next-gen-clipper.html`): the discount is "immediately
  available for contactless bank cards. Clipper card users must wait for their cards to be upgraded
  to the new system". The bulk upgrade of cards was held up for months (MTC Clipper Executive Board,
  April 27, 2026, `ceb_2026-04-27_clipper_transition.pdf`: bulk migration "remains on hold"). Share
  of all Clipper trips processed on the new system: about 31% in February 2026 (22% upgraded cards,
  9% bank cards; MTC Commission, March 25, 2026, `mtc_2026-03-25_summary_sheet.pdf`), 38% on April 20
  (CEB, April 27), 45% in the week ending May 23 (MTC news, May 26, 2026), and 53% in the week
  ending July 18 (MTC news, July 24, 2026). Cards not yet upgraded kept the old rule.
  **The backcast gave everyone the new discount in July 2026; about 53% had it.**
- **The old rule** (SFMTA fare table, FY2024 through 2025, "Inter-agency discounts",
  `data/beta3/raw/fares/sfmta-fare-table-2025.pdf`): (1) $0.50 off for *full-fare* customers
  transferring to Muni from any connecting agency on Clipper; (2) a free round-trip transfer from
  Daly City BART to the Muni lines serving that station. No other operator discounted a transfer
  from Muni.
- **How much it was used.** About 2 million discounts by May 27 and 3 million by July 2, 2026 (MTC
  news): about 1 million in 36 days, some 32,000 a weekday region-wide, with roughly half of trips
  on the new system.

## 3. How the model coded it, and what was wrong

| | before | now |
|---|---|---|
| July 2026 riders with the new discount | all | 53% (`CLIPPER_NEXTGEN_SHARE`, a condition); the rest the old rule |
| old $0.50 onto Muni | taken off the *expected* fare ($2.09 with passes, giving $1.56) | taken off the fare of riders who pay per ride: 0.733 × ($2.85 − $0.50) = $1.72 (pass holders pay nothing either way) |
| Daly City BART → Muni (old rule) | full fare | free |

Each is in path choice (on the walking link from one operator's stop to another's) and therefore in
the mode-choice skim's fare. Checked and right: the saving is counted on each transfer of each leg
(a round trip with a transfer each way saves twice, as it does on Clipper); the pass holder's
expected fare is consistent with the rule (BART after a pass ride is discounted under the MOU);
youth and senior discounts scale with their fares.

## 4. Too many riders change between operators in the model

Model, 2024 network with the old rule (July 2024): 13.0% of Muni's boardings are on trips that also
use another operator (BART 8.1%, Caltrain 2.2%, Golden Gate 2.0%, ferries 0.8%). Of the 152,500
BART trips with an end in the city, 29,700 (19.4%) also ride Muni; of the 18,100 within the city,
2,700.

Observed:
- **MTC Regional Onboard Survey 2015** (FCIS Draft Business Case, October 2021, Figure 2.4, read off
  the chart, `Draft_FCIS_Report.pdf` p. 8): daily trips by operator pair, BART–Muni about 27,800,
  Caltrain–Muni 6,800, AC Transit–Muni 2,000, Muni–SamTrans 1,900, Golden Gate Transit–Muni 1,200:
  about 39,700 Muni trips with another operator, when Muni carried about 700,000 weekday boardings
  (about 7% of boardings at 1.2 Muni boardings a trip) and BART about 433,000 weekday trips (BART–Muni
  6.4% of them). "Less than 10 percent of daily transit riders transfer between operators within a
  single trip" (FCIS p. 7, Clipper and survey data, 2019).
- **BART 2024 Station Profile Study** (home origins, `reference/bart-station-access-2024.json`): at
  the eight city stations, 25% of riders leaving from home came by bus or train. The model's
  morning-peak entries at the city stations: 18% from Muni. The access side is not over-predicted.
- BART's July 2026 OD (`data/beta3/raw/obs/bart_Ridership_202607.xlsx`): 203,500 weekday trips,
  143,500 with an end at the eight city stations, 23,400 within the city.

So the model has about twice the surveyed share of BART riders who also ride Muni, and the excess is
at the far end of trips across the Bay (riders from outside the city connecting to Muni at their
destination, and the reverse), not at the home end in the city. The discount acts on that inflated
base.

**A penalty on changing operators was tried and rejected.** Ten perceived minutes on every change
between operators (`PATH.operatorChange`) cut the BART riders also riding Muni from 19.4% to 14.1%,
but lowered the morning share reaching BART's city stations by Muni from 18% to 12% (observed 25%
from home), and the Muni route fit got worse (experiment.ts: %RMSE 47.7 → 49.2, BART's city exits
−1.3% → −3.9%). The surplus is a matter of where in-commuters' jobs are reached from BART, which a
uniform penalty does not address; left for the calibration.

## 5. The response, before and after, against published evidence

Today's network, today's discount against the old rule ($0.50 onto Muni), all else today's:

| | before the fixes (all riders on the new system) | after (53% on it) |
|---|---|---|
| Muni boardings on trips also using another operator | 20.1% (old rule 13.0%) | 16.0% (old rule 12.9%) |
| linked trips using Muni and another operator, and their mean fare | 74,100 at $7.65 (old rule 44,500 at $10.19) | 56,700 at $8.90 (old rule 44,200 at $10.12) |
| BART trips with an end in the city that also ride Muni | not measured | 25.1% (old rule 19.0%) |
| linked transit trips | +1.5% | +0.7% |
| Muni boardings | +5.6% | +2.4% |

The "before" column is `pipeline/diag-xfer.ts` on the unchanged code (two passes from empty
vehicles); the "after" column is `pipeline/fare-test.ts` (three passes from the base run's crowding,
as validate.ts makes its tests).

- **Mode choice** responds about as MTC's own model did: Travel Model 1.5, run for the Fare
  Coordination and Integration Study, gave +0.8% regional transit trips for no-cost transfers between
  local services and onto regional ones, and +1.9% (25,500 trips a day) with discounted transfers
  between regional ones too (FCIS Draft Business Case, Table on p. 21 of the SFMTA Board
  presentation, October 5, 2021, `sfmta_fcis_28537.pdf`; the 27,000 trips a day cited in the pilot
  MOU). The model gives +1.3% of the city's linked transit trips with everyone on the new system.
- **Route choice** is where the Muni boardings come from: most of the +2.4% are riders already on
  BART who now ride Muni to or from the station, or riders already on Muni who now ride BART within
  the city. Taken over the trips using Muni and another operator, the arc elasticity against their
  mean fare is about −1.9 (+25% trips, −13% fare), against −0.2 to −0.4 for fares generally (TCRP
  Report 95, ch. 12: bus about −0.4, heavy rail −0.17 to −0.18, large cities about −0.24); that
  figure mixes riders changing paths with new riders, so it overstates the demand response, but the
  path response itself has no published counterpart and acts on a base about twice the surveyed
  size (section 4).
- **The SFMTA monthly series.** With about 36% of trips on the new system over January–June 2026
  (31% in February, 38% in April, 45% in late May, about 50% in June), the corrected model's +2.4
  points with 53% implies a step of about +1.6 points in Muni's year-over-year growth after December
  2025; the counts show +0.2 (4.3% to 4.4%), with a standard error of about 0.9 points on the
  difference of the two monthly means. The step the model implies is within two standard errors;
  the uncorrected model, which gave everyone the discount, implied +5.6 points, six standard errors
away.
- **Muni's fare elasticity** (the validation's ±10% test): −0.25 (−0.21 before), inside TCRP 95's
  range (−0.12 to −0.85).

## 6. The backcast rerun

All fourteen runs remade with the corrected coding (no July 2024 input changed): the discount's
share of the 2024–2026 growth fell from +5.8 to +2.5 log points; the model's system growth from
+4.3% to +1.1% (counted +6.4%); network alone −3.3, interactions −0.2, the other conditions as
before. Route-level: weighted correlation of relative change 0.76, mean absolute error 8.4% against
10.5% for no change.
