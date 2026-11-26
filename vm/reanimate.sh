#!/usr/bin/env bash
# Keeps a Mac's factory alive with nobody at it: every minute, if its board doesn't answer on localhost:4111, it
# starts the VM, starts the board (vm/sync-in-vm.sh) and reopens the tunnel to it. A launchd login item runs it, so
# with automatic login a restart or power cut heals itself.
#   vm/reanimate.sh install     add the login item and start it now (macOS)
#   vm/reanimate.sh uninstall   remove it
# Log: ~/Library/Logs/frankenstein-reanimate.log
set -u
here=$(cd "$(dirname "$0")" && pwd)
label=dev.frankenstein.reanimate
plist=$HOME/Library/LaunchAgents/$label.plist
export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

case "${1:-}" in
install)
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$here/reanimate.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/frankenstein-reanimate.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/frankenstein-reanimate.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$plist" && echo "Installed $label; log: ~/Library/Logs/frankenstein-reanimate.log"
  exit ;;
uninstall)
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null; rm -f "$plist"; echo "Removed $label"; exit ;;
esac

# As factory.zsh and bootstrap.sh: the Mac's VM folder is short (macOS's socket path limit).
if [ "$(uname)" = Darwin ]; then folder=$HOME/Projects/monster; else folder=$HOME/Projects/colonia-factory-vm; fi
host=devvm-$(basename "$folder") cfg=$HOME/.local/share/devvm/ssh_config
tunnel='^ssh .*-L 127.0.0.1:4111:127.0.0.1:4111'
up() { curl -sf --max-time 20 -o /dev/null http://localhost:4111/board; }
say() { echo "$(date '+%F %T') $*"; }
. "$here/vm-lock.sh"

while true; do
  if up; then
    :
  # factory-ui stops and restarts the VM and board while it syncs: leave it be until it's done.
  elif ! factory_try_lock $$; then
    say "board not answering, but factory-ui is starting it; checking again in a minute"
  else
    say "board not answering: reanimating"
    pkill -f "$tunnel"
    # Adopt first: after a restart devvm can take the folder for a new one.
    if (cd "$folder" && devvm adopt --force --no-input >/dev/null 2>&1; devvm --no-input </dev/null >/dev/null) &&
      ssh -F "$cfg" "$host" 'bash -l -s' < "$here/sync-in-vm.sh" >/dev/null &&
      ssh -F "$cfg" -fN -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:4111:127.0.0.1:4111 "$host" </dev/null &&
      up
    then say "alive"; else say "still down; trying again in a minute"; fi
    factory_unlock $$
  fi
  sleep 60
done
