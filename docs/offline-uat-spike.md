# Fresh offline UAT sandbox (follow-up to sandboxes.md)

On the Ubuntu worker, a staging sandbox with only registry access pulled the two fixture images and ran `docker save -o offline-images.tar mcr.microsoft.com/playwright:v1.56.1-noble node:22-bookworm-slim`. The archive was 957 MiB. The staging sandbox was removed before UAT. This is a trusted kit-preparation step, not an archive made by the code under test.

With global policy already deny-all, created a new local sandbox with `sbx --no-input create --name fx-offline-uat --cpus 2 --memory 2g --skills off --static-mcp none --deny-network '**' shell "$base/uat" "$base/images:ro"`. No policy relaxation, secrets, real project or login inside it.

- Warm kit creation: `real 0m3.929s`; `sbx exec fx-offline-uat docker load -i "$base/images/offline-images.tar"`: `real 0m30.626s`.
- `docker compose up -d --pull never web` then `docker compose run -T --pull never --rm --no-deps browser node offline.cjs`: Chromium read and asserted the local page (`local service OK`); a second navigation failed with `net::ERR_NAME_NOT_RESOLVED` for the npm registry. Independent shell curl returned 403; a nested Docker pull of uncached `hello-world:latest` also returned 403. The staging sandbox cannot carry established connections into this new kernel.
- Worker `MemAvailable` before create: 3,466,100 KiB; after running Compose/Chromium: 1,041,296 KiB. This simple before/after measurement includes worker cache and is not a peak RSS measurement. Start at **one running sandbox** on this 4 GiB worker. Stop the item's build sandbox before creating its offline UAT sandbox; a production project may require a larger worker and kit. A follow-up started two 768 MiB VMs simultaneously, each listening on 127.0.0.1:3300: each sandbox's curl returned its own name (`fx-ports-a`, `fx-ports-b`). Both were removed. This verifies private ports, not host publish-port reuse.
- Cleanup: `sbx --no-input rm -f fx-offline-uat` and `sbx --no-input list` returned `No sandboxes found`.

Isolation here is evidence about egress, not proof of report integrity. The trusted test runner must stay separate from the application filesystem, process namespace and Docker socket. In particular, do not pass a writable report directory to the application or execute project scripts in the runner process.
