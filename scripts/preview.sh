#!/usr/bin/env bash
# Host launcher: runs commands.preview in the work item's sandbox. Never loads project code or environment.
set -eu
cd "$(dirname "$0")/.."
exec node "$(dirname "$0")/../src/preview.ts" "${1:?Usage: scripts/preview.sh WORK_ITEM}"
