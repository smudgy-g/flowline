#!/usr/bin/env bash
# Gives a second laptop (the M1) what its factory VM needs that exists only here and in this factory's VM. Run on
# this laptop, once, before vm/bootstrap.sh on the other one:  vm/seed-peer.sh <ssh host of the other laptop>
# Its own files win: anything it already has (its Pi login, its configs) is left alone.
set -euo pipefail
peer=${1:?usage: vm/seed-peer.sh <ssh host of the other laptop>}
here=$(cd "$(dirname "$0")" && pwd)
ssh_config=$HOME/.local/share/devvm/ssh_config host=devvm-colonia-factory-vm
vm() { ssh -F "$ssh_config" "$host" "$@"; }
put() { rsync -aL --ignore-existing "$@"; }

ssh "$peer" 'mkdir -p ~/.pi/agent ~/.agents/skills ~/.config ~/.cache/factory ~/Projects/colonia/client/staging'
# This checkout, so the other laptop needs no GitHub access of its own (its VM clones from GitHub through devvm).
rsync -a --exclude=node_modules --exclude=/.cache --exclude=/mastra/.data --exclude=/mastra/.mastra "$here/../" "$peer:Projects/colonia/frankenstein/"
ssh "$peer" 'mkdir -p ~/Projects/colonia/frankenstein/.cache'

# Pi as this VM runs it: a managed install with arm64 Linux builds (this laptop's own Pi is an x86 binary).
# bootstrap.sh unpacks it into the new VM.
vm 'tar -C ~ -cf - .pi/agent/install .pi/agent/bin' | ssh "$peer" 'cat > ~/.cache/factory/pi-install.tar'
# The factory's Anthropic key (planner, Codex fallback): bootstrap.sh moves it into the VM and deletes this copy.
vm 'cat ~/.config/factory/anthropic-api-key' | ssh "$peer" 'umask 077 && cat > ~/.cache/factory/anthropic-api-key'

# The factory's git identity (its commits and PRs), not whatever the other laptop's own git uses.
vm 'printf "%s\n%s\n" "$(git config --global user.name)" "$(git config --global user.email)"' | ssh "$peer" 'cat > ~/.cache/factory/git-identity'

put --exclude=/install --exclude=/bin --exclude=sessions --exclude='*.log' --exclude=crashes.json "$HOME/.pi/agent/" "$peer:.pi/agent/"
put "$HOME/.agents/skills/" "$peer:.agents/skills/"
for c in workmux tmux nvim; do put "$HOME/.config/$c" "$peer:.config/"; done
(cd "$HOME/Projects/colonia/client/staging" && rsync -aL .workmux.yaml .workmux.agent-task.yaml AGENTS.md "$peer:Projects/colonia/client/staging/")
rsync -a "$here/../.cache/fonts" "$peer:Projects/colonia/frankenstein/.cache/"

cat <<EOF
Seeded $peer. On it:
  devvm secret set github        (a fine-grained token, as on this laptop)
  sudo install -d -o root -g 0 -m 755 ~/Projects/monster
  FACTORY_NAME=monster ~/Projects/colonia/frankenstein/vm/bootstrap.sh
  then in ~/.zshrc: source ~/Projects/colonia/frankenstein/vm/factory.zsh, and run factory-ui
Here, in ~/.zshrc above the source line: FACTORY_PEER=$peer
EOF
