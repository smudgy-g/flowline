#!/usr/bin/env bash
# Host launcher only. Never load code or environment from the project checkout.
set -eu
cd "$(dirname "$0")/.."
exec node mastra/src/preview.ts "${1:?Usage: scripts/preview.sh WORK_ITEM}"
