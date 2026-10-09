# SF-TRACE 1.0 (San Francisco Transit Ridership And Choice Estimator): method

SF-TRACE is an open model of transit ridership and travel choices in San Francisco. It estimates every trip with an end in the city on an average weekday, from public data, and runs in the browser. It is the same kind of model the region's agencies use (MTC's Travel Model One, SFCTA's SF-CHAMP), simplified so a scenario runs on your own computer. This is the short companion to the methodology article at /beta3/method, which has the equations, the tables, every source, and the results. The sections below follow the article's.

## Data

- **Zones.** The city's 678 census block groups, with 2020 census population and ACS 2020–24 households by cars and income, ages, workers, enrollment, and commute mode. Places outside the city are external zones built from the census commuting records: station catchments, large cities split into parts by where their commuters live, and SFO.
- **Jobs.** LEHD LODES 2023 by block and sector, rebalanced to MTC's 2023 employment by Travel Model One zone, with employers that publish counts by site (UCSF, for one) placed at their sites.
- **Networks.** The OpenStreetMap street and path network, sidewalks and crossings included, with grades from USGS elevation. Every scheduled weekday trip from the GTFS feeds of Muni, BART, Caltrain, Golden Gate Transit, the ferries, AC Transit, SamTrans, SMART, and the shuttles.
- **Travel surveys.** BATS 2023 (residents' mode shares and commute frequency), NHTS 2017 (tour and stop rates, trip lengths, time of day), and the ACS commute tables.
- **Counts.** SFMTA's automatic passenger counts by route, BART's station and station-to-station counts, Caltrain's station counts and 2024 origin–destination survey, ferry boardings, SFCTA's Congestion Management Program speeds, and Caltrans traffic counts.
- **Parameters.** Travel Model One and Two (mode choice, path weights, crowding curves, values of time, costs, capacities), with fares and tolls from the operators' 2026 schedules.

## Model structure

- **Population and cars.** Residents are split by zone, household cars (none, one, two or more), income (under and over $100,000), and person type. A synthetic population of households and persons, balanced to the ACS by block group, supplies the person types. Households' cars follow the ACS; a long-run option lets them choose again with Travel Model One's car ownership model.
- **Tours.** Residents' travel from home is made in tours: home to a primary destination and back, at NHTS 2017 rates by purpose and person type, scaled to BATS 2023's count of residents' trips. Commutes follow the census home-to-work flows, less people working from home, at BATS 2023's commute frequency. School tours go to the city's schools by level, and college tours to the campuses, each held to enrollment. Each half of a tour may stop on the way. Trips with **neither end at home** (from one stop to the next, from work to lunch, and in-commuters' and visitors' trips around the city during the day) are their own purpose; travel surveys call them non-home-based.
- **Visitors and others.** Hotel visitors, SFO air travelers, regional visitors, in-commuters, outside students, sightseeing rides on the cable cars and historic streetcars, park visits, and games, concerts, and conventions each have their own generator.
- **Destinations.** A logit model weighs what is at each place (jobs by sector, storefronts, enrollment, park acreage) against how easy it is to reach by every mode (the mode-choice logsum), so better transit also changes where people go.
- **Mode choice.** A nested logit with Travel Model One's coefficients: drive alone and carpool, walk and bike (with shared bikes and scooters), transit, and ride-hail and taxi. Each tour has a mode, and each of its trips chooses its own among the modes the tour's mode allows: a driving tour stays in a car, while a transit tour's trip back may walk or take a ride. Cost is weighed by a spread of values of time within each income class.
- **Time of day.** Four periods: morning peak 6–10am, midday 10am–3pm, evening peak 3–7pm, and night 7pm–6am. Each purpose's legs travel at NHTS 2017's times, and mode choice sees each leg's mix of periods.
- **Transit assignment.** Riders follow optimal strategies (Spiess and Florian), the headway-based assignment of Emme and Visum: at each stop a rider has a set of attractive lines. Waiting and walking count double; a change of lines costs a calibrated penalty; each block of a zone has its own walk to each stop; and riders choose where to get off and where to change. Each Muni route's wait is scaled by its measured reliability. Crowded vehicles feel longer (Travel Model Two's curves), and full ones leave riders behind. BART and Caltrain also carry fixed background riders whose trips have no end in the city.
- **Roads.** Every weekday run assigns cars to the city's streets, and the Precise run mode also to US-101 and I-280 from the county line to San Jose: a static user-equilibrium assignment by period with Travel Model One's speed–flow curves. Driving, ride-hail, and bus running times in mixed traffic respond. Commercial and through traffic and the freeways' background traffic are fixed inputs. Parking costs and terminal times are Travel Model One's.
- **Iteration.** Skims, demand, assignment, crowding, and road speeds alternate until they settle. Today's baseline is run to convergence; a no-change scenario reproduces it exactly.
- **Conditions outside the network.** Office attendance, working from home, commute days, employed residents, jobs, population, hotel visitors, SFO passengers, the price of gasoline, and fares are inputs a scenario can change.
- **Weekends (experimental).** Saturday and Sunday models use each operator's weekend timetables and NHTS 2017's weekend rates and timing.

## Run modes

- **Quick** (the default) holds today's road speeds fixed, as FTA's STOPS does for New Starts forecasts, unless a scenario edits streets or car prices; then it makes an approximate road response.
- **Precise** runs the full model, with traffic feedback and every road assignment solved to today's convergence.
- Each mode compares a scenario with today's network run the same way, so the approximation does not show up as a change. The article reports how far Quick's results fall from Precise's.
- **Time savings** are the change in travelers' logsums, in minutes, split into transit riders, drivers (and ride-hail), the Peninsula freeways' other drivers, and others.

## Calibration

The constants are fitted to observed San Francisco data. The route-by-route counts are not fitted.

- **Residents' commute mode by household cars:** ACS 2024 (B08141).
- **Residents' trips by mode:** BATS 2023, all trips and by income class.
- **Transit share by home neighborhood:** ACS 2020–24 commute shares by block group.
- **Muni's level:** its total weekday boardings on the counted routes, split by where riders live (MTC's 2023–24 on-board survey), with one factor for residents and one for non-residents.
- **In-commuters' and outbound commuters' modes by county:** ACS 2024.
- **Students:** SFUSD and SFMTA school travel surveys, SF State's survey, and BATS 2023's trips by residents under 18.
- **BART:** exits at the city's stations (BART, August 2026).
- **Caltrain:** boardings at the city's stations (FY2026) and the direction of the morning commute.
- **Ferries and AC Transit's Transbay buses:** boardings on the commuter routes into the city.
- **Changes of vehicle:** the share of Muni boardings that follow another vehicle on the same trip (SFMTA's on-board survey).
- **How far trips go:** NHTS 2017 trip lengths of residents of dense tracts.
- **Cars:** households by cars available (ACS B25044), through the car ownership model's constants.
- **Shared bikes and scooters, parks, and events:** Bay Wheels and scooter trips, counted park visits, and the venues' surveyed transit shares.
- **Road speeds:** SFCTA's Congestion Management Program speeds by road type and period.

## Validation

Evidence is kept in tiers:

1. **Calibration targets,** above, which match by construction.
2. **A development set:** weekday Muni boardings by route, examined while the structure was revised but never fitted route by route.
3. **Independent tests,** never used in building the model: BART segment loads and station-to-station markets, Caltrain journeys by station group and period, ferry boardings by route, trip lengths from the National Transit Database, time-of-day profiles, Bay Wheels trips, road counts and speeds, and elasticities against published ranges.
4. **Held-out tests:** a backcast to the June 2024 Muni network with the conditions of July 2024, fixed before the run and compared with July's counts in both years, and the weekend route counts.

The Validation tab shows today's fit. The article reports every statistic, scores the independent and held-out tests against the FHWA, California Transportation Commission, and UK TAG standards, and compares the route fit with the published validation of SF-CHAMP and Travel Model One.

## Scenarios

The article applies the model to the Portal (Caltrain's extension to the Salesforce Transit Center), fare-free Muni, a peak charge to drive into Downtown and SoMa, and bus lanes, with the time savings by traveler for each and the range of results across drawn parameters.

## Limitations

- **Single routes.** Individual routes are often far from their counts; the T and the Mission Street routes run well below theirs. Single routes respond to service changes more than published elasticities suggest. Read corridor and system totals as the more reliable output.
- **Who rides Muni.** Muni riders' share on work trips is below MTC's on-board survey, and non-residents' Muni boardings fall short of their share of the count, with their level factor at its bound.
- **BART downtown.** The split of exits among Embarcadero, Montgomery, and Civic Center does not match the counts, and entries at stations outside the city fit poorly.
- **Caltrain.** Morning arrivals in the city and the Peninsula counties' in-commuter transit shares cannot both be met as the model is specified.
- **Roads.** A static assignment: no queues carry between periods, and midday freeway speeds are too fast. The model's own cars are short at the Golden Gate Bridge and the county line, where background traffic fills the gap. Marin's driving legs use assumed speeds.
- **Demand.** Residents are groups, not households: no shared cars or escorted children. The person-level layer is optional. Homes, jobs, and working from home are fixed. Some rates and timing are from NHTS 2017, before the pandemic, and visitors' mode shares are assumed.
- **Weekends** are experimental and have no survey to check them against.
- **Results are averages** for a typical weekday in 2026, not forecasts for a particular date.

## How to cite

SF-TRACE 1.0: San Francisco Transit Ridership And Choice Estimator. An open model of transit ridership and travel choices in San Francisco. Version 1.0, 2026. [URL to be added]
