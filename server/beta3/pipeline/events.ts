/**
 * The special-event calendar: every weekday event at the city's big venues from October 2025 to
 * September 2026 (the twelve months Muni's route counts average), with its attendance, averaged to
 * an average weekday by venue and time of day. Writes server/beta3/reference/special-events.json,
 * which build.ts puts in the bundle (header.events) for demand.ts's special generator.
 *
 * Sources (raw copies in data/beta3/raw/events/):
 *  - Giants: Baseball-Reference 2026 schedule and results (home games, day or night, attendance).
 *  - Warriors: Basketball-Reference 2025-26 game log (home games and attendance); preseason home
 *    games from DoTheBay's Chase Center listings.
 *  - Valkyries: Basketball-Reference 2026 schedule; every home game sold out the arena's 18,064
 *    seats (WNBA/Valkyries, Sept. 2026: 22 sellouts, 397,408).
 *  - Concerts and other events: DoTheBay's past-event listings for Chase Center, Oracle Park, and
 *    Bill Graham Civic Auditorium, and setlist.fm's Chase Center listings; attendance assumed by
 *    kind of event (no public per-show counts).
 *  - Conventions at Moscone: the organizers' published in-person attendance (see CONVENTIONS).
 * An average weekday is taken the way SFMTA averages its counts: each month's event attendance on
 * weekdays (Monday to Friday, holidays included) over the month's weekdays, then the mean of the
 * twelve months. August 2026 alone is kept too, the month of the BART counts.
 * Run: npx tsx server/beta3/pipeline/events.ts
 */
import fs from 'node:fs';
import { RAW, REFERENCE } from './paths';

const DIR = `${RAW}/events`;
const FROM = '2025-10-01', TO = '2026-09-30';
type Kind = 'evening' | 'concert' | 'day' | 'convention';
interface Ev { date: string; venue: string; event: string; kind: Kind; attendance: number; source: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const inWindow = (d: string) => d >= FROM && d <= TO;
const weekday = (d: string) => {
  const w = new Date(`${d}T12:00:00Z`).getUTCDay();
  return w >= 1 && w <= 5;
};
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
/** rows of a Sports-Reference table as {data-stat: text} */
function srRows(file: string, tableId?: string): Record<string, string>[] {
  let s = fs.readFileSync(`${DIR}/${file}`, 'utf8').replace(/<!--|-->/g, '');
  if (tableId) {
    const i = s.indexOf(`id="${tableId}"`);
    if (i < 0) return [];
    s = s.slice(i, s.indexOf('</table>', i));
  }
  const out: Record<string, string>[] = [];
  for (const r of s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c: Record<string, string> = {};
    for (const m of r[1].matchAll(/data-stat="(\w+)"[^>]*>([\s\S]*?)<\/t[dh]>/g)) c[m[1]] = strip(m[2]);
    if (c.date_game && c.date_game !== 'Date') out.push(c);
  }
  return out;
}
/** "Wednesday, Mar 25" (year given) or "Tue, Oct 21, 2025" */
function srDate(s: string, year?: number): string {
  const m = s.match(/([A-Z][a-z]{2})\w* (\d+)(?:, (\d{4}))?/)!;
  return iso(new Date(Date.UTC(Number(m[3] ?? year), MONTHS[m[1]], Number(m[2]))));
}
/** DoTheBay past-event listings: date and title of every event */
function doTheBay(venue: string): { date: string; title: string }[] {
  const out: { date: string; title: string }[] = [];
  for (const f of fs.readdirSync(`${DIR}/dothebay`).filter((f) => f.startsWith(`${venue}-p`))) {
    const s = fs.readFileSync(`${DIR}/dothebay/${f}`, 'utf8');
    for (const m of s.matchAll(/data-permalink="\/events\/(\d+)\/(\d+)\/(\d+)\/[^"]*"[\s\S]*?ds-listing-event-title-text" itemprop="name">([^<]*)</g))
      out.push({ date: iso(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))), title: strip(m[4]) });
  }
  return out;
}
/** setlist.fm venue listings: concert dates and the artists on them */
function setlistFm(venueId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of fs.readdirSync(`${DIR}/setlistfm`).filter((f) => f.startsWith(venueId))) {
    const s = fs.readFileSync(`${DIR}/setlistfm/${f}`, 'utf8');
    for (const m of s.matchAll(/<span class="month">(\w+)<\/span>\s*<span class="day">(\d+)<\/span>\s*<span class="year">(\d+)<\/span>[\s\S]*?<h2><a [^>]*>([^<]*) at /g)) {
      const d = iso(new Date(Date.UTC(+m[3], MONTHS[m[1]], +m[2])));
      out.set(d, [...(out.get(d) ?? []), strip(m[4])]);
    }
  }
  return out;
}

/** attendance assumed where no count is published, by kind of event (persons) */
const ASSUMED = {
  arenaConcert: 15000, // about five-sixths of Chase Center's 18,064 basketball seats; arena concerts and comedy
  arenaSmall: 6000, // college and high-school basketball, the G League, summer league, family shows
  stadiumConcert: 38000, // a stadium concert at Oracle Park (41,915 seats for baseball)
  bgcaShow: 7000, // Bill Graham Civic Auditorium holds about 8,500 standing
  warriorsPreseason: 17000,
  valkyries: 18064, // every 2026 home game sold out
};
/** major conventions at Moscone (in-person attendance as the organizers or the trade press published it) */
const CONVENTIONS: { name: string; days: string[]; attendees: number; source: string }[] = [
  { name: 'Dreamforce 2025', days: ['2025-10-14', '2025-10-15', '2025-10-16'], attendees: 40000, source: 'Salesforce via KTVU/Hoodline, Oct. 2025: nearly 50,000 attendees, over 40,000 in person' },
  { name: 'TechCrunch Disrupt 2025', days: ['2025-10-27', '2025-10-28', '2025-10-29'], attendees: 10000, source: 'TechCrunch, Oct. 2025: 10,000 attendees at Moscone West' },
  { name: 'Microsoft Ignite 2025', days: ['2025-11-18', '2025-11-19', '2025-11-20', '2025-11-21'], attendees: 20000, source: 'Microsoft, Nov. 2025: more than 20,000 in person' },
  { name: 'GDC Festival of Gaming 2026', days: ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'], attendees: 20000, source: 'Informa/GDC, Mar. 13, 2026: more than 20,000 attendees' },
  { name: 'RSAC 2026 Conference', days: ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26'], attendees: 43500, source: 'RSAC closing release, Mar. 27, 2026: 43,500+ attendees' },
  { name: 'Snowflake Summit 2026', days: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'], attendees: 20000, source: 'Snowflake, June 2026: more than 20,000 in person' },
  { name: 'Data + AI Summit 2026', days: ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18'], attendees: 30000, source: 'Databricks, June 2026: about 30,000 in person' },
  { name: 'Dreamforce 2026', days: ['2026-09-15', '2026-09-16', '2026-09-17'], attendees: 40000, source: 'Salesforce, Sept. 2026: over 40,000 in person' },
];
/** share of a convention's attendees present on each of its days (assumed) */
const CONVENTION_DAILY = 0.75;

const events: Ev[] = [];
// ---- Giants: home games at Oracle Park, 2026 season (the whole season falls in the window) ----
for (const r of srRows('giants-2026-schedule.html')) {
  if (r.homeORvis === '@' || !r.attendance) continue;
  const date = srDate(r.date_game, 2026);
  if (!inWindow(date)) continue;
  events.push({ date, venue: 'Oracle Park', event: `Giants v ${r.opp_ID}`, kind: r.day_or_night === 'D' ? 'day' : 'evening', attendance: Number(r.attendance.replace(/,/g, '')), source: 'Baseball-Reference' });
}
// ---- Warriors: 2025-26 regular season and play-in home games ----
const warriorsHome = new Set<string>();
for (const r of srRows('warriors-2025-26-games.html')) {
  if (r.game_location === '@' || !r.attendance) continue;
  const date = srDate(r.date_game);
  warriorsHome.add(date);
  if (inWindow(date)) events.push({ date, venue: 'Chase Center', event: `Warriors v ${r.opp_name}`, kind: 'evening', attendance: Number(r.attendance.replace(/,/g, '')), source: 'Basketball-Reference' });
}
// ---- Valkyries: 2026 home games, regular season and playoffs ----
for (const t of ['teams_games', 'teams_games_playoffs'])
  for (const r of srRows('valkyries-2026-games.html', t)) {
    if (r.game_location === '@' || !r.game_result) continue;
    const date = srDate(r.date_game);
    if (inWindow(date)) events.push({ date, venue: 'Chase Center', event: `Valkyries v ${r.opp_name}${t.endsWith('playoffs') ? ' (playoffs)' : ''}`, kind: 'evening', attendance: ASSUMED.valkyries, source: 'Basketball-Reference; sold out (WNBA)' });
  }
// ---- Chase Center's other events (DoTheBay, with setlist.fm's concerts) ----
const SKIP = /pa+rking|open practice|ticket giveaway|nba finals|souvenir|replica|valkyries|^golden state warriors vs/i;
const chaseOther = new Map<string, string>();
for (const e of doTheBay('chase-center')) {
  if (!inWindow(e.date)) continue;
  if (/^golden state warriors vs/i.test(e.title) && !warriorsHome.has(e.date) && e.date < '2025-10-21')
    events.push({ date: e.date, venue: 'Chase Center', event: `Warriors preseason: ${e.title}`, kind: 'evening', attendance: ASSUMED.warriorsPreseason, source: 'DoTheBay listing; attendance assumed' });
  if (SKIP.test(e.title)) continue;
  if (!chaseOther.has(e.date)) chaseOther.set(e.date, e.title);
}
for (const [d, artists] of setlistFm('chase-center-san-francisco-ca-usa-4bd3f3f2'))
  if (inWindow(d) && !chaseOther.has(d) && !warriorsHome.has(d)) chaseOther.set(d, artists.join(', '));
const SMALL = /classic|legacy|bruce-mahoney|santa cruz warriors|globetrotters|monster truck|disney/i;
const gameDays = new Set(events.filter((e) => e.venue === 'Chase Center').map((e) => e.date));
for (const [date, title] of chaseOther)
  if (!gameDays.has(date)) events.push({ date, venue: 'Chase Center', event: title, kind: 'concert', attendance: SMALL.test(title) ? ASSUMED.arenaSmall : ASSUMED.arenaConcert, source: 'DoTheBay/setlist.fm listing; attendance assumed' });
// ---- Oracle Park's other events: stadium concerts (the rest are small: tours, golf, a tent show) ----
for (const e of doTheBay('oracle-park'))
  if (inWindow(e.date) && /noah kahan|fuerza regida/i.test(e.title))
    events.push({ date: e.date, venue: 'Oracle Park', event: e.title, kind: 'concert', attendance: ASSUMED.stadiumConcert, source: 'DoTheBay listing; attendance assumed' });
// ---- Bill Graham Civic Auditorium ----
const bg = new Map<string, string>();
for (const e of doTheBay('bill-graham-civic-auditorium')) if (inWindow(e.date) && !bg.has(e.date)) bg.set(e.date, e.title);
for (const [date, title] of bg) events.push({ date, venue: 'Bill Graham Civic Auditorium', event: title, kind: 'concert', attendance: ASSUMED.bgcaShow, source: 'DoTheBay listing; attendance assumed' });
// ---- conventions at Moscone ----
for (const c of CONVENTIONS)
  for (const date of c.days) if (inWindow(date)) events.push({ date, venue: 'Moscone Center', event: c.name, kind: 'convention', attendance: Math.round(c.attendees * CONVENTION_DAILY), source: c.source });

events.sort((a, b) => a.date.localeCompare(b.date) || a.venue.localeCompare(b.venue));
const wk = events.filter((e) => weekday(e.date));

// ---- averages: each month's weekday attendance over its weekdays, then the mean of the twelve months ----
const months: string[] = [];
const weekdaysIn: Record<string, number> = {};
for (let d = new Date(`${FROM}T12:00:00Z`); iso(d) <= TO; d.setUTCDate(d.getUTCDate() + 1)) {
  const m = iso(d).slice(0, 7);
  if (!months.includes(m)) months.push(m);
  if (weekday(iso(d))) weekdaysIn[m] = (weekdaysIn[m] ?? 0) + 1;
}
const venues = ['Oracle Park', 'Chase Center', 'Bill Graham Civic Auditorium', 'Moscone Center'];
const KINDS: Kind[] = ['evening', 'concert', 'day', 'convention'];
const r0 = (x: number) => Math.round(x);
function avg(filter: (e: Ev) => boolean, only?: string) {
  const ms = only ? [only] : months;
  let s = 0;
  for (const m of ms) s += wk.filter((e) => e.date.startsWith(m) && filter(e)).reduce((a, e) => a + e.attendance, 0) / weekdaysIn[m];
  return s / ms.length;
}
const byVenue = venues.map((v) => {
  const slots = KINDS.map((k) => {
    const f = (e: Ev) => e.venue === v && e.kind === k;
    const days = wk.filter(f);
    if (!days.length) return null;
    return { kind: k, weekdayEvents: days.length, weekdayAttendance: days.reduce((a, e) => a + e.attendance, 0), year: r0(avg(f)), aug2026: r0(avg(f, '2026-08')), sep2026: r0(avg(f, '2026-09')) };
  }).filter(Boolean);
  return { name: v, slots };
});
const byGroup = (re: RegExp) => r0(avg((e) => re.test(e.event)));
const groups = {
  giants: byGroup(/^Giants v/),
  warriors: byGroup(/^Warriors/),
  valkyries: byGroup(/^Valkyries/),
  chaseOther: r0(avg((e) => e.venue === 'Chase Center' && e.kind === 'concert')),
  oracleOther: r0(avg((e) => e.venue === 'Oracle Park' && e.kind === 'concert')),
  billGraham: r0(avg((e) => e.venue === 'Bill Graham Civic Auditorium')),
  moscone: r0(avg((e) => e.venue === 'Moscone Center')),
  all: r0(avg(() => true)),
  allAug2026: r0(avg(() => true, '2026-08')),
};
const byMonth = Object.fromEntries(months.map((m) => [m, { weekdays: weekdaysIn[m], attendeesPerWeekday: r0(avg(() => true, m)), giants: r0(avg((e) => /^Giants v/.test(e.event), m)), chase: r0(avg((e) => e.venue === 'Chase Center', m)) }]));

// ---- how attendees travel: where they come from and the transit shares the model is fitted to ----
/**
 * Where attendees live, percent (Warriors Event Center SEIR, 2015, Table 5.2-23, basketball game
 * "all other" column: San Francisco by MTC superdistrict, 1 downtown and the northeast, 2 the north
 * and west (Richmond to Hayes Valley), 3 the Mission and the southeast, 4 the Sunset; East Bay = Alameda and Contra Costa; North Bay = Marin, Sonoma, Napa, Solano; South
 * Bay = San Mateo and Santa Clara; from the Warriors' market study and season-ticket survey). No
 * published split exists for Giants fans, so Oracle Park and Bill Graham Civic Auditorium take the
 * arena's. Out-of-region attendees are taken to stay in hotels. Conventions: the SEIR's convention
 * column (from the Moscone Center operator, Moscone Expansion EIR), its superdistrict-1 share (55%,
 * downtown, with the hotels) and out-of-region 10% taken as hotel guests.
 */
const ORIGINS = {
  arena: { hotel: 4.0, sd: [11.1, 3.4, 4.2, 3.3], east: 33.0, north: 13.0, south: 28.0 },
  convention: { hotel: 65.0, sd: [0, 5.0, 5.0, 5.0], east: 7.5, north: 2.5, south: 10.0 },
};
/**
 * Straight from work. FHWA's case study of Pacific Bell Park's first season: 28% of weeknight and 32%
 * of weekday-afternoon fans came directly from work. SF residents' workplaces are in the city at the
 * ACS rate (82.5%); attendees from the rest of the region come from a workplace in the city at the
 * rate that reproduces the SEIR's weekday-inbound column, which moves 7.3 points of attendees from
 * the region into San Francisco (29.3% inbound against 22.0% resident): 7.3 / 74 = 9.9% at night,
 * scaled by 32/28 for day games. Concerts (8 pm) are taken as evening games; conventions: none.
 */
const FROM_WORK = {
  evening: { sf: 0.28 * 0.825, region: 0.073 / 0.74 },
  concert: { sf: 0.28 * 0.825, region: 0.073 / 0.74 },
  day: { sf: 0.32 * 0.825, region: ((0.073 / 0.74) * 32) / 28 },
  convention: { sf: 0, region: 0 },
};
/**
 * Transit's share of attendees' trips, which a transit constant per venue is fitted to (calibrate.ts,
 * experiment.ts --refit). Oracle Park: the Giants' 2012 survey, weekday games 45% transit, 38% auto,
 * 17% walking and other (SEIR footnote 39). Chase Center: the SEIR and transportation management
 * plan's 35% for weekday peak events (a planning share agreed with SFMTA, with an auto ceiling of
 * 53%; no observed survey is published). The others have no survey and no constant of their own.
 */
const TRANSIT_SHARE: Record<string, number> = { 'Oracle Park': 0.45, 'Chase Center': 0.35 };
const VENUE_AT: Record<string, { lat: number; lon: number; origins: keyof typeof ORIGINS }> = {
  'Oracle Park': { lat: 37.7786, lon: -122.3893, origins: 'arena' },
  'Chase Center': { lat: 37.768, lon: -122.3877, origins: 'arena' },
  'Bill Graham Civic Auditorium': { lat: 37.7782, lon: -122.4174, origins: 'arena' },
  'Moscone Center': { lat: 37.7842, lon: -122.4016, origins: 'convention' },
};
const SOURCES = [
  { id: 'giants', title: 'Baseball-Reference, 2026 San Francisco Giants schedule and results', url: 'https://www.baseball-reference.com/teams/SFG/2026-schedule-scores.shtml', raw: 'data/beta3/raw/events/giants-2026-schedule.html' },
  { id: 'warriors', title: 'Basketball-Reference, 2025-26 Golden State Warriors schedule and results', url: 'https://www.basketball-reference.com/teams/GSW/2026_games.html', raw: 'data/beta3/raw/events/warriors-2025-26-games.html' },
  { id: 'valkyries', title: 'Basketball-Reference, 2026 Golden State Valkyries schedule and results; Valkyries/WNBA, Sept. 2026: every home game sold out (22, 397,408; 18,064 a game)', url: 'https://www.basketball-reference.com/wnba/teams/GSV/2026_games.html', raw: 'data/beta3/raw/events/valkyries-2026-games.html' },
  { id: 'dothebay', title: 'DoTheBay, past events at Chase Center, Oracle Park, and Bill Graham Civic Auditorium', url: 'https://dothebay.com/venues/chase-center/past_events', raw: 'data/beta3/raw/events/dothebay/' },
  { id: 'setlistfm', title: 'setlist.fm, Chase Center concert listings', url: 'https://www.setlist.fm/venue/chase-center-san-francisco-ca-usa-4bd3f3f2.html', raw: 'data/beta3/raw/events/setlistfm/' },
  { id: 'gswSeir', title: 'OCII and San Francisco Planning, Event Center and Mixed-Use Development at Mission Bay Blocks 29-32, Draft SEIR, June 2015, Section 5.2 (Tables 5.2-23 to 5.2-26 and footnote 39: the Giants 2012 survey)', url: 'https://sfocii.org/sites/default/files/inline-files/Vol%201_GSW_MB_DSEIR.pdf', raw: 'data/beta3/raw/events/gsw-dseir-vol1.pdf' },
  { id: 'gswTmp', title: 'Golden State Warriors, Final Transportation Management Plan for the San Francisco Event Center, December 2015 (Table 5-2 origins; 53% weekday auto ceiling; 35% transit service plan)', url: 'https://www.sfmta.com/sites/default/files/reports-and-documents/2019/03/transportation_mgt_plan_12_2015_002_5118.pdf', raw: 'data/beta3/raw/events/chase-center-tmp-2015.pdf' },
  { id: 'sfmtaChase', title: 'SFMTA, Chase Center Transportation Overview (Port MCAC presentation), July 2019: special T Third service, 16th Street BART and Van Ness shuttles', url: 'https://www.sfport.com/sites/default/files/Maritime/Maritime%20Commerce%20Advisory%20Committee/Documents/Chase%20Center%20Transportation%20Plan%20071819.pdf', raw: 'data/beta3/raw/events/chase-center-transportation-overview-2019.pdf' },
  { id: 'fhwaPacBell', title: 'FHWA, Mitigating Traffic Congestion: The Role of Demand-Side Strategies, case study: Pacific Bell Park (50% non-auto in the first season; 28% of weeknight and 32% of weekday fans came from work)', url: 'https://ops.fhwa.dot.gov/publications/mitig_traf_cong/pac_bell_case.htm' },
];
const model = {
  origins: ORIGINS,
  fromWork: FROM_WORK,
  venues: byVenue.map((v) => ({
    name: v.name,
    ...VENUE_AT[v.name],
    transitShare: TRANSIT_SHARE[v.name] ?? null,
    slots: v.slots.map((s) => ({ kind: s!.kind, year: s!.year, aug2026: s!.aug2026 })),
  })),
};

const file = `${REFERENCE}/special-events.json`;
const out = {
  description:
    'Crowds at San Francisco\'s big venues on an average weekday, October 2025 to September 2026 (the twelve months Muni\'s route counts average), as a special generator (built by server/beta3/pipeline/events.ts; bundled as header.events; used by shared/beta3/demand.ts). Each attendee makes a trip to the venue and one back. An average weekday is each month\'s weekday event attendance over its weekdays (holidays included, as SFMTA and BART average), then the mean of the twelve months; August 2026, the month of the BART counts, is given separately.',
  accessed: '2026-10-05',
  period: { from: FROM, to: TO, weekdays: Object.values(weekdaysIn).reduce((a, v) => a + v, 0) },
  averageWeekday: groups,
  venues: byVenue,
  model,
  byMonth,
  assumedAttendance: ASSUMED,
  conventionDailyShare: CONVENTION_DAILY,
  conventions: CONVENTIONS,
  sources: SOURCES,
  calendar: events.map((e) => ({ ...e, weekday: weekday(e.date) })),
};
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`${events.length} events, ${wk.length} on weekdays; average weekday attendees:`, groups);
for (const v of byVenue) console.log(v.name, JSON.stringify(v.slots));
console.log(JSON.stringify(byMonth));
