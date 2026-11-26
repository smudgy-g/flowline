#!/usr/bin/env bash
# Pinned, trusted adapter. Runs ONLY in a fresh offline microVM. stdout is the verdict.
set -euo pipefail
: "${INPUTS:?}" "${UAT_ASSETS:?}" "${PROJECT_ARCHIVE:?}" "${UAT_REF:?}" "${UAT_COMMIT:?}" "${APP_IMAGE:?}" "${RUNNER_IMAGE:?}"
# Never run this adapter on a worker outside its sbx workspace.
[[ ${FACTORY_OFFLINE_UAT:-} == 1 ]] || { echo 'Use the factory offline UAT sandbox' >&2; exit 2; }
docker load -i "$UAT_ASSETS/images.tar" >&2
# The operator supplies the offline DB configuration (ports 55321–55328, migrations and seeds).
db=$(mktemp -d); cp -r "$UAT_ASSETS/supabase" "$db/supabase"
supabase --workdir "$db" start --exclude studio,imgproxy,realtime,postgres-meta,edge-runtime,logflare,vector,supavisor >&2
status=$(supabase --workdir "$db" status -o json)
export ANON=$(jq -er .ANON_KEY <<<"$status") SERVICE=$(jq -er .SERVICE_ROLE_KEY <<<"$status")
runner=(docker run --rm --pull never --network host -v "$INPUTS:/inputs:ro" "$RUNNER_IMAGE")
"${runner[@]}" env PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55322 -U postgres -d postgres -f /inputs/seeds/uat.sql >&2
# The project never receives the Docker socket, runner mounts, browser outputs, or factory home.
app=(docker run --pull never --cap-drop ALL --security-opt no-new-privileges --network host -v app-work:/work -e ANON -e SERVICE -v "$INPUTS/scripts/uat-app.sh:/entry:ro" -v "$INPUTS/scripts/local-dns.cjs:/local-dns.cjs:ro")
set +e
"${app[@]}" --rm -v "$PROJECT_ARCHIVE:/project.tar:ro" -v "$UAT_ASSETS/fonts:/fonts:ro" "$APP_IMAGE" bash /entry build >&2
code=$?
set -e
if [[ $code != 0 ]]; then
  [[ $code != 125 && $code != 126 && $code != 127 && $code != 137 ]] || exit "$code"
  jq -n --arg ref "$UAT_REF" --arg commit "$UAT_COMMIT" '{ref:$ref,commit:$commit,pass:false,failure:"build",error:"offline application build failed"}'; exit
fi
"${app[@]}" -d --name app "$APP_IMAGE" bash /entry serve >&2
"${runner[@]}" bash /inputs/scripts/uat-browser.sh "$UAT_REF" "$UAT_COMMIT"
