#!/usr/bin/env bash
# Inside the untrusted app container. The trusted kit supplies Node, pnpm and its offline store.
set -euo pipefail
cd /work
export ENV=production NUXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 NUXT_PUBLIC_SUPABASE_KEY="$ANON" NUXT_SUPABASE_SECRET_KEY="$SERVICE" SUPABASE_URL=http://127.0.0.1:55321 PAGE_URL=http://127.0.0.1:3000 STUDIO_GITHUB_TOKEN=test-only
if [[ $1 == build ]]; then
  tar -xf /project.tar
  pnpm install --offline --frozen-lockfile --ignore-scripts
  pnpm --config.dangerouslyAllowAllBuilds=true rebuild better-sqlite3
  mkdir -p node_modules/.cache/nuxt/fonts; cp -r /fonts/. node_modules/.cache/nuxt/fonts/
  exec pnpm build
fi
export NUXT_RESEND_API_KEY=uat-local-only-key RESEND_BASE_URL=http://127.0.0.1:55354 NUXT_FUEL_CARD_COMPLETION_TOKEN_SECRET=uat-local-only-secret-not-for-production NITRO_PORT=3000
exec node -r /local-dns.cjs .output/server/index.mjs
