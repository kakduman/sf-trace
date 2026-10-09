/**
 * Services inside the city that publish timetables but no GTFS: UCSF's campus shuttles and the
 * Treasure Island Ferry (server/beta3/reference/sf-shuttles.json says which, why, and from where);
 * and the Presidio Trust's PresidiGo Downtown route, from its own GTFS. Reads the UCSF route pages
 * saved in data/beta3/raw/shuttle (each a weekday timetable: one row per trip, one column per stop),
 * PresidiGo's feed (data/beta3/raw/presidigo, fetch-data.ts), and the ferry's departures in the
 * reference file, and writes them as one GTFS feed, data/beta3/raw/shuttle/shuttles.gtfs.zip, for
 * transit.ts (feed 'shuttle'). Mission Bay TMA publishes its own GTFS (feed 'tma').
 *
 * Fetch the pages first (curl, User-Agent "interchange-beta3 (transit model research)"):
 *   https://campuslifeserviceshome.ucsf.edu/transportation/<route>-route-shuttle-schedule → ucsf-<route>.html
 *   (Lime: lime-route-shuttle-service)
 * Run: npx tsx server/beta3/pipeline/shuttles.ts
 */
import fs from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { RAW, REFERENCE } from './paths';

const REF = JSON.parse(fs.readFileSync(`${REFERENCE}/sf-shuttles.json`, 'utf8'));
const DIR = `${RAW}/shuttle`;

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** "5:43 AM" (optionally followed by a note) → seconds after midnight */
function clock(s: string): number | null {
  const m = /^(\d{1,2}):(\d\d)\s*([AP])M/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return h * 3600 + Number(m[2]) * 60;
}
const hms = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:00`;

interface StopRow { id: string; name: string; lat: number; lon: number }
interface TripRow { route: string; trip: string; dir?: number; service?: 'WKD' | 'WE'; shape?: string; calls: { stop: string; t: number; noOn?: boolean; noOff?: boolean }[] }

/** a CSV file of a GTFS feed (quoted fields allowed) */
function gtfsCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    f = '',
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') (row.push(f), (f = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      if (row.some((x) => x !== '')) rows.push(row);
      (row = []), (f = '');
    } else f += c;
  }
  if (f !== '' || row.length) (row.push(f), rows.push(row));
  const [head, ...body] = rows;
  const H = head.map((h) => h.replace(/^\uFEFF/, '').trim());
  return body.map((r) => Object.fromEntries(H.map((h, i) => [h, r[i] ?? ''])));
}
const secs = (t: string) => {
  const [h, m, x] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (x || 0);
};

export interface PresidiGoRef {
  /** the feed's route for Downtown */
  routeId: string;
  /** feed stop id → the model's stop key (pg:<key>) */
  stopKeys: Record<string, string>;
  /** downtown stops that only pick up toward the Presidio (the Trust's rule; the feed marks only the set-downs) */
  pickUpOnly: string[];
  /** pass trips: weekday loops leaving the Transit Center before this hour, and those leaving downtown (stop `downtownStop`) at these hours */
  passBefore: number;
  passDowntown: number[];
  downtownStop: string;
}

/**
 * PresidiGo Downtown from the Trust's GTFS: stops at the feed's locations, its shape, and every
 * weekday and weekend trip. Weekday trips that need a Presidio GO pass (Presidio residents and
 * employees) become a route of their own, 'pg-DTP', which build.ts restricts.
 */
export function presidiGoFromGtfs(zip: Uint8Array, ref: PresidiGoRef) {
  const files = unzipSync(zip);
  const txt = (f: string) => (files[f] ? gtfsCsv(strFromU8(files[f])) : []);
  const svc = new Map(txt('calendar.txt').map((c) => [c.service_id, c]));
  const stopRows = new Map(txt('stops.txt').map((r) => [r.stop_id, r]));
  const trips = txt('trips.txt').filter((t) => t.route_id === ref.routeId);
  const times = new Map<string, Record<string, string>[]>();
  for (const r of txt('stop_times.txt')) if (trips.some((t) => t.trip_id === r.trip_id)) (times.get(r.trip_id) ?? times.set(r.trip_id, []).get(r.trip_id)!).push(r);
  const stops = new Map<string, StopRow>();
  const shapes = new Map<string, [number, number, number][]>();
  for (const r of txt('shapes.txt')) if (trips.some((t) => t.shape_id === r.shape_id)) (shapes.get(r.shape_id) ?? shapes.set(r.shape_id, []).get(r.shape_id)!).push([Number(r.shape_pt_lat), Number(r.shape_pt_lon), Number(r.shape_pt_sequence)]);
  for (const s of shapes.values()) s.sort((a, b) => a[2] - b[2]);
  const out: TripRow[] = [];
  for (const t of trips) {
    const c = svc.get(t.service_id);
    if (!c) continue;
    const weekday = c.monday === '1' && c.wednesday === '1';
    const weekend = c.saturday === '1' || c.sunday === '1';
    if (!weekday && !weekend) continue;
    const st = (times.get(t.trip_id) ?? []).sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    const calls: TripRow['calls'] = st.map((r) => {
      const key = ref.stopKeys[r.stop_id];
      if (!key) throw new Error(`PresidiGo stop ${r.stop_id} (${stopRows.get(r.stop_id)?.stop_name}) has no key in sf-shuttles.json`);
      const s = stopRows.get(r.stop_id)!;
      if (!stops.has(`pg:${key}`)) stops.set(`pg:${key}`, { id: `pg:${key}`, name: `PresidiGo ${s.stop_name.replace(/\s*\((Drop Off|Pick Up)\)/i, '').replace(/\s+(Drop Off|Pick Up)\)/i, ')').replace(/\s*\((inbound|outbound)\)/i, '').trim()}`, lat: Number(s.stop_lat), lon: Number(s.stop_lon) });
      return { stop: `pg:${key}`, t: secs(r.departure_time || r.arrival_time), noOn: r.pickup_type === '1', noOff: r.drop_off_type === '1' || ref.pickUpOnly.includes(key) };
    });
    if (calls.length < 2) continue;
    const t0 = calls[0].t;
    const down = calls.find((x) => x.stop === `pg:${ref.downtownStop}`)?.t;
    const pass = weekday && (t0 < ref.passBefore * 3600 || (down !== undefined && ref.passDowntown.some((h) => Math.abs(down - h * 3600) <= 300)));
    out.push({ route: pass ? 'pg-DTP' : 'pg-DT', trip: `pg-${t.trip_id}`, service: weekday ? 'WKD' : 'WE', shape: t.shape_id ? `pg-${t.shape_id}` : undefined, calls });
  }
  return { stops, trips: out, shapes: new Map([...shapes].map(([k, v]) => [`pg-${k}`, v])) };
}

function main() {
  const stops = new Map<string, StopRow>();
  const routes: { id: string; agency: string; short: string; long: string; color: string; type?: number }[] = [];
  const trips: TripRow[] = [];

  // ---- UCSF: one timetable table per route page ----
  const U = REF.modeled.ucsf;
  for (const s of U.stops) stops.set(`ucsf:${s.key}`, { id: `ucsf:${s.key}`, name: s.name, lat: s.lat, lon: s.lon });
  const COLOR: Record<string, string> = { Gold: 'c99700', Blue: '1f5fbf', Red: 'c8102e', Grey: '7a7a7a', Bronze: '9c6b30', Lime: '7ab800', Cherry: 'a3195b', Lilac: '9b7fc0' };
  for (const r of U.routes as { route: string }[]) {
    const file = `${DIR}/ucsf-${r.route.toLowerCase()}.html`;
    if (!fs.existsSync(file)) throw new Error(`missing ${file}: fetch the UCSF route page first`);
    const html = fs.readFileSync(file, 'utf8');
    const table = /<table[\s\S]*?<\/table>/.exec(html)?.[0];
    if (!table) throw new Error(`${file}: no timetable`);
    routes.push({ id: `ucsf-${r.route}`, agency: 'ucsf', short: `UCSF ${r.route}`, long: `UCSF ${r.route} shuttle`, color: COLOR[r.route] ?? '666666' });
    let cols: { key: string; noOn: boolean }[] = [];
    let n = 0;
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
      const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) ?? []).map(decode);
      if (!cells.length) continue;
      const first = cells[0];
      // a header row names the stops; a lone cell is a section label (AM, MIDDAY, PM)
      if (cells.length > 1 && !/^(\d{1,2}:\d\d|-|Drop|Canceled|Flag|$)/i.test(first)) {
        cols = cells.map((c) => {
          const s = (U.stops as { key: string; match: string }[]).find((x) => c.replace(/\s+/g, ' ').includes(x.match));
          if (!s) throw new Error(`${r.route}: no stop for column "${c}"`);
          return { key: `ucsf:${s.key}`, noOn: /drop off only/i.test(c) };
        });
        continue;
      }
      if (cells.length < 2 || !cols.length) continue;
      const calls: TripRow['calls'] = [];
      cells.forEach((c, j) => {
        const t = clock(c);
        if (t === null || !cols[j]) return; // '-', blank, 'Drop off only' (the trip has ended), 'Canceled'
        if (calls.length && t < calls[calls.length - 1].t) return;
        calls.push({ stop: cols[j].key, t, noOn: cols[j].noOn });
      });
      if (calls.length >= 2) trips.push({ route: `ucsf-${r.route}`, trip: `ucsf-${r.route}-${++n}`, calls });
    }
    console.log(`UCSF ${r.route}: ${n} weekday trips`);
  }

  // ---- PresidiGo Downtown: the Presidio Trust's GTFS (stops, shape, and trips) ----
  const pgZip = `${RAW}/presidigo/presidigo-gtfs.zip`;
  if (!fs.existsSync(pgZip)) throw new Error(`missing ${pgZip}: run fetch-data.ts`);
  const PG = presidiGoFromGtfs(fs.readFileSync(pgZip), REF.modeled.presidiGo as PresidiGoRef);
  for (const [k, v] of PG.stops) stops.set(k, v);
  routes.push({ id: 'pg-DT', agency: 'presidio', short: 'PresidiGo DT', long: 'PresidiGo Downtown', color: '0b6e4f' });
  routes.push({ id: 'pg-DTP', agency: 'presidio', short: 'PresidiGo DT pass', long: 'PresidiGo Downtown (Presidio pass holders)', color: '0b6e4f' });
  trips.push(...PG.trips);
  const pgW = PG.trips.filter((t) => t.service === 'WKD');
  console.log(`PresidiGo Downtown (GTFS): ${pgW.length} weekday trips (${pgW.filter((t) => t.route === 'pg-DTP').length} for pass holders), ${PG.trips.length - pgW.length} weekend trips`);

  // ---- Treasure Island Ferry: its published weekday departures each way ----
  const F = REF.modeled.tiFerry;
  for (const s of F.stops) stops.set(`tif:${s.key}`, { id: `tif:${s.key}`, name: s.name, lat: s.lat, lon: s.lon });
  routes.push({ id: 'tif', agency: 'tif', short: 'TI Ferry', long: 'Treasure Island Ferry', color: '00629b', type: 4 });
  const hm = (x: string) => Number(x.split(':')[0]) * 3600 + Number(x.split(':')[1]) * 60;
  (F.departTreasureIsland as string[]).forEach((x, i) => trips.push({ route: 'tif', trip: `tif-in-${i + 1}`, dir: 0, calls: [{ stop: 'tif:TI', t: hm(x) }, { stop: 'tif:FB', t: hm(x) + F.runMinutes * 60 }] }));
  (F.departFerryBuilding as string[]).forEach((x, i) => trips.push({ route: 'tif', trip: `tif-out-${i + 1}`, dir: 1, calls: [{ stop: 'tif:FB', t: hm(x) }, { stop: 'tif:TI', t: hm(x) + F.runMinutes * 60 }] }));
  console.log(`Treasure Island Ferry: ${F.departTreasureIsland.length + F.departFerryBuilding.length} weekday trips`);

  // ---- GTFS ----
  const csv = (head: string[], rows: (string | number)[][]) => [head.join(','), ...rows.map((r) => r.map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n') + '\n';
  const files: Record<string, Uint8Array> = {
    'agency.txt': strToU8(csv(['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], [['ucsf', 'UCSF Shuttles', 'https://campuslifeserviceshome.ucsf.edu/transportation', 'America/Los_Angeles'], ['presidio', 'PresidiGo', 'https://presidio.gov/visit/getting-to-and-around-the-park/presidio-go-shuttle', 'America/Los_Angeles'], ['tif', 'Treasure Island Ferry', 'https://www.tisf.com/ferry', 'America/Los_Angeles']])),
    'stops.txt': strToU8(csv(['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], [...stops.values()].map((s) => [s.id, s.name, s.lat, s.lon]))),
    'routes.txt': strToU8(csv(['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'], routes.map((r) => [r.id, r.agency, r.short, r.long, r.type ?? 3, r.color]))),
    'calendar.txt': strToU8(csv(['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], [['WKD', 1, 1, 1, 1, 1, 0, 0, '20250101', '20271231'], ['WE', 0, 0, 0, 0, 0, 1, 1, '20250101', '20271231']])),
    'trips.txt': strToU8(csv(['route_id', 'service_id', 'trip_id', 'direction_id', 'shape_id'], trips.map((t) => [t.route, t.service ?? 'WKD', t.trip, t.dir ?? 0, t.shape ?? '']))),
    'shapes.txt': strToU8(csv(['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], [...PG.shapes].flatMap(([id, pts]) => pts.map(([la, lo], i) => [id, la, lo, i])))),
    'stop_times.txt': strToU8(
      csv(
        ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'],
        trips.flatMap((t) => t.calls.map((c, k) => [t.trip, hms(c.t), hms(c.t), c.stop, k + 1, c.noOn ? 1 : 0, c.noOff ? 1 : 0])),
      ),
    ),
  };
  fs.writeFileSync(`${DIR}/shuttles.gtfs.zip`, zipSync(files));
  console.log(`wrote ${DIR}/shuttles.gtfs.zip: ${stops.size} stops, ${routes.length} routes, ${trips.length} trips`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
