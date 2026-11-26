# Docker Sandboxes: local worker preflight

**Phase 0 stopped at spike 1.** Docker's [installation requirements](https://docs.docker.com/ai/sandboxes/install/) list “Ubuntu 24.04 or later” for Linux. This host runs Omarchy, not Ubuntu. The KVM device is accessible, but that does not satisfy the OS requirement.

Observed on the proposed worker:

```console
$ grep -E '^(PRETTY_NAME|ID|VERSION_ID)=' /etc/os-release
PRETTY_NAME="Omarchy"
ID=omarchy
VERSION_ID="4.5.0"
$ uname -m
x86_64
$ ls -l /dev/kvm
crw-rw-rw- 1 root kvm 10, 232 Nov 22 08:33 /dev/kvm
$ test -r /dev/kvm && test -w /dev/kvm && echo accessible
accessible
$ command -v sbx || echo 'sbx: not on PATH'
sbx: not on PATH
```

No installation or login was attempted on the unsupported OS. This is a support check, not evidence that the binary fails to run. Resume spike 1 on a supported worker; headless authentication, exec/kill behavior, mount ownership and performance, Compose/Chromium, network isolation, startup time and memory remain unverified. No concurrency limit is recommended yet.

## Retry on a disposable Ubuntu guest

Booted Canonical's Noble amd64 cloud image after checking its SHA256SUMS entry. QEMU used KVM, host CPU passthrough, 4 vCPUs and 4 GiB RAM. No factory checkout, host home or credential store was mounted. SSH is forwarded only on host loopback.

```console
$ grep PRETTY_NAME /etc/os-release
PRETTY_NAME="Ubuntu 24.04.5 LTS"
$ python3 -c 'import os,fcntl; fd=os.open("/dev/kvm",os.O_RDWR); print(fcntl.ioctl(fd,0xAE00)); vm=fcntl.ioctl(fd,0xAE01,0); print("KVM_CREATE_VM: OK"); os.close(vm)'
12
KVM_CREATE_VM: OK
```

**First install attempt.** The initial full apt index refresh did not finish within 180 seconds. Refreshing Docker's signed Noble stable index succeeded. `sudo apt-get install docker-sbx` selected `0.54.1-1~ubuntu.24.04~noble`, but Ubuntu returned `404 Not Found` for dependencies including `mesa-libgallium_25.2.8-0ubuntu0.24.04.4_amd64.deb`. Apt exited 100. 

**Install retry succeeded.** `sudo apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=2 -o APT::Update::Error-Mode=any update` reported `Fetched 33.1 MB in 6s`. `sudo apt-get -qy install docker-sbx` then succeeded; `dpkg-query -W docker-sbx` reported `0.54.1-1~ubuntu.24.04~noble`. `sbx login --help` runs. Operator sign-in and the subsequent probes are recorded below.

## Local sandbox results (Ubuntu worker, sbx 0.54.1)

* **Headless after login:** after the operator's SSH session closed, fresh noninteractive SSH sessions could run `sbx --no-input list`, `create`, and `exec` as `worker`. Login warned of file-permission-only secret storage because the worker has no keychain. No worker home or factory repo was mounted. Boot persistence was not tested.
* **Startup:** on this fresh worker `sbx policy init deny-all` was required first. `sbx --no-input create --name fx-phase0 --memory 2g --cpus 2 --skills off --static-mcp none shell "$PWD"` took 18.307 s including the shell-kit pull; `sbx exec fx-phase0 uname -sm` returned `Linux x86_64`. This is not a realistic-kit sizing measurement.
* **Exec:** `sbx exec fx-phase0 sh -c 'seq 1 10000; echo stderr-marker >&2; exit 37'` returned 37; captured stdout compared byte-for-byte equal to `seq 1 10000` and stderr contained the marker. Running `timeout -k 1s 2s` **inside** `sbx exec` around a shell and waiting child that ignored TERM returned 137; `ps` found no remaining child. This tests a normal process group, not detached sessions or services started via Docker.
* **Mount:** sandbox `pwd` returned the worker's absolute workspace path. A file created as `agent` (UID/GID 1000) appeared as `worker:worker 644`. A disposable Node 22 project used a pinned manifest/lock, Express, lodash and one HTTP response test. With the npm cache warmed, `npm ci --offline` and `npm test` in nested Docker took 1.364 s / 0.665 s using mounted `node_modules`, versus 1.138 s / 0.517 s with a sandbox-local Docker volume for dependencies. One sample per layout, not a production benchmark.
* **Services:** nested `docker info` reported engine 29.10.1 and `docker compose version` v5.8.0. `docker compose up -d --pull never web` started a Node HTTP fixture. `docker compose run -T --rm --no-deps browser` ran Playwright 1.56.1/Chromium in another container and asserted the HTTP response: `Chromium: sbx-uat-ok`. No real project was run. Cross-sandbox port reuse was not tested.
* **Network transition — failed isolation requirement:** the worker's global fallback was deny-all. Temporarily allowed only package/image registry hosts scoped to `fx-phase0`. Removing those rules (`sbx policy rm network --force --sandbox fx-phase0 --resource …`) changed a fresh registry GET from HTTP 200 to 403. The Compose browser test still passed locally; re-allowing the npm registry restored HTTP 200. **But rule removal did not close existing connections:** a Node HTTPS keep-alive client in nested Docker made a successful request to `registry.npmjs.org/-/ping`, waited for the worker to remove the rule, then made another request over the same TLS socket. Output: `1 200 sameSocket=false`, `2 200 sameSocket=true`. Removing the install allowlist is not equivalent to starting UAT offline.

Stopped at spike 5. A separate, deny-from-boot UAT sandbox using pre-staged dependencies is a candidate, not a verified solution. No realistic-kit memory measurement or concurrency recommendation; no factory changes. `sbx --no-input rm --force fx-phase0` removed the spike sandbox and `sbx --no-input list` reported `No sandboxes found`.
