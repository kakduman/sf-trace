/**
 * Saved runs: finished scenario runs kept in this browser (IndexedDB) with the scenario each was
 * run for, and written to or read from a file. A record and a file hold the same bytes: the result's
 * parts (shared/beta3/results.ts) and the scenario in one gzipped container, without the crowding
 * and lot prices a run keeps for warm starts (only today's network's are used for those).
 *
 * The browser may clear this storage (Safari does after a week without a visit), so a saved run is
 * a convenience: its scenario can always be run again, and a file keeps it for good.
 */
import { Gunzip, gzipSync } from 'fflate';
import { decodeBundle, encodeBundle } from '../../shared/beta3/bundle';
import { resultFromParts, resultParts } from '../../shared/beta3/results';
import type { RunMode } from '../../shared/beta3/runmode';
import { TPERIODS, type BundleHeader, type DayType, type RunResult, type Scenario } from '../../shared/beta3/types';

export const RUN_FILE_EXT = '.sftrace';
const RUN_FILE_FORMAT = 'sf-trace-run';
const RUN_FILE_VERSION = 1;
/** the most a run unpacks to (one with traffic is about 6 MB) */
export const MAX_RUN_BYTES = 64 * 2 ** 20;

/** a finished run and the scenario it was run for (its day and run mode included) */
export interface SavedRun {
  scenario: Scenario;
  result: RunResult;
  savedAt: number;
}

/** what the list of saved runs shows, without reading the results */
export interface SavedRunMeta {
  id: string;
  /** the scenario's key (state.ts editsKey): a run saved again for the same key replaces the old one */
  key: string;
  name: string;
  day: DayType;
  runMode: RunMode;
  /** the model bundle that made it: a run from another one can't be compared with today's network */
  bundleId?: string;
  savedAt: number;
  /** when it was saved or last opened (retention counts from this) */
  usedAt: number;
  /** kept by the user: never removed by the retention policy */
  kept: boolean;
  /** stored size in bytes */
  size: number;
  /** change in transit trips against today's network, for the list */
  dTrips?: number;
}

// ---------- the file format ----------

/** the run without what is only needed for warm starts (finalCrowd, finalLotPrice) */
export function slimResult(r: RunResult): RunResult {
  const { finalCrowd: _c, finalLotPrice: _l, ...rest } = r;
  void _c, _l;
  return rest;
}

export function encodeRunFile(run: SavedRun): Uint8Array {
  const { header, arrays } = resultParts(slimResult(run.result));
  const h = { format: RUN_FILE_FORMAT, v: RUN_FILE_VERSION, savedAt: run.savedAt, scenario: run.scenario, result: header };
  return gzipSync(encodeBundle(h as unknown as Omit<BundleHeader, 'arrays'>, arrays), { level: 6 });
}

/**
 * Unpack gzip a little at a time, stopping past `max` bytes: a small file can unpack to gigabytes
 * (deflate packs up to about 1,000 to 1), so its own size says little.
 */
export function gunzipCapped(bytes: Uint8Array, max = MAX_RUN_BYTES): Uint8Array {
  const parts: Uint8Array[] = [];
  let n = 0;
  const g = new Gunzip((c) => {
    n += c.length;
    if (n > max) throw new Error('too large');
    parts.push(c);
  });
  // (each 4 KB pushed unpacks to at most about 4 MB)
  for (let i = 0; i < bytes.length; i += 4096) g.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) out.set(p, off), (off += p.length);
  return out;
}

/** read a saved run; throws an Error saying what is wrong with a file that isn't one */
export function decodeRunFile(bytes: Uint8Array): SavedRun {
  let header: Record<string, unknown>, a: Record<string, unknown>;
  try {
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipCapped(bytes) : bytes;
    const b = decodeBundle(raw);
    header = b.header as unknown as Record<string, unknown>;
    a = b.a;
  } catch {
    throw new Error('This file is not a saved SF-TRACE run.');
  }
  if (header.format !== RUN_FILE_FORMAT) throw new Error('This file is not a saved SF-TRACE run.');
  if (typeof header.v !== 'number' || header.v > RUN_FILE_VERSION) throw new Error('This run was saved by a newer version of SF-TRACE. Reload the page and try again.');
  const r = header.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object' || !Array.isArray(r.lines) || !r.summary || !plainData(r)) throw new Error('This saved run is damaged.');
  for (const k of ['stopOn', 'stopOff', 'zoneTransitShare', 'zoneJobs45', 'zoneLogsum']) if (!(a[k] instanceof Float32Array)) throw new Error('This saved run is damaged.');
  if (!header.scenario || typeof header.scenario !== 'object') throw new Error('This saved run has no scenario.');
  return { scenario: header.scenario as Scenario, result: resultFromParts(r, a), savedAt: typeof header.savedAt === 'number' ? header.savedAt : Date.now() };
}

/**
 * The result's JSON as the panels expect it: strings only where they show text (escaped there),
 * numbers everywhere else, and plain keys. A file can come from anyone; the panels print numbers
 * as they are.
 */
const TEXT_KEYS = new Set(['scenario', 'runMode', 'roadResponse', 'bundleId', 'name', 'period']);
const KEY_RE = /^[\w .:+()/-]{1,60}$/;
function plainData(x: unknown, key = '', depth = 0): boolean {
  if (depth > 8) return false;
  if (x === null || typeof x === 'boolean') return true;
  if (typeof x === 'number') return true;
  if (typeof x === 'string') return TEXT_KEYS.has(key) && x.length <= 200;
  if (Array.isArray(x)) return x.every((v) => plainData(v, key, depth + 1));
  if (typeof x === 'object') return Object.entries(x as object).every(([k, v]) => KEY_RE.test(k) && plainData(v, k, depth + 1));
  return false;
}

/**
 * Does x have every field `ref` has, of the same kind? Typed arrays of the same type; each item of
 * an array like the first of ref's; fields ref lacks are allowed (the panels look up today's fields
 * in a scenario's result, so a missing one throws while an extra one is never read).
 */
export function hasShape(ref: unknown, x: unknown, depth = 0): boolean {
  if (ref === undefined || ref === null || depth > 10) return true;
  if (ArrayBuffer.isView(ref)) return x instanceof (ref.constructor as new () => unknown);
  if (Array.isArray(ref)) return Array.isArray(x) && (!ref.length || x.every((v) => hasShape(ref[0], v, depth + 1)));
  if (typeof ref === 'object') return !!x && typeof x === 'object' && !Array.isArray(x) && Object.entries(ref).every(([k, v]) => hasShape(v, (x as Record<string, unknown>)[k], depth + 1));
  return typeof x === typeof ref;
}

const per = <T>(v: T) => Object.fromEntries(TPERIODS.map((p) => [p, v]));
const ROADS = { vmt: per(0), vht: per(0), delay: per(0), vehicles: per(0), speed: { all: per(0), freeway: per(0), arterial: per(0) } };
const TRIP = { name: '', period: '', base: 0, scenario: 0 };
/** what the driving panels read of a run's traffic (ui/driving.ts) */
const TRAFFIC = { flow: per(new Float32Array(0)), time: per(new Float32Array(0)), summary: ROADS, base: ROADS, trips: [TRIP], changes: [{ name: '', base: 0, scenario: 0 }] };

/**
 * Can the panels show this result next to `base` (today's network, same day and run mode, from the
 * model loaded)? Its arrays are this model's sizes, its lines are the model's or the scenario's new
 * ones, and it has every field today's result has, and what the driving panels read.
 */
export function resultFits(r: RunResult, base: RunResult, model: { lines: number; newLines: number }): boolean {
  const { finalCrowd: _c, finalLotPrice: _l, traffic: _t, ...ref } = base;
  void _c, _l, _t;
  if (!hasShape(ref, r)) return false;
  if (r.stopOn.length < base.stopOn.length || r.stopOff.length !== r.stopOn.length) return false;
  if ((['zoneTransitShare', 'zoneJobs45', 'zoneLogsum'] as const).some((k) => r[k].length !== base[k].length)) return false;
  // (scenario lines drawn both ways have two results, -1 - k each)
  if (!r.lines.every((l) => Number.isInteger(l.line) && l.line < model.lines && l.line >= -model.newLines)) return false;
  const T = r.traffic;
  if (T) {
    if (!hasShape(TRAFFIC, T) || !(T.corridorTrips === undefined || hasShape([TRIP], T.corridorTrips))) return false;
    if (![...T.trips, ...(T.corridorTrips ?? [])].every((t) => (TPERIODS as readonly string[]).includes(t.period))) return false;
    for (const s of [T.summary, T.base]) if (s.peninsula && !Object.values(s.peninsula).every((v) => hasShape({ vmt: per(0), vht: per(0) }, v))) return false;
  }
  return true;
}

/** a file name for a run: its scenario's name, day, and run mode */
export function runFileName(s: Scenario): string {
  const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'scenario';
  return `${slug}-${s.day ?? 'wkd'}-${s.runMode ?? 'precise'}${RUN_FILE_EXT}`;
}

/** hand the browser a file to save */
export function downloadFile(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------- retention ----------

/**
 * Kept runs stay until the user removes them. The others are the recent runs: the last
 * `recent` saved or opened, each for at most `days` since then.
 */
export const RETENTION = { recent: 12, days: 60 };
const DAY_MS = 86_400_000;

/** the runs the retention policy removes */
export function toEvict(runs: SavedRunMeta[], now: number, policy = RETENTION): string[] {
  return runs
    .filter((r) => !r.kept)
    .sort((a, b) => b.usedAt - a.usedAt)
    .filter((r, i) => i >= policy.recent || now - r.usedAt > policy.days * DAY_MS)
    .map((r) => r.id);
}

// ---------- IndexedDB ----------

const DB_NAME = 'sf-trace';
const DB_VERSION = 1;
/** metadata by id (indexed by scenario key) and the run's bytes by id, so the list reads no results */
const META = 'runs', FILES = 'files';

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser does not keep saved runs.'));
    const q = indexedDB.open(DB_NAME, DB_VERSION);
    q.onupgradeneeded = () => {
      const d = q.result;
      d.createObjectStore(META, { keyPath: 'id' }).createIndex('key', 'key');
      d.createObjectStore(FILES);
    };
    q.onsuccess = () => {
      const d = q.result;
      // another tab with a newer version of the page wants to upgrade: let it
      d.onversionchange = () => {
        d.close();
        dbp = null;
      };
      resolve(d);
    };
    q.onerror = () => reject(q.error ?? new Error('Saved runs could not be opened.'));
    q.onblocked = () => reject(new Error('Saved runs are in use by another tab of this page.'));
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error ?? new Error('The saved runs could not be updated.'));
  });

/** is this the browser's storage being full */
export const isQuotaError = (e: unknown) => e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

/** the saved runs, most recently used first */
export async function listRuns(): Promise<SavedRunMeta[]> {
  const d = await db();
  const all = await req(d.transaction(META).objectStore(META).getAll() as IDBRequest<SavedRunMeta[]>);
  return all.sort((a, b) => b.usedAt - a.usedAt);
}

async function removeIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  const t = d.transaction([META, FILES], 'readwrite');
  for (const id of ids) {
    t.objectStore(META).delete(id);
    t.objectStore(FILES).delete(id);
  }
  await done(t);
}

export const deleteRun = (id: string) => removeIds([id]);

/** apply the retention policy; returns the runs left */
export async function prune(now = Date.now()): Promise<SavedRunMeta[]> {
  const all = await listRuns();
  const gone = new Set(toEvict(all, now));
  await removeIds([...gone]);
  return all.filter((r) => !gone.has(r.id));
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/**
 * Save a run. One for the same scenario key from the same model replaces it (staying kept if it
 * was). When the browser's storage is full, the oldest recent runs make room, then it gives up.
 */
export async function saveRun(run: SavedRun, opts: { key: string; dTrips?: number; kept?: boolean }): Promise<SavedRunMeta> {
  const bytes = encodeRunFile(run);
  const d = await db();
  const same = (await req(d.transaction(META).objectStore(META).index('key').getAll(opts.key) as IDBRequest<SavedRunMeta[]>)).find((m) => m.bundleId === run.result.bundleId);
  const now = Date.now();
  const meta: SavedRunMeta = {
    id: same?.id ?? newId(),
    key: opts.key,
    name: run.scenario.name,
    day: run.scenario.day ?? 'wkd',
    runMode: run.scenario.runMode ?? run.result.runMode ?? 'precise',
    bundleId: run.result.bundleId,
    savedAt: run.savedAt,
    usedAt: now,
    kept: opts.kept ?? same?.kept ?? false,
    size: bytes.byteLength,
    ...(opts.dTrips !== undefined ? { dTrips: opts.dTrips } : {}),
  };
  for (;;) {
    try {
      const t = d.transaction([META, FILES], 'readwrite');
      t.objectStore(META).put(meta);
      t.objectStore(FILES).put(bytes, meta.id);
      await done(t);
      break;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      const oldest = (await listRuns()).filter((r) => !r.kept && r.id !== meta.id).pop();
      if (!oldest) throw e;
      await deleteRun(oldest.id);
    }
  }
  await prune(now);
  return meta;
}

/** a saved run's bytes (the file's) and its record, marked as just used */
export async function readRun(id: string): Promise<{ meta: SavedRunMeta; bytes: Uint8Array } | null> {
  const d = await db();
  const t = d.transaction([META, FILES], 'readwrite');
  const meta = await req(t.objectStore(META).get(id) as IDBRequest<SavedRunMeta | undefined>);
  const bytes = await req(t.objectStore(FILES).get(id) as IDBRequest<Uint8Array | undefined>);
  if (!meta || !bytes) return null;
  t.objectStore(META).put({ ...meta, usedAt: Date.now() });
  await done(t);
  return { meta, bytes };
}

/** the saved run for a scenario key made by this model bundle, if any */
export async function findRun(key: string, bundleId: string): Promise<SavedRunMeta | null> {
  const d = await db();
  const hits = await req(d.transaction(META).objectStore(META).index('key').getAll(key) as IDBRequest<SavedRunMeta[]>);
  return hits.find((m) => m.bundleId === bundleId) ?? null;
}

/** keep a run (or let it go back to the recent ones, counted from now) */
export async function setKept(id: string, kept: boolean): Promise<void> {
  const d = await db();
  const t = d.transaction(META, 'readwrite');
  const meta = await req(t.objectStore(META).get(id) as IDBRequest<SavedRunMeta | undefined>);
  if (meta) t.objectStore(META).put({ ...meta, kept, usedAt: kept ? meta.usedAt : Date.now() });
  await done(t);
  // back with the recent runs, it counts toward their limit
  if (!kept) await prune();
  // ask the browser not to clear the storage under pressure (granted or not, it is only a request)
  if (kept) void navigator.storage?.persist?.().catch(() => {});
}
