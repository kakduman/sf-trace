// Adapts files copied from the interchange repo (where the app is served at /beta3 and the
// methodology at /beta3/method) to this repo's static site, where the app is index.html and the
// methodology is method/index.html under any base path. Run by sync-from-interchange.sh; running it
// again changes nothing. Fails if an absolute /beta3 link is left in client/, or a /Users/ path anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const code = (dir) => walk(dir).filter((f) => /\.(ts|html|md|py)$/.test(f));

const paper = (f) => f.startsWith('client/beta3/paper/') || f === 'client/method/index.html';

/** [pattern, replacement] pairs; strings are replaced everywhere they occur */
const METHOD_PAGE = [
  [' at <a href="/beta3">/beta3</a>', ''],
  ['href="/beta3/method#', 'href="#'],
  ['href="/beta3/method"', 'href="./"'],
  ['href="/beta3"', 'href="../"'],
  ['src="/beta3/paper/main.ts"', 'src="../beta3/paper/main.ts"'],
];
const APP_PAGE = [
  ['href="/beta3/method', 'href="method/'],
  ['href="/beta3"', 'href="./"'],
];
/** the research scripts' absolute paths to the author's checkout, made relative to the repo */
const PYTHON = [[/'\/Users\/[^/']+\/git\/interchange(?=[/'])/g, "os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..') + '"]];
const EVERYWHERE = [
  ['github.com/kakduman/interchange', 'github.com/kakduman/sf-trace'],
  [/\bbeta3:(fetch|build|calibrate|runmodes)\b/g, 'model:$1'],
];

const files = ['client/index.html', 'client/method/index.html', ...code('client/beta3'), ...code('shared/beta3'), ...code('server/beta3/pipeline')];
let changed = 0;
for (const f of files) {
  const file = path.join(ROOT, f);
  const before = fs.readFileSync(file, 'utf8');
  let s = before;
  const rules = [...(f.startsWith('client/') ? (paper(f) ? METHOD_PAGE : APP_PAGE) : []), ...(f.endsWith('.py') ? PYTHON : []), ...EVERYWHERE];
  for (const [a, b] of rules) s = typeof a === 'string' ? s.split(a).join(b) : s.replace(a, b);
  if (s !== before) {
    fs.writeFileSync(file, s);
    changed++;
    console.log(`adapted ${f}`);
  }
}

const left = files
  .filter((f) => f.startsWith('client/'))
  .flatMap((f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/(?:href|src)=["'`]\/beta3[^"'`]*/g)].map((m) => `${f}: ${m[0]}`));
const text = ['client', 'shared', 'server', 'test', 'wasm'].flatMap(walk).filter((f) => /\.(ts|mjs|js|html|css|md|py|sh|json|csv|txt)$/.test(f));
left.push(...text.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('/Users/')).map((f) => `${f}: an absolute /Users/ path`));
if (left.length) {
  console.error(`left to adapt (add a rule to scripts/adapt.mjs):\n  ${left.join('\n  ')}`);
  process.exit(1);
}
console.log(`${changed} file(s) adapted`);
