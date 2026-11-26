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

**Install blocked before login.** The initial full apt index refresh did not finish within 180 seconds. Refreshing Docker's signed Noble stable index succeeded. `sudo apt-get install docker-sbx` selected `0.54.1-1~ubuntu.24.04~noble`, but Ubuntu returned `404 Not Found` for dependencies including `mesa-libgallium_25.2.8-0ubuntu0.24.04.4_amd64.deb`. Apt exited 100. Complete a full Ubuntu index refresh before retrying installation. Neither OAuth nor sandbox boot has been tested.
