# devvm layer for the colonia factory VM; vm/bootstrap.sh installs it as ~/.config/devvm/layers/colonia.sh.
# Runs once per image build, as the VM's user with sudo, on top of devvm's docker layer.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq bubblewrap socat postgresql-client python-is-python3

# Toolchain, pinned to the laptop's versions; pnpm comes from the client's packageManager via corepack.
mise use -g -y node@22.19.0 deno@2.9.8 workmux@0.1.280 gh@2.103.3 neovim@0.12.6 lazygit@0.66.2 tmux@3.8
mise exec node@22.19.0 -- corepack enable

# UAT and Lighthouse launch /usr/bin/chromium. Ubuntu has no chromium deb, so on x86 use Google Chrome from Google's
# signed apt repo (dl.google.com only, never storage.googleapis.com). Google has no Linux Chrome for arm64 (an M1's
# VM): there, Playwright's Chromium build for the factory's Playwright version, from its CDN.
if [ "$(dpkg --print-architecture)" = amd64 ]; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
  echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' |
    sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq google-chrome-stable
  sudo ln -sf /usr/bin/google-chrome /usr/bin/chromium
else
  mise exec node@22.19.0 pnpm@11.22.0 -- pnpm dlx playwright@1.64.1 install --with-deps chromium
  sudo ln -sf "$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)" /usr/bin/chromium
fi

# The colonia tree lives on the VM's own disk (~/colonia, kept across remakes) and is bind-mounted at the
# laptop's path, so the factory's absolute paths work. Never a shared folder: on Linux a shared .git lets
# the VM plant hooks that run on the laptop.
tree=$HOME/colonia path=/home/smudgee/Projects/colonia
printf '%s\n' '[Unit]' 'Description=colonia tree at the factory path' '[Service]' 'Type=oneshot' 'RemainAfterExit=yes' \
  "ExecStart=/bin/sh -c 'install -d -o $(id -un) -g $(id -gn) $tree $tree/.pnpm-cache && mkdir -p $path && (mountpoint -q $path || mount --bind $tree $path)'" \
  '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/colonia-tree.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now colonia-tree.service

# pnpm 11 checks minimumReleaseAge against cached registry metadata, so offline installs need ~/.cache/pnpm
# as much as the store (which pnpm already keeps on this disk). Keep it beside the tree so remakes don't wipe it.
mkdir -p "$HOME/.cache" && ln -sfn "$tree/.pnpm-cache" "$HOME/.cache/pnpm"
