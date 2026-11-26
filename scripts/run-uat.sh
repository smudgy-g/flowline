#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLIENT=/home/smudgee/Projects/colonia/client/.bare
SUPABASE_SOURCE=/home/smudgee/Projects/colonia/supabase/staging/supabase
# An empty Docker config: in the factory VM the default one injects devvm's egress proxy into every
# container, and Supabase's busybox health checks then send localhost through it and fail.
supabase_cli() {
  mkdir -p "$ROOT/.cache/docker-noproxy"
  if [ -n "${SUPABASE_BIN:-}" ]; then DOCKER_CONFIG="$ROOT/.cache/docker-noproxy" "$SUPABASE_BIN" "$@"
  else DOCKER_CONFIG="$ROOT/.cache/docker-noproxy" "$ROOT/node_modules/.bin/supabase" "$@"; fi
}
REF=${1:?Usage: scripts/run-uat.sh <client-git-ref> <factory-commit>}
INPUTS_COMMIT=${2:?Usage: scripts/run-uat.sh <client-git-ref> <factory-commit>}
: "${UAT_INPUTS:?UAT_INPUTS lists the factory paths a run reads}"
mkdir -p "$ROOT/.cache"
exec 9>"$ROOT/.cache/uat.lock"
# One UAT at a time on these isolated ports: a second approval waits its turn instead of failing.
flock 9
RUN=$(mktemp -d "$ROOT/.cache/run-XXXXXX")
# Specs, seeds, Lighthouse baseline and summarizer come from one pinned factory commit, never the working tree.
INPUTS=$RUN/inputs
export UAT_RUN_DIR=$RUN UAT_PLAYWRIGHT_REPORT=$RUN/playwright.json ROOT INPUTS
printf '%s\n' "$RUN/report.json"
TEMP=$(mktemp -d /tmp/colonia-uat-XXXXXX)
WT=$(mktemp -d "$ROOT/.cache/client-uat-XXXXXX"); rmdir "$WT"
PROJECT=colonia_uat_$(basename "$TEMP" | tr 'A-Z-' 'a-z_')
started=0; checked_out=0; phase=setup
cleanup() {
  if [ "$checked_out" = 1 ]; then git -C "$CLIENT" worktree remove --force "$WT" >&2 || :; fi
  if [ "$started" = 1 ] && grep -Fxq "project_id = \"$PROJECT\"" "$TEMP/supabase/config.toml"; then
    supabase_cli --workdir "$TEMP" stop --project-id "$PROJECT" --no-backup >&2 || :
  fi
  rm -rf -- "$TEMP"
  rm -f -- "$RUN/status.json" "$RUN/status.err"
  if [ ! -s "$RUN/report.json" ]; then
    jq -n --arg ref "$REF" --arg commit "$(test -s "$RUN/commit" && head -1 "$RUN/commit" || echo unknown)" --arg phase "$phase" '{ref:$ref,commit:$commit,pass:false,failure:"infrastructure",error:"UAT \($phase) failed before a verdict; inspect run logs"}' > "$RUN/report.json"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if ! commit=$(git -C "$CLIENT" rev-parse --verify --end-of-options "$REF^{commit}"); then echo 'Invalid client git ref' >&2; exit 2; fi
printf '%s\n' "$commit" > "$RUN/commit"
mkdir "$INPUTS"
# shellcheck disable=SC2086 # UAT_INPUTS is a space-separated path list
git -C "$ROOT" archive "$INPUTS_COMMIT" -- $UAT_INPUTS | tar -x -C "$INPUTS"
cp -a "$SUPABASE_SOURCE" "$TEMP/supabase"
python - "$TEMP/supabase/config.toml" "$PROJECT" <<'PY'
import sys
p, project = sys.argv[1:]
s = open(p).read().replace('project_id = "colonia_supabase"',f'project_id = "{project}"')
for n in range(54321, 54329): s = s.replace(f'port = {n}',f'port = {n+1000}')
open(p, 'w').write(s)
PY
started=1
supabase_cli --workdir "$TEMP" start --exclude studio,imgproxy,realtime,postgres-meta,edge-runtime,logflare,vector,supavisor --output env > "$RUN/supabase.log" 2>&1
PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55322 -U postgres -d postgres -f "$INPUTS/seeds/uat.sql" > "$RUN/seed.log" 2>&1
supabase_cli --workdir "$TEMP" status -o json > "$RUN/status.json" 2> "$RUN/status.err"
export ANON SERVICE WT
ANON=$(jq -r .ANON_KEY "$RUN/status.json")
SERVICE=$(jq -r .SERVICE_ROLE_KEY "$RUN/status.json")
git -C "$CLIENT" worktree add --detach "$WT" "$commit" > "$RUN/worktree.log" 2>&1
checked_out=1
(cd "$WT" && pnpm install --offline --frozen-lockfile --ignore-scripts && pnpm --config.dangerouslyAllowAllBuilds=true rebuild better-sqlite3) > "$RUN/install.log" 2>&1
if [ ! -d "$ROOT/.cache/fonts" ]; then cp -a /home/smudgee/Projects/colonia/client/worktrees/fix-seo/node_modules/.cache/nuxt/fonts "$ROOT/.cache/fonts"; fi
mkdir -p "$WT/node_modules/.cache/nuxt"
cp -a "$ROOT/.cache/fonts" "$WT/node_modules/.cache/nuxt/"
phase=build
# Waits for any factory checks to finish first (mastra/src/ops.ts): both together run the VM out of memory.
if ! flock "$ROOT/.cache/heavy.lock" bash "$ROOT/scripts/sandbox.sh" build > "$RUN/build.log" 2>&1; then
  # Killed (out of memory, exit 137) says nothing about the change: report it as UAT's own failure, so it is retried.
  if grep -qE '^Killed$|exit code 137' "$RUN/build.log"; then
    printf '{"ref":%s,"commit":%s,"pass":false,"failure":"infrastructure","error":"production build killed (out of memory)"}\n' "$(jq -Rn --arg v "$REF" '$v')" "$(jq -Rn --arg v "$commit" '$v')" > "$RUN/report.json"
    echo "$RUN/report.json"; exit 1
  fi
  printf '{"ref":%s,"commit":%s,"pass":false,"failure":"build","error":"production build failed"}\n' "$(jq -Rn --arg v "$REF" '$v')" "$(jq -Rn --arg v "$commit" '$v')" > "$RUN/report.json"
  echo "$RUN/report.json"; exit 1
fi
phase=test
bash "$ROOT/scripts/sandbox.sh" test > "$RUN/playwright.log" 2>&1 || :
bash "$ROOT/scripts/sandbox.sh" lighthouse > "$RUN/lighthouse.log" 2>&1 || :
node "$INPUTS/scripts/summarize.mjs" "$RUN" "$REF" "$commit" > "$RUN/report.json"
echo "$RUN/report.json"
node -e 'const r=require(process.argv[1]); process.exit(r.pass || r.knownFailureOnly ? 0 : 1)' "$RUN/report.json"
