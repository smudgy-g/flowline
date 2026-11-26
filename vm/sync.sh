#!/usr/bin/env bash
# Bring the factory VM up to date. Run on the laptop (`factory-ui` does, each time it opens the board); safe any time.
# Laptop -> VM only, and only what exists nowhere else: Pi and its login, skills, terminal configs, the client's
# local-only workmux configs, the UAT fonts. Code reaches the VM from GitHub: the VM half (sync-in-vm.sh) fetches it.
# vm/bootstrap.sh still creates the VM; this keeps it current.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# The VM's folder, which names the VM and its ssh host. macOS caps socket paths at 104 characters, and devvm's for
# devvm-colonia-factory-vm-<id> came to 104, so the Mac's is short.
if [ "$(uname)" = Darwin ]; then folder=$HOME/Projects/monster; else folder=$HOME/Projects/colonia-factory-vm; fi
host=devvm-$(basename "$folder")
ssh_config=$HOME/.local/share/devvm/ssh_config colonia=/home/smudgee/Projects/colonia
vm() { ssh -F "$ssh_config" "$host" "$@"; }
# rsync sends only what changed; -L copies what links point at (skills and configs link into ~/.claude and dotfiles).
put() { rsync -aL --delete -e "ssh -F $ssh_config" "$@"; }

# Pi's login, settings and extensions, not Pi itself: each side's Pi updates itself (install/, bin/), and the VM's can
# be newer than the laptop's. --update: the VM's Pi may have refreshed its login since; never send an older file over it.
# A factory whose VM logged in to Pi itself (its own Codex account: ~/.config/factory/own-pi-login in the VM) keeps
# that login; this laptop's never goes over it.
own=$(vm 'test -e ~/.config/factory/own-pi-login && echo --exclude=/auth.json' || true)
put --update $own --exclude=/install --exclude=/bin --exclude=sessions --exclude='*.log' --exclude=crashes.json "$HOME/.pi/agent/" "$host:.pi/agent/"
put "$HOME/.agents/skills/" "$host:.agents/skills/"
for c in workmux tmux nvim; do put "$HOME/.config/$c/" "$host:.config/$c/"; done
rsync -aL -e "ssh -F $ssh_config" "$here/bashrc-colonia.sh" "$host:.bashrc.d/colonia.sh"
(cd "$HOME/Projects/colonia/client/staging" && rsync -aL -e "ssh -F $ssh_config" .workmux.yaml .workmux.agent-task.yaml AGENTS.md "$host:$colonia/client/staging/")
put "$HOME/Projects/colonia/frankenstein/.cache/fonts/" "$host:$colonia/frankenstein/.cache/fonts/"
vm "mkdir -p ~/.local/bin && ln -sf ~/.pi/agent/bin/pi ~/.local/bin/pi && mkdir -p ~/.cache/factory && date -Is > ~/.cache/factory/laptop-synced"

# This checkout's copy, so a new version of the VM half runs the first time too.
vm 'bash -l -s' < "$here/sync-in-vm.sh"
