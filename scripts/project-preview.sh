#!/usr/bin/env bash
# Preview a client worktree in the factory VM with no real secrets: its own Supabase (staging migrations and
# seeds plus the UAT seed), a fake Resend and test-only tokens. The laptop's wx-preview runs this over ssh and
# forwards the ports to 127.0.0.2, a host with its own cookies in the laptop browser.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[[ ${FACTORY_SANDBOX_PREVIEW:-} == 1 ]] || { echo 'Use scripts/preview.sh on the worker' >&2; exit 2; }
WT=$PWD
HOST=127.0.0.2 APP=3300 API=56321 DBPORT=56322 RESEND=56354
[ -d "$WT" ] || { echo "No worktree $WT" >&2; exit 2; }
[ ! -e "$WT/.env" ] || { echo "$WT has a .env; previews run without real secrets" >&2; exit 2; }
mkdir -p "$ROOT/.cache/docker-noproxy"
exec 9>"$ROOT/.cache/preview.lock"
flock -n 9 || { echo 'A preview is already running' >&2; exit 1; }
supabase() { DOCKER_CONFIG="$ROOT/.cache/docker-noproxy" "$ROOT/node_modules/.bin/supabase" --workdir "$DB" "$@"; }
DB=$(mktemp -d /tmp/colonia-preview-XXXXXX)
cleanup() { trap '' INT TERM HUP PIPE; cd /; if [ -n "${dev:-}" ]; then kill -- "-$dev" 2>/dev/null || :; fi; kill "${resend:-}" 2>/dev/null || :; supabase stop --project-id colonia_preview --no-backup >/dev/null 2>&1 || :; rm -rf -- "$DB"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
# Public test fixtures baked into the project's preview kit; no git or credentials.
cp -r "$ROOT/supabase" "$DB/supabase"
python - "$DB/supabase/config.toml" "http://$HOST:$APP" <<'PY'
import sys
p, site = sys.argv[1:]
s = open(p).read().replace('project_id = "colonia_supabase"', 'project_id = "colonia_preview"')
for n in range(54321, 54329): s = s.replace(f'port = {n}', f'port = {n+2000}')
s = s.replace('site_url = "http://localhost:3000"', f'site_url = "{site}"')
open(p, 'w').write(s)
PY
echo 'Starting the preview database (staging migrations and seeds)...'
# A preview cut off before its cleanup (a dropped ssh) leaves its database running; start from empty.
supabase stop --project-id colonia_preview --no-backup >/dev/null 2>&1 || :
supabase start --exclude studio,imgproxy,realtime,postgres-meta,edge-runtime,logflare,vector,supavisor >/dev/null
PGPASSWORD=postgres psql -qX -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $DBPORT -U postgres -d postgres -f "$ROOT/seeds/uat.sql" >/dev/null
status=$(supabase status -o json 2>/dev/null)
if [ ! -d "$WT/node_modules" ]; then
  (cd "$WT" && pnpm install --offline --frozen-lockfile --ignore-scripts && pnpm --config.dangerouslyAllowAllBuilds=true rebuild better-sqlite3)
fi
mkdir -p "$WT/node_modules/.cache/nuxt"
[ -d "$WT/node_modules/.cache/nuxt/fonts" ] || cp -a "$ROOT/.cache/fonts" "$WT/node_modules/.cache/nuxt/"
FAKE_RESEND_PORT=$RESEND node "$ROOT/scripts/fake-resend.mjs" & resend=$!
echo "Preview of $NAME: http://$HOST:$APP, DKV at http://dkv.localhost:$APP  (log in as supplier@cloud-city.test / password123)"
cd "$WT"
# Its own process group, waited on, so Ctrl-C or a closed terminal stops it and the database at once.
# The VM reaches the internet only through its proxy; without it pnpm waits ~70 s on the registry and fonts fail.
setsid env -i HOME="$HOME" PATH="$PATH" TERM="${TERM:-xterm}" \
  HTTP_PROXY="${HTTP_PROXY:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" NO_PROXY="${NO_PROXY:+$NO_PROXY,}$HOST" NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-}" \
  http_proxy="${http_proxy:-}" https_proxy="${https_proxy:-}" no_proxy="${no_proxy:+$no_proxy,}$HOST" ENV=development NUXT_TELEMETRY_DISABLED=1 \
  NUXT_PUBLIC_SUPABASE_URL=http://$HOST:$API SUPABASE_URL=http://$HOST:$API \
  NUXT_PUBLIC_SUPABASE_KEY="$(jq -r .ANON_KEY <<<"$status")" NUXT_SUPABASE_SECRET_KEY="$(jq -r .SERVICE_ROLE_KEY <<<"$status")" \
  NUXT_RESEND_API_KEY=preview-local-only-key RESEND_BASE_URL=http://127.0.0.1:$RESEND \
  NUXT_FUEL_CARD_COMPLETION_TOKEN_SECRET=preview-local-only-secret PAGE_URL=http://$HOST:$APP STUDIO_GITHUB_TOKEN=test-only \
  pnpm exec nuxi dev --host 127.0.0.1 --port $APP & dev=$!
wait "$dev"
