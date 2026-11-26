#!/usr/bin/env bash
# Create the factory VM with devvm and fill it. Run on the laptop (Linux or macOS); safe to run again.
# Before the first run: `devvm secret set github` (fine-grained token) and
#   sudo install -d -o root -g 0 -m 755 <folder below>   (~/Projects/colonia-factory-vm; ~/Projects/monster on macOS)
# A second factory on another laptop: run vm/seed-peer.sh on this one first, then here FACTORY_NAME=monster vm/bootstrap.sh.
# The VM mounts that folder; root-owned and empty, the VM can't write anything there for the laptop to run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export PATH=$HOME/.local/bin:$PATH
# The VM's folder, which names the VM and its ssh host. macOS caps socket paths at 104 characters, and devvm's for
# devvm-colonia-factory-vm-<id> came to 104, so the Mac's is short.
if [ "$(uname)" = Darwin ]; then folder=$HOME/Projects/monster; else folder=$HOME/Projects/colonia-factory-vm; fi
host=devvm-$(basename "$folder")
vm() { ssh -F "$HOME/.local/share/devvm/ssh_config" "$host" "$@"; }

[ "$(ls -ld "$folder" 2>/dev/null | awk '{print $3}')" = root ] || { echo "run first: sudo install -d -o root -g 0 -m 755 $folder" >&2; exit 1; }
mkdir -p "$HOME/.config/devvm/layers"
cp "$here/colonia.sh" "$here/colonia.policy" "$HOME/.config/devvm/layers/"
# A 16 GB M1 keeps some for itself; UAT (Supabase, the Nuxt build, Chromium) is what needs the most.
if [ "$(uname)" = Darwin ]; then cpus=6 memory=10; else cpus=8 memory=16; fi

cd "$folder"
if ! devvm ls | grep -q " $folder\$"; then
  devvm --no-input --no-devcontainer --tools none --agents none --layers docker,colonia \
    --network allowlist --ports none --cpus $cpus --memory $memory --disk 150 </dev/null
  devvm secret use github --no-input
  devvm stop
fi
devvm --no-input </dev/null >/dev/null # start (the secret applies from a start)

# Laptop -> VM only: binaries, Pi (with its login), workmux prefs, UAT fonts cache, git identity.
tar -C "$HOME" --exclude=.pi/agent/sessions --exclude=.pi/agent/skills --exclude='*.log' --exclude=crashes.json -cf - .pi/agent | vm 'tar -C ~ -xf -'
# Pi's skills with links resolved, as sync.sh (rsync -L) sends them: a link can't replace the folder it made there.
tar -C "$HOME" -chf - .pi/agent/skills | vm 'tar -C ~ -xf -'
# Pi itself: the VM's own managed install. On a second laptop vm/seed-peer.sh brings one (with arm64 Linux builds).
seeded=$HOME/.cache/factory
if [ -f "$seeded/pi-install.tar" ]; then vm 'tar -C ~ -xf -' < "$seeded/pi-install.tar"; fi
vm 'mkdir -p ~/.local/bin && ln -sf ~/.pi/agent/bin/pi ~/.local/bin/pi'
# The factory's Anthropic key (planner, Codex fallback) lives only in the VM: a seeded copy moves in and goes.
if [ -f "$seeded/anthropic-api-key" ]; then
  vm 'umask 077 && mkdir -p ~/.config/factory && cat > ~/.config/factory/anthropic-api-key' < "$seeded/anthropic-api-key" && rm "$seeded/anthropic-api-key"
fi
# More than one factory: each has a name; its runs label their issues factory:<name> (ops.ts).
if [ -n "${FACTORY_NAME:-}" ]; then vm "mkdir -p ~/.config/factory && echo '$FACTORY_NAME' > ~/.config/factory/name"; fi
# Your terminal setup: workmux, tmux and Neovim configs (the tools come from colonia.sh; LazyVim fetches its plugins from GitHub), plus the aliases.
tar -C "$HOME" -chf - .config/workmux .config/tmux .config/nvim | vm 'tar -C ~ -xf -'
vm 'cat > ~/.bashrc.d/colonia.sh' < "$here/bashrc-colonia.sh"
# User-level skills Pi loads (grill-with-docs, to-prd, goldfish-*, …); links resolved, since most point into ~/.claude.
tar -C "$HOME" -chf - .agents/skills | vm 'rm -rf ~/.agents/skills && tar -C ~ -xf -'
# The factory's git identity: vm/seed-peer.sh's copy on a second laptop, else this laptop's own.
if [ -f "$seeded/git-identity" ]; then { read -r git_name; read -r git_email; } < "$seeded/git-identity"
else git_name=$(git config --global user.name) git_email=$(git config --global user.email); fi
vm "git config --global user.name '$git_name' && git config --global user.email '$git_email' && git config --global init.defaultBranch main"

# Inside the VM: the four repos over HTTPS (devvm's proxy adds the token), laid out as on the laptop.
vm 'bash -s' <<'EOF'
set -euo pipefail
eval "$(mise env -s bash)"; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd /home/smudgee/Projects/colonia
gh_url() { echo "https://github.com/ColoniaTech/colonia_$1.git"; }
[ -d frankenstein ] || git clone -q https://github.com/ColoniaTech/frankenstein.git frankenstein
[ -d agents ] || git clone -q "$(gh_url agents)" agents
for r in client supabase; do
  if [ ! -d $r/.bare ]; then
    git clone -q --bare "$(gh_url $r)" $r/.bare
    git -C $r/.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    git -C $r/.bare fetch -q origin
    echo 'gitdir: ./.bare' > $r/.git
  fi
  [ -d $r/staging ] || git -C $r/.bare worktree add -q ../staging staging
  git -C $r/staging branch -q --set-upstream-to=origin/staging staging # a bare clone records no tracking; pull needs it
done
mkdir -p client/worktrees
(cd frankenstein && mise trust -q && mise install -q && mise exec -- pnpm install --frozen-lockfile >/dev/null)
(cd client/staging && mise trust -q && mise install -q) # the client's own node and pnpm (its mise.toml)
(cd client/staging && pnpm fetch --ignore-scripts >/dev/null) # fills the store that worktrees install from offline
EOF
# Client's local-only (gitignored) workmux configs; the factory provisions task worktrees from them.
tar -C "$HOME/Projects/colonia/client/staging" -cf - .workmux.yaml .workmux.agent-task.yaml AGENTS.md | vm 'tar -C /home/smudgee/Projects/colonia/client/staging -xf - && cd /home/smudgee/Projects/colonia/client && { grep -qx .workmux.yaml .bare/info/exclude || echo .workmux.yaml >> .bare/info/exclude; }'
tar -C "$HOME/Projects/colonia/frankenstein/.cache" -cf - fonts | vm 'mkdir -p /home/smudgee/Projects/colonia/frankenstein/.cache && tar -C /home/smudgee/Projects/colonia/frankenstein/.cache -xf -'
echo "Ready. Open the board with: factory-ui"
