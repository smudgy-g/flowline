#!/usr/bin/env bash
# Trusted runner image supplies /opt/factory/node_modules, chromium, curl and psql.
set -euo pipefail
cd /opt/factory
cp -r /inputs/. .
export UAT_RUN_DIR=$(mktemp -d) UAT_PLAYWRIGHT_REPORT
export UAT_PLAYWRIGHT_REPORT="$UAT_RUN_DIR/playwright.json"
node scripts/mock-dns.mjs >&2 &
node scripts/fake-resend.mjs >&2 &
for n in {1..60}; do curl -fsS --max-time 2 http://127.0.0.1:3000/ >/dev/null && break; sleep 1; done
curl -fsS --max-time 2 http://127.0.0.1:3000/ >/dev/null
node node_modules/@playwright/test/cli.js test --config playwright.config.mjs >&2 || :
curl -fsS http://127.0.0.1:55354/received >"$UAT_RUN_DIR/received-emails.json"
for entry in 'home /' 'category /mieten/lkw' 'offer /mieten/angebot/e0000000-0000-4000-8000-000000000003'; do
  read -r name path <<<"$entry"
  node node_modules/lighthouse/cli/index.js "http://127.0.0.1:3000$path" --only-categories=accessibility,seo --chrome-path=/usr/bin/chromium --chrome-flags='--headless --no-sandbox --disable-dev-shm-usage' --output=json --output-path="$UAT_RUN_DIR/lighthouse-$name.json" --quiet >&2 || :
done
exec node scripts/summarize.mjs "$UAT_RUN_DIR" "$1" "$2"
