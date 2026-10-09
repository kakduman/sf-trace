# Muni route split: what route choice does and doesn't explain (October 2026)

Model: calibrate6's bundle (client/beta3/model/sf.bin.gz), `experiment.ts` with 2 passes. The route
counts are SFMTA's 2025–26 weekday means for the 57 counted routes, used only to measure. "Scaled"
means the model's routes are multiplied so that together they meet the counted total (515,626). This
removes Muni's level, which is fitted elsewhere.

## Baseline

| | value |
|---|---|
| Scaled %RMSE | 38.0 |
| r | 0.923 |
| Within ±25% | 51% |
| Scale factor | 1.285 |
| BART city exits r | 0.851 |
| Muni boardings after another vehicle | 11.1% |

Largest misses (scaled model / count, thousands):

- **Under:** T 11.4/25.0, 14R 11.9/22.7, 14 14.7/22.1, 49 30.4/35.0, N 30.6/35.1, 8 14.2/18.4.
- **Over:** 38 25.5/18.0, 1 25.3/18.6, 5 11.3/5.4, 5R 13.3/8.9, 29 20.1/16.0, 43 12.5/9.4, 45 13.6/10.6.
- **The 15:** 5.0/3.8.

Muni boardings by stop district (model / 2006–07 TEP shares at the model's total, thousands):

| District | Model | TEP 2006–07 |
|---|---|---|
| Mission | 26.4 | 27.7 |
| Excelsior–Visitacion Valley | 34.1 | 36.5 |
| Bayview–Hunters Point | 9.2 | 11.8 |
| Mission Bay–Potrero | 15.9 | 8.3 |
| Western Addition–Haight | 47.5 | 39.4 |
| Southwest | 24.1 | 31.5 |

Mission Bay was mostly undeveloped in 2006–07, so its share then is not a target.

## Checks

**Schedules.** The 2026 GTFS (Wednesday July 29, trips starting 6–10am) has these trip counts, the
same as the bundle's lines:

| Route | Trips (each direction) |
|---|---|
| T | 24 and 29, plus short turns from Marin St |
| 14 | 24 and 24 |
| 14R | 24 outbound, 48 inbound |
| 49 | 34 and 46 |
| 15 | 18 and 18 |

The 15 in the 2026 feed is the Bayview Hunters Point Express:

- It loops through Hunters Point (Palou, Ingalls, Kiska, Hudson).
- On Third Street it stops only at Evans, Marin, 20th, Warriors Way, Brannan, and Mission.
- It takes 17.2 minutes from 3rd & Evans to 3rd & Mission. The T takes 26.5 minutes from Evans to
  Union Square.
- It shares no stop with the T, so the T/15 split comes from the choice of access stop (the logit
  over stops), not from the split among lines at a stop.

**The T by stop** (model, unscaled, daily; reference/t-third-ridership.json for the observations):

| Section | Model | Observed |
|---|---|---|
| Central Subway (Chinatown, Union Square, Yerba Buena, 4th & Brannan) | 2,700 | about 9,500 (SFMTA via Mission Local, 2025) |
| 4th & King | 1,441 | 1,497 (2006–07) |
| Third Street south of King | about 4,700 | 9,334 (2006–07) |

**Central Subway access** (Chinatown zone 060750611022):

- The blocks' mean walk is the same to the station (2.07 minutes) and to the Stockton & Washington
  bus stop (2.01 to 2.05).
- The station adds 2.0 minutes from the street to the platform, weighted as walking (4 perceived
  minutes).
- At 10-minute headways the T's wait is 5.7 minutes (waitFactor 1.14), or 11.4 perceived minutes. The
  Stockton buses (8, 30, 45) come every few minutes together.
- To 4th & King, the T's ride is 12 perceived minutes better than the buses' (u 15.5 against 26.9 to
  28.1), yet only 39% of riders take it.
- To Mission Bay at UCSF, 92% take the T.
- Nothing here is wrong. The station depth is real (the platform is about 120 feet down), and so are
  the headway and the bus frequency.

**The line split at stops** (informed against uninformed riders):

| informedShare | Scaled %RMSE | r | Within ±25% |
|---|---|---|---|
| 0.67 (baseline) | 38.0 | 0.923 | 51% |
| 1 | 37.8 | 0.923 | 49% |
| 0 | 38.4 | 0.921 | 51% |

- Across all three runs the T stays at 11.4–11.5k, the 14 at 14.7k, and the 14R at 11.9k.
- The transfer share stays at 11.1–11.2%.
- So the frequency-based split by uninformed riders is not what keeps the 14, the 14R, or the T low.

**Mission Street paths** (explain-path.ts, AM):

- 24th & Mission to 5th & Mission: 68% take BART from 24th Street, the rest the 14R or the 14.
- Outer Mission (Persia) to SoMa: all ride the 14R or the 14.
- Bayview (Third & Oakdale) to the Financial District: 96% ride the T.

The paths are sensible. The missing Mission Street riders are trips the model sends elsewhere, which
shows up as the crosstown and feeder routes running over (29, 43, 33, 67) while the trunk routes run
under.

**Rail preference in route choice.** In the model now:

- The light-rail in-vehicle factor (0.9, TM1) enters both mode choice (the skim's perceived in-vehicle
  time) and the strategy search (each ride link's cost).
- Uninformed riders split among a stop's attractive lines by frequency alone. The factor only decides
  which lines are in the set.
- The T's stops are its own, so that split barely touches it.

Values in the literature:

| Source | Value | Context |
|---|---|---|
| tm2py-utils 2023 dev config | LRT and heavy rail 0.9, bus 1.0 (in-vehicle factor); boarding penalty LRT 4.5 against local bus 4.0 minutes | Assignment |
| SANDAG ABM3 MODE5TOD | Local bus 1.5, LRT 1.0 | Assignment |
| Bunschoten, Molin & van Nes 2013 | Tram over bus 3.3 in-vehicle minutes per trip at equal service; not significant once vehicle and information attributes enter | Stated choice between tram and bus |
| Axhausen et al. 2001 | Tram in-vehicle time about 0.86 of bus | Dresden, RP and SP |
| Ben-Akiva & Morikawa 2002 | No preference for rail at equal service | Mode choice |
| ARC | LRT 0.80, MARTA 0.75, plus a rail constant up to 15 min a trip | Mode choice |
| SANDAG ABM3 | LRT 0.85 plus 35 min | Mode choice |

For riders who use transit rarely, the two studies with numbers (Bunschoten et al. 2013; Scherer 2011)
find less preference for the tram, not more. No source quantifies a preference for rail among
unfamiliar riders, so the uninformed riders' split is left by frequency.

The test is `PATH.railBonus = 3.3`: a cost per bus ride, in route choice only, which leaves mode
choice alone. Results (scaled model / count, thousands):

| | Baseline | railBonus 3.3 |
|---|---|---|
| Scaled %RMSE | 38.0 | 37.8 |
| r | 0.923 | 0.924 |
| Within ±25% | 51% | 53% |
| T | 11.4 | 14.8 |
| 15 | 5.0 | 4.1 |
| 14 | 14.7 | 12.8 |
| 14R | 11.9 | 9.8 |
| 49 | 30.4 | 28.8 |
| Subway (J, K, L, M, N; count 94.8) | 87.1 | 104.7 |
| N | 30.6 | 37.6 |
| L | 19.5 | 22.4 |
| Boardings after another vehicle | 11.1% | 10.2% |
| BART city exits r | 0.851 | 0.847 |

The T gains a quarter and the 15 falls toward its count. But the subway, which fit, ends up 10% over,
the Mission Street buses fall further, and the transfer share drops away from the survey's 12.3%. The
0.2-point gain is no larger than informedShare's own swing, so the knob stays at 0.

## Not changed

No fix in this round met the bar of a sourced structural cause that improves the 57-route fit.
`experiment.ts` now prints:

- the scaled route fit;
- boardings by stop district;
- each line's boardings by stop (`--line-stops`), for the next round.

# Second round: where along the routes, the access choice, and running time by segment

## Stop profiles

Method:

- The model's boardings by stop (`--line-stops`, scaled ×1.285) are grouped by the neighborhood of
  the stop.
- They're compared with SFMTA's 2006–07 TEP profiles. Shape: each route's share by neighborhood.
  Level: the TEP share times today's count.
- The old 14L, 38L, and 9X stand in for the 14R, 38R, and 8.
- The T's Central Subway and Mission Bay, and the N's Mission Bay stops, are left out of the reading,
  because those areas changed after 2007.

Each entry below is model / TEP-based, in thousands.

| Route | What the profile shows |
|---|---|
| 14 | Shape matches (Mission 30/30%, Outer Mission 22/26%, SoMa 19/18%). It's short by about a third all along: Mission 4.4 / 6.7, Outer Mission 3.2 / 5.8, SoMa 2.7 / 4.0. |
| 14R | Shape close, except the Mission (19% / 32%: 2.3 / 7.3). |
| 49 | Mission 8.5 / 12.3, Hayes Valley 0.6 / 2.7. |
| 38 | The excess is downtown: Tenderloin 6.1 / 1.2, Financial District 5.2 / 2.4. The Outer Richmond is short (3.5 / 5.9). |
| 38R | Financial District 7.8 / 5.1. Inner Richmond and Japantown short. |
| 1 | Pacific Heights 6.9 / 3.5, Nob Hill 5.4 / 2.9. |
| 5 | Western Addition 3.6 / 0.9. |
| 45 | Financial District 3.1 / 1.0, SoMa 1.8 / 0.8. |
| 8 | Chinatown 2.1 / 4.2, Visitacion Valley 2.0 / 3.9. SoMa over (1.8 / 0.7). |
| N | Financial District 6.1 / 9.2, Tenderloin (Civic Center) 1.2 / 3.1. |

The extra riders sit on the buses' downtown and inner segments. The missing ones are spread evenly
along the Mission Street routes, and at the outer ends of the Geary and Bayshore lines.

## The access stop

**Catchment.** No trunk line is cut out of a zone's stops:

- Every zone whose centroid is within 400 m of a stop of the 14, 14R, 49, T, 8, 38, 38R, 1, 5, 29,
  or 33 has an access link to that line. The 43 misses one zone, in Twin Peaks.
- Within 700 m, 1 to 3 zones per line lack one, almost all on Nob Hill.

So the rules (three stops a line within 5 minutes of the nearest, the 15% reach rule, rail stations
in reach, and every block's nearest stop of each line) don't favor feeder lines.

**The logit's spread.**

| accessTheta | Scaled %RMSE | r | Within ±25% | BART exits r | After another vehicle |
|---|---|---|---|---|---|
| 0.3 (baseline) | 38.0 | 0.923 | 51% | 0.851 | 11.1% |
| 0.6 | 38.0 | 0.923 | 47% | 0.815 | 10.9% |
| 0.15 | 41.6 | 0.908 | 42% | 0.906 | 13.9% |

At 0.6 the rapids gain (14R 12.8, 38R 30.3, 49 32.0) and the locals lose (14 13.6). Neither value
helps the routes overall, so 0.3 stays.

## Running time by segment (adopted)

**The problem.** Scheduled times between GTFS timepoints are spread by distance. The route-level
observed factor (`runFactor`) only scales the whole run, so a line's downtown blocks and its outer
blocks run at the timetable's mixed speed.

**The change.** `transit.ts segmentShapes` spreads each Muni line-period's scheduled time over its
hops:

- in proportion to each hop's median observed time (Cal-ITP and MTC segment arrivals, Tuesdays to
  Thursdays, September 16 to October 16, 2025; at least 20 runs a hop);
- keeping each period's total, so `runFactor` still sets the level;
- only where observed hops cover at least 80% of the scheduled time;
- leaving the downtown subway's observed runs as they were.

Result: 642 of 701 line-periods are reshaped. Examples at midday:

- The T toward Chinatown spends 35% of its time in its first third (Bayview), up from 28%.
- The 5 from La Playa spends 38%, up from 24%.

Tested on the calibrate6 bundle with the change applied to its lines (as a rebuild would apply it),
2 passes:

| | Baseline | Segment shapes |
|---|---|---|
| Scaled %RMSE | 38.0 | 36.7 |
| r | 0.923 | 0.928 |
| Within ±25% | 51% | 49% |
| BART city exits r | 0.851 | 0.860 |
| Muni boardings after another vehicle | 11.1% | 11.4% |
| T | 11.4k | 12.4k |
| 1 | 25.3k | 24.6k |
| N | 30.6k | 31.2k |
| 7 | 16.2k | 15.5k |
| 8 | 14.2k | 13.3k |
| 49 | 30.4k | 30.0k |
| 45 | 13.6k | 13.8k |

The T, 1, N, 7, 14, 29, and 5 move closer to their counts; the 8, 49, 45, 14R, K, and 44 move a
little away. The bundle needs `transit.ts` and a rebuild, then recalibration, for the change to take
effect.
