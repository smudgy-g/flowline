#!/usr/bin/env bash
# Acceptance for the widget basket: black-box checks of the published `total` against the pushed commit.
# Runs in a sandbox with no network, so the toolchain comes from $ASSETS, never a download.
set -euo pipefail

work=$(mktemp -d "$HOME/acceptance-XXXXXX")
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/node" "$work/project"
tar -xzf "$ASSETS/node-linux-x64.tar.gz" -C "$work/node" --strip-components=1
tar -xf "$PROJECT_ARCHIVE" -C "$work/project"
export PATH="$work/node/bin:$PATH"
echo "node $(node -v), commit $COMMIT on $REF" >&2

cat > "$work/check.mjs" <<'JS'
import assert from 'node:assert/strict'
const { total } = await import(`${process.env.PROJECT}/src/total.js`)
const basket = [{ price: 20, qty: 4 }, { price: 10, qty: 2 }]   // 100
assert.equal(total(basket, 10), 90, 'ten percent off a basket of 100')
assert.equal(total(basket), 100, 'no discount keeps the old total')
assert.equal(total(basket, 0), 100, 'a zero discount keeps the old total')
assert.equal(total(basket, 100), 0, 'a full discount is allowed')
for (const bad of [-1, 101]) assert.throws(() => total(basket, bad), `a ${bad}% discount is rejected`)
JS

if detail=$(PROJECT="$work/project" node "$work/check.mjs" 2>&1); then
  detail='Basket totals, discounts and rejected discounts all behave as specified'
  pass=true
else
  pass=false
fi
echo "$detail" >&2
node -e 'process.stdout.write(JSON.stringify({ commit: process.env.COMMIT, pass: process.argv[1] === "true", detail: process.argv[2].slice(-500) || "no detail" }) + "\n")' "$pass" "$detail"
