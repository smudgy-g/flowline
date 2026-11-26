#!/usr/bin/env bash
set -euo pipefail
mode=$1; shift
: "${WT:?}" "${ROOT:?}" "${INPUTS:?}" "${ANON:?}" "${SERVICE:?}"
sockdir=$(mktemp -d /tmp/colonia-uat-sock-XXXXXX)
socat "UNIX-LISTEN:$sockdir/supabase.sock,fork,unlink-early" TCP:127.0.0.1:55321 & proxy=$!
trap 'kill "$proxy" 2>/dev/null || :; rm -rf "$sockdir"' EXIT
export mode sockdir
bwrap --unshare-net --dev-bind / / --proc /proc -- bash -c '
  set -euo pipefail
  socat TCP-LISTEN:55321,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:"$sockdir/supabase.sock" & forward=$!
  trap '\''kill "$forward" "${server:-}" "${dns:-}" "${resend:-}" 2>/dev/null || :; wait "${server:-}" 2>/dev/null || :'\'' EXIT
  cd "$WT"
  if [ "$mode" = build ]; then
    env -i HOME="$HOME" PATH="$PATH" NODE_OPTIONS=--max-old-space-size=8192 ENV=production NUXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 NUXT_PUBLIC_SUPABASE_KEY="$ANON" NUXT_SUPABASE_SECRET_KEY="$SERVICE" SUPABASE_URL=http://127.0.0.1:55321 PAGE_URL=http://127.0.0.1:3000 STUDIO_GITHUB_TOKEN=test-only pnpm build
    exit
  fi
  node "$ROOT/scripts/mock-dns.mjs" & dns=$!
  node "$ROOT/scripts/fake-resend.mjs" & resend=$!
  env -i HOME="$HOME" PATH="$PATH" ENV=production NUXT_RESEND_API_KEY=uat-local-only-key RESEND_BASE_URL=http://127.0.0.1:55354 NUXT_FUEL_CARD_COMPLETION_TOKEN_SECRET=uat-local-only-secret-not-for-production NUXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 NUXT_PUBLIC_SUPABASE_KEY="$ANON" NUXT_SUPABASE_SECRET_KEY="$SERVICE" SUPABASE_URL=http://127.0.0.1:55321 PAGE_URL=http://127.0.0.1:3000 STUDIO_GITHUB_TOKEN=test-only NITRO_PORT=3000 node -r "$ROOT/scripts/local-dns.cjs" .output/server/index.mjs & server=$!
  for n in {1..60}; do if node -e '\''fetch("http://127.0.0.1:3000/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'\''; then break; fi; sleep 1; done
  kill -0 "$server" && node -e '\''fetch("http://127.0.0.1:3000/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'\''
  cd "$ROOT"
  if [ "$mode" = test ]; then
    result=0
    node node_modules/@playwright/test/cli.js test --config "$INPUTS/playwright.config.mjs" || result=$?
    node -e '\''fetch("http://127.0.0.1:55354/received").then(r=>r.text()).then(s=>require("node:fs").writeFileSync(process.env.UAT_RUN_DIR+"/received-emails.json",s))'\''
    exit "$result"
  fi
  if [ "$mode" = lighthouse ]; then
    for entry in "home /" "category /mieten/lkw" "offer /mieten/angebot/e0000000-0000-4000-8000-000000000003"; do
      read -r name path <<<"$entry"
      node node_modules/lighthouse/cli/index.js "http://127.0.0.1:3000$path" --only-categories=accessibility,seo --chrome-path=/usr/bin/chromium --chrome-flags="--headless --no-sandbox --disable-dev-shm-usage" --output=json --output-path="$UAT_RUN_DIR/lighthouse-$name.json" --quiet
    done
    exit
  fi
  echo "unsupported sandbox mode: $mode" >&2; exit 2
'
