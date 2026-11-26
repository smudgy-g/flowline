#!/usr/bin/env bash
# Prints one hash for everything in the worktree as it is now (tracked and untracked, not ignored): the exact code
# a check judged. factory-pi.mjs records it when the coder's check passes; the gates compare it (src/ops.ts).
set -euo pipefail
index=$(mktemp -u)
trap 'rm -f "$index"' EXIT
# A copy of the real index keeps its stat cache, so only changed files are hashed.
cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || :
GIT_INDEX_FILE=$index git add -A
GIT_INDEX_FILE=$index git write-tree
