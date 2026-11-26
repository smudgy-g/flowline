# One starter of the factory VM at a time, for bash and zsh. factory-ui (vm/factory.zsh) and the watchdog
# (vm/reanimate.sh) both start the VM and restart its board; run together they fight over the VM's proxy and one
# fails (FEEDBACK 34). The lock is a symlink naming its holder's pid: making one is atomic, and a dead holder's is
# taken over.
factory_lock=$HOME/.cache/factory/vm-starting

# Takes the lock for pid $1; fails at once while a live process holds it.
factory_try_lock() {
  mkdir -p "${factory_lock%/*}"
  ln -s "$1" "$factory_lock" 2>/dev/null && return 0
  kill -0 "$(readlink "$factory_lock")" 2>/dev/null && return 1
  rm -f "$factory_lock"
  ln -s "$1" "$factory_lock" 2>/dev/null
}

# Releases it, if pid $1 still holds it.
factory_unlock() {
  [ "$(readlink "$factory_lock" 2>/dev/null)" = "$1" ] && rm -f "$factory_lock"
  return 0
}
