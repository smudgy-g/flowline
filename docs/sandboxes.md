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
