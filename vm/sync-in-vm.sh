#!/usr/bin/env bash
# The VM half of vm/sync.sh; the board's Sync button runs it too. Fetches every repo from GitHub, moves the board to
# the latest of its branch when no step is running (a restart would kill it), and makes sure the board is up.
# In braces so bash reads it all first: the checkout below can replace this file while it runs.
{
set -euo pipefail
colonia=/home/smudgee/Projects/colonia lane=$colonia/frankenstein branch=main
board=localhost:4111
# Everything below also goes to the log the board's sidebar shows.
mkdir -p "$lane/mastra/.data/logs" ~/.cache/factory
exec > >(tee "$lane/mastra/.data/logs/sync.log") 2>&1
echo "sync started $(date '+%H:%M:%S')"

for r in frankenstein agents client supabase; do git -C "$colonia/$r" fetch -q --prune origin && echo "fetched $r"; done

# The agents' skills are read from this checkout; it follows origin/main, and is left alone if it can't fast-forward.
git -C "$colonia/agents" merge -q --ff-only origin/main 2>/dev/null || echo "agents: can't fast-forward to origin/main; left at $(git -C "$colonia/agents" rev-parse --short HEAD)"

# UAT builds its database from this checkout's migrations, so it follows GitHub exactly, rewritten history included.
# Nobody works in the VM's copy; one with uncommitted changes is left alone and said so.
db=$colonia/supabase/staging old=$(git -C "$db" rev-parse --short HEAD)
if [ -n "$(git -C "$db" status --porcelain)" ]; then
  echo "supabase staging has uncommitted changes: left at $old"
elif [ "$(git -C "$db" rev-parse HEAD)" != "$(git -C "$db" rev-parse origin/staging)" ]; then
  git -C "$db" reset -q --hard origin/staging
  echo "supabase staging moved $old → $(git -C "$db" rev-parse --short HEAD) (the old commit stays in its reflog)"
fi

up() { curl -sf "$board/api/workflows" >/dev/null; }
have=$(git -C "$lane" rev-parse HEAD) want=$(git -C "$lane" rev-parse "origin/$branch")
if [ "$have" = "$want" ]; then
  echo "board code is current (${want:0:7})"
elif up && curl -sf "$board/board/data" | grep -q '"executing":true'; then
  echo "board code ${want:0:7} waits: a step is running, and a restart would stop it. Sync again once it stops."
else
  git -C "$lane" checkout -q --detach "$want"
  # One pnpm workspace (the root and mastra/), its node and pnpm pinned in mise.toml.
  git -C "$lane" diff --quiet "$have" "$want" -- pnpm-lock.yaml mise.toml ||
    (cd "$lane" && mise trust -q && mise install -q && mise exec -- pnpm install --frozen-lockfile --silent)
  # Bracketed patterns, so pgrep never matches a command line that merely mentions them. Wait for the processes to
  # end, not just the port: a server that has stopped answering but not exited would stop the start below.
  # Under pnpm the server is `node …/mastra/dist/index.js dev`, its `sh -c … mastra dev` only a wrapper: stopping just
  # the wrapper left it holding the dev-server lock, and no new board could start.
  server='[m]astra dev|[m]astra/dist/index[.]js dev|[.]mastra/output/index[.]mjs'
  if pgrep -f "$server" >/dev/null; then
    pkill -f "$server"
    for _ in $(seq 30); do pgrep -f "$server" >/dev/null || break; sleep 1; done
    # A server that stopped answering can ignore SIGTERM and keep the dev-server lock; then no new board starts.
    if pgrep -f "$server" >/dev/null; then pkill -KILL -f "$server"; sleep 1; fi
  fi
  echo "board code moved to ${want:0:7} ($(git -C "$lane" log -1 --format=%s))"
fi

if ! up; then
  # setsid -f: the server gets its own session and no shell waits on it (one that did held this output open).
  pgrep -f '[m]astra dev' >/dev/null || (cd "$lane/mastra" && setsid -f mise exec -- pnpm run dev > .data/studio.log 2>&1 < /dev/null)
  for _ in $(seq 120); do up && break; sleep 1; done
  up || { echo "board did not start; its log ends:"; tail -20 "$lane/mastra/.data/studio.log"; exit 1; }
  echo "board started"
fi
date -Is > ~/.cache/factory/vm-synced
set +e # a login shell runs ~/.bash_logout on exit, whose clear_console fails with no terminal
exit 0
}
