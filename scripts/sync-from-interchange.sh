#!/bin/sh
# Copies SF-TRACE from an interchange checkout into this repo: the code, the tests, the model files,
# facts.json and the reference files, as they are in that checkout's working tree (committed or not).
# Then adapts the pages' links to this repo (scripts/adapt.mjs). Nothing is committed.
#
#   scripts/sync-from-interchange.sh /path/to/interchange-worktree [--force]
#
# Files deleted there are deleted here. Untracked files there are copied only from the pipeline's
# output folders (client/beta3/model/, server/beta3/reference/, client/beta3/paper/facts.json).
set -eu
export LC_ALL=C

SRC=${1:-}
FORCE=${2:-}
HERE=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "$SRC" ] || [ ! -f "$SRC/shared/beta3/params.ts" ]; then
  echo "usage: $0 /path/to/interchange-worktree [--force]" >&2
  exit 1
fi
SRC=$(cd "$SRC" && pwd)

# the folders and files that come from interchange (interchange path, then this repo's path)
DIRS="client/beta3 shared/beta3 server/beta3 wasm"
OUTPUTS="client/beta3/model/ server/beta3/reference/ client/beta3/paper/facts.json"

cd "$HERE"
if [ "$FORCE" != "--force" ] && [ -n "$(git status --porcelain -- client shared server test wasm)" ]; then
  echo "This repo has uncommitted changes in client/, shared/, server/, test/ or wasm/." >&2
  echo "Commit or stash them first, or pass --force to overwrite them." >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# tracked files that exist in the working tree, plus untracked outputs
(
  cd "$SRC"
  git ls-files -c -- $DIRS 'test/beta3*.test.ts' | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done
  git ls-files -o --exclude-standard -- $OUTPUTS
) | sort -u >"$TMP/files"
(cd "$SRC" && git ls-files -o --exclude-standard -- $DIRS 'test/beta3*.test.ts') | sort >"$TMP/untracked"
comm -23 "$TMP/untracked" "$TMP/files" >"$TMP/skipped"

rsync -a --files-from="$TMP/files" "$SRC/" "$HERE/"

# mirror deletions
find $DIRS test -type f -name '*' | grep -E "^($(echo $DIRS | tr ' ' '|'))/|^test/beta3[^/]*\.test\.ts$" | sort >"$TMP/here"
comm -23 "$TMP/here" "$TMP/files" | while IFS= read -r f; do
  rm "$f"
  echo "deleted $f"
done

# the two pages
cp "$SRC/client/beta3.html" client/index.html
mkdir -p client/method
cp "$SRC/client/beta3-method.html" client/method/index.html

node scripts/adapt.mjs

# what may need a hand edit: dependencies and pipeline scripts in interchange's package.json
node -e '
const [src, here] = process.argv.slice(1).map((p) => require(p + "/package.json"));
const deps = (p) => ({ ...p.dependencies, ...p.devDependencies });
const mine = deps(here);
for (const [k, v] of Object.entries(deps(src))) {
  if (mine[k] && mine[k] !== v) console.log(`note: ${k} is ${v} in interchange, ${mine[k]} here`);
  if (!mine[k] && !["ws", "@types/ws", "concurrently"].includes(k)) console.log(`note: interchange depends on ${k} ${v}; add it here if SF-TRACE uses it`);
}
for (const [k, v] of Object.entries(src.scripts)) {
  const m = k.match(/^beta3:(.+)$/);
  if (!m) continue;
  const ours = here.scripts[`model:${m[1]}`];
  if (ours !== v) console.log(`note: script ${k} differs from model:${m[1]} here:\n  ${v}`);
}
if (src.scripts["build:wasm"] !== here.scripts["build:wasm"]) console.log(`note: build:wasm differs:\n  ${src.scripts["build:wasm"]}`);
' "$SRC" "$HERE"

if [ -s "$TMP/skipped" ]; then
  echo "untracked in interchange, not copied:"
  sed 's/^/  /' "$TMP/skipped"
fi
echo
git status --short | head -40
echo
echo "Copied from $SRC ($(cd "$SRC" && git rev-parse --short HEAD) on $(cd "$SRC" && git rev-parse --abbrev-ref HEAD)). Next: npm run typecheck && npm test && npm run build"
