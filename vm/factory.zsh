# The factory's laptop commands, for zsh on Linux or macOS. Source it from ~/.zshrc:
#   source ~/Projects/colonia/frankenstein/vm/factory.zsh
# Optional, before the source line:
#   FACTORY_PEER=<ssh host>   a second factory on another machine (the M1): factory-ui tunnels its board to
#                             localhost:4112 and the board shows both factories' cards. That machine runs its own
#                             factory-ui first, so its board is on its localhost:4111.
#   FACTORY_PEER_NAME=<name>  what the board calls it (default monster).

_factory_cfg=~/.local/share/devvm/ssh_config
# The VM's folder names it (bootstrap.sh); the Mac's is short for macOS's socket path limit.
if [[ $OSTYPE == darwin* ]]; then _factory_folder=~/Projects/monster; else _factory_folder=~/Projects/colonia-factory-vm; fi
_factory_host=devvm-${_factory_folder:t}
_factory_tree=/home/smudgee/Projects/colonia

# Starts the VM. After a reboot devvm can take the VM's folder for a new one (btrfs gives it a new device id), so
# adopt it first; that changes nothing when it is already the VM's.
_factory_up() {
  # Over SSH the Mac's login keychain is locked and devvm needs it: ask for the Mac's password once.
  if [[ $OSTYPE == darwin* && -n $SSH_CONNECTION ]] &&
    ! security show-keychain-info ~/Library/Keychains/login.keychain-db >/dev/null 2>&1; then
    security unlock-keychain ~/Library/Keychains/login.keychain-db || return
  fi
  (cd $_factory_folder && devvm adopt --force --no-input >/dev/null 2>&1; devvm --no-input </dev/null >/dev/null)
}
source ${${(%):-%x}:A:h}/vm-lock.sh

# Runs its arguments holding the VM lock, waiting while the watchdog (reanimate.sh) has it.
_factory_locked() {
  if ! factory_try_lock $$; then
    echo "The watchdog is starting the VM; waiting for it…"
    until factory_try_lock $$; do sleep 2; done
  fi
  { "$@" } always { factory_unlock $$ }
}
_factory_sync() { _factory_up && ~/Projects/colonia/frankenstein/vm/sync.sh </dev/null }
_factory_open() { if [[ $OSTYPE == darwin* ]]; then open "$1"; else xdg-open "$1" >/dev/null 2>&1; fi }

function wx-start {
  _factory_locked _factory_up || return
  ssh -t -F $_factory_cfg $_factory_host "bash -lc 'cd $_factory_tree/client/staging && exec tmux new-session -A -s colonia'"
}

function fx-new {
  _factory_locked _factory_up || return
  ssh -t -F $_factory_cfg $_factory_host "bash -lc 'cd $_factory_tree/frankenstein && exec pi'"
}

function fx-shell {
  # A shell in the VM's factory checkout; `fx …` works there.
  _factory_locked _factory_up || return
  ssh -t -F $_factory_cfg $_factory_host "cd $_factory_tree/frankenstein && exec bash -il"
}

function fx {
  # The factory CLI in this machine's VM: fx status 1484, fx retry 1484 --proceed, …
  _factory_locked _factory_up || return
  local cmd="cd $_factory_tree/frankenstein/mastra && pnpm -s fx ${(j: :)${(q)@}}"
  ssh -t -F $_factory_cfg $_factory_host "bash -lc ${(q)cmd}"
}

function monster {
  # Any of these commands on the M1, from this laptop: `monster` opens a shell in its VM, `monster fx retry 1484`.
  [[ -n $FACTORY_PEER ]] || { echo "FACTORY_PEER isn't set"; return 1; }
  local cmd=${(j: :)${(q)@}}
  ssh -t $FACTORY_PEER "zsh -lic ${(q)${cmd:-fx-shell}}"
}

function wx-preview {
  # A worktree in the factory VM with its own seeded Supabase and no real secrets. DKV pages: http://dkv.localhost:3300.
  # The ports go over a background ssh that is closed when the preview ends; an open browser tab can't hold Ctrl-C up.
  # (macOS: 127.0.0.2 needs `sudo ifconfig lo0 alias 127.0.0.2 up` once per boot.)
  local wt=${1:?usage: wx-preview <worktree>}
  local tunnel="-fN -o ExitOnForwardFailure=yes -L 127.0.0.2:3300:"
  pkill -f -- "$tunnel"
  ssh -q -F $_factory_cfg -fN -o ExitOnForwardFailure=yes \
    -L 127.0.0.2:3300:127.0.0.1:3300 -L 127.0.0.1:3300:127.0.0.1:3300 -L 127.0.0.2:56321:127.0.0.1:56321 $_factory_host || return
  echo "Preview: http://127.0.0.2:3300, DKV: http://dkv.localhost:3300 (supplier@cloud-city.test / password123), Ctrl-C to stop"
  { ssh -q -F $_factory_cfg -t $_factory_host "bash -lc '$_factory_tree/frankenstein/scripts/preview.sh $wt'" } always { pkill -f -- "$tunnel" }
}

function factory-ui {
  # The board (and Mastra Studio) at http://localhost:4111/board, served from the VM. Each time it opens it syncs
  # the VM first (vm/sync.sh): your Pi, skills and configs go over, the VM fetches GitHub, updates the board and
  # starts it. `factory-ui sync` only syncs; `factory-ui stop` closes the tunnels. Tunnels stay on 127.0.0.1.
  local tunnel='^ssh .*-L 127.0.0.1:4111:127.0.0.1:4111' peer='^ssh .*-L 127.0.0.1:4112:127.0.0.1:4111'
  if [[ $1 == stop ]]; then pkill -KILL -f "$tunnel"; pkill -KILL -f "$peer"; echo "Board tunnels closed"; return; fi
  _factory_locked _factory_sync || return
  [[ $1 == sync ]] && return
  pgrep -f "$tunnel" >/dev/null || ssh -F $_factory_cfg -fN -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:4111:127.0.0.1:4111 $_factory_host </dev/null || return
  local url='http://localhost:4111/board?peers=' # no peer: the page forgets one it remembered
  if [[ -n $FACTORY_PEER ]]; then
    pgrep -f "$peer" >/dev/null || ssh -fN -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:4112:127.0.0.1:4111 $FACTORY_PEER </dev/null ||
      echo "Couldn't reach $FACTORY_PEER; the board shows this factory only"
    url="$url${FACTORY_PEER_NAME:-monster}:4112"
  fi
  echo "Board: $url (factory-ui stop closes the tunnels)"
  _factory_open "$url"
}
