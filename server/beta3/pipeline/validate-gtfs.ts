/**
 * Data-quality check of the schedule inputs with MobilityData's canonical GTFS validator
 * (https://github.com/MobilityData/gtfs-validator, v8.0.1 CLI, needs Java). Summarises each feed's
 * notices by severity into server/beta3/reference/gtfs-validation.json.
 * Run: npx tsx server/beta3/pipeline/validate-gtfs.ts
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { RAW, REFERENCE } from './paths';

const JAR_URL = 'https://github.com/MobilityData/gtfs-validator/releases/download/v8.0.1/gtfs-validator-8.0.1-cli.jar';
const FEEDS = ['muni', 'bart', 'caltrain', 'ggt', 'ferry', 'ac', 'samtrans'];

async function main() {
  const jar = `${RAW}/gtfs-validator-8.0.1-cli.jar`;
  if (!fs.existsSync(jar)) fs.writeFileSync(jar, Buffer.from(await (await fetch(JAR_URL)).arrayBuffer()));
  const out: Record<string, unknown> = {};
  for (const f of FEEDS) {
    const dir = `${RAW}/gtfs-validation/${f}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      execFileSync('java', ['-Xmx1500m', '-jar', jar, '-i', `${RAW}/gtfs/${f}.zip`, '-o', dir, '-t', '2'], { stdio: 'pipe', timeout: 900_000 });
    } catch (e) {
      out[f] = { error: String((e as Error).message).slice(0, 300) };
      continue;
    }
    const rep = JSON.parse(fs.readFileSync(`${dir}/report.json`, 'utf8'));
    const bySeverity: Record<string, number> = {};
    const top: { code: string; severity: string; total: number }[] = [];
    for (const n of rep.notices ?? []) {
      bySeverity[n.severity] = (bySeverity[n.severity] ?? 0) + n.totalNotices;
      top.push({ code: n.code, severity: n.severity, total: n.totalNotices });
    }
    top.sort((a, b) => (a.severity === b.severity ? b.total - a.total : a.severity === 'ERROR' ? -1 : b.severity === 'ERROR' ? 1 : a.severity === 'WARNING' ? -1 : 1));
    out[f] = { bySeverity, notices: top.slice(0, 12), validatedAt: rep.summary?.validatedAt, feedInfo: rep.summary?.feedInfo };
    console.log(`${f}: ${JSON.stringify(bySeverity)}`);
  }
  fs.writeFileSync(`${REFERENCE}/gtfs-validation.json`, JSON.stringify({ validator: 'MobilityData gtfs-validator 8.0.1', url: JAR_URL, accessed: new Date().toISOString().slice(0, 10), feeds: out }, null, 1));
}

main();
