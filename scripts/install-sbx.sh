#!/usr/bin/env bash
# Install Docker Sandboxes (`sbx`) on a Linux host Docker ships no package for — Arch, NixOS, Fedora, anything.
#
# Docker publishes a static tarball for exactly this, carrying its own install.sh. Everything in it is static, so
# it runs on any distribution with KVM. This downloads a pinned version, verifies its digest, and runs that
# installer under a prefix you own. It changes no system configuration.
#
#   scripts/install-sbx.sh [--prefix DIR] [--version X.Y.Z]
#
# On Arch the AUR package `docker-sbx-bin` installs the same tarball system-wide, if you prefer pacman to own it.
set -euo pipefail

version=0.54.1
prefix=${SBX_PREFIX:-$HOME/.docker/sbx}
while [ $# -gt 0 ]; do
  case $1 in
    --prefix) prefix=$2; shift 2;;
    --version) version=$2; shift 2;;
    *) echo "usage: $0 [--prefix DIR] [--version X.Y.Z]" >&2; exit 2;;
  esac
done

case $(uname -m) in
  x86_64) arch=amd64; digest=98ebf37efac8def632439ae54a90a8cb76bd602ec470e839779487828857aeae;;
  aarch64|arm64) arch=arm64; digest=9b7e4788a8ef8304a2bf5c781adb0aa5b6542c6f9d6318a53bd476e1e0998bf2;;
  *) echo "sbx ships for x86_64 and arm64 only." >&2; exit 1;;
esac
[ "$version" = 0.54.1 ] || digest=      # a digest is pinned per version; a different one is checked by you

[ -e /dev/kvm ] || { echo "No /dev/kvm: sandboxes need hardware virtualisation (enable it in the BIOS; in a VM, enable nested virtualisation)." >&2; exit 1; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || echo "Warning: /dev/kvm is not readable and writable by you. Add yourself to the kvm group, then log in again." >&2
command -v curl >/dev/null || { echo "Needs curl." >&2; exit 1; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
url="https://github.com/docker/sbx-releases/releases/download/v${version}/DockerSandboxes-linux-${arch}.tar.gz"
echo "Downloading sbx $version for $arch (about 140 MB)…"
curl -fsSL -o "$work/sbx.tgz" "$url"
if [ -n "$digest" ]; then
  echo "$digest  $work/sbx.tgz" | sha256sum -c - >/dev/null || { echo "Downloaded tarball does not match the pinned digest." >&2; exit 1; }
else
  echo "No pinned digest for $version; its sha256 is $(sha256sum "$work/sbx.tgz" | cut -d' ' -f1)"
fi

tar -xzf "$work/sbx.tgz" -C "$work"
PREFIX="$prefix" "$work/docker-sbx/install.sh"

mkdir -p "$HOME/.local/bin"
ln -sfn "$prefix/bin/sbx" "$HOME/.local/bin/sbx"
echo "Installed $("$prefix/bin/sbx" --version), linked into ~/.local/bin"
cat <<'NEXT'

Next, with ~/.local/bin on your PATH:
  sbx login              # a person, once, at a terminal
  sbx policy init deny-all

The daemon starts itself whenever sbx needs it; nothing has to be kept running.
NEXT
