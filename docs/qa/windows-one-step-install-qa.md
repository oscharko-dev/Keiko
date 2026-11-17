# Windows one-step install — real-host QA (2026-11-17)

Goal: a person installs Keiko on Windows — through npm or the release artifact — and the
`KeikoRuntimeGateway` service comes with it; an update keeps it current; nobody runs a separate
`keiko gateway-service` step, sets an environment variable or unpacks several archives. Keiko and
anyone testing it may create **user** environment variables only, never system variables.

Host: Windows 11 Home 10.0.26200, local administrator, default UAC (consent prompt on the secure
desktop). Branch `feat/windows-one-step-install`, Node 26.13.1.

## Environment variables

Keiko writes no environment variable values, user or system. While a confined run is live, the
Windows supervisor removes and later restores the "ALL APPLICATION PACKAGES" read entries on the ACL
of the user key `HKCU\Environment` (`native/runtime-supervisor/windows/gateway_environment.c`), with
its record under `HKCU\Software\Keiko\RuntimeSupervisor`. Before removal the ACL was in its Windows
default state and the record was empty. The one-step setup adds no environment variable; its only
switch, `KEIKO_GATEWAY_SERVICE_SETUP=manual`, is an optional operator setting (user scope suffices).

## Removal of the previous installation

Everything removed was backed up first, outside the repository.

| Item                                                                  | Removed by                           | Result                                                       |
| --------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Desktop install `%LOCALAPPDATA%\Programs\Keiko` (1.5.1), registration | `keiko uninstall --force`            | gone                                                         |
| State `%USERPROFILE%\.keiko`                                          | `keiko uninstall`, leftovers by hand | gone                                                         |
| `%LOCALAPPDATA%\Keiko` (control logs, supervisor folder)              | by hand                              | gone                                                         |
| `HKCU\Software\Keiko`                                                 | by hand                              | gone                                                         |
| Global npm `@oscharko-dev/keiko` 1.4.0 (`E:\npm-global`)              | `npm uninstall -g --prefix …`        | gone                                                         |
| `KeikoRuntimeGateway` service                                         | `keiko gateway-service uninstall`    | **kept**: the UAC prompt was not approved (nobody at the PC) |

Findings from the real uninstall:

- **F1 (open):** `keiko uninstall` keeps some of its own files as "not a recognized Keiko artifact":
  `memory\vault.key`, `ui\coding-runtime`, `ui\credentials\.keiko-vault-guard-*.sqlite`,
  `ui\task-workspaces`. Task workspaces can hold the person's uncommitted work, so this needs a
  decision rather than a broader delete.
- **F2 (fixed):** on a desktop install it suggested `npm uninstall -g @oscharko-dev/keiko`. It no
  longer does.
- **F3 (fixed):** the service needed its own `keiko gateway-service uninstall`. A full
  `keiko uninstall` now removes it in the same command (one UAC prompt) and names the command when
  the approval is declined.
- **F4 (open):** the uninstall's own Activity Log stays in `%LOCALAPPDATA%\Keiko\control`.

## Fresh install through npm

The branch was packed (`npm pack`) and installed globally into an isolated prefix, together with the
locally built Windows runtime package candidate (`@oscharko-dev/keiko-coding-runtime-win32-x64`
1.1.5 with the release's supervisor bytes; see the publish workflow's compiler finding). Then, from
a folder of its own, `keiko start --no-open`:

- `coding-runtime.dev-lane.activated`: lane `npm-runtime-package`, target `windows-x64`, supervisor
  `888130331e49…`.
- `cli.gateway-service.setup`: outcome `ready`, lane `npm-runtime-package`, 2.3 s. No prompt: the
  installed service already ran exactly this helper.
- `GET /api/coding-workbench/runtime/readiness`: `runtimeAvailable: true`, origin
  `npm-runtime-package`.

Without the runtime package (today's published npm state), the same start answers
`runtimeAvailable: false` with `runtimeUnavailableReason: "npm-runtime-package-missing"`, and the
Workbench names `keiko-windows-x64-setup.exe`.

## Install with an absent service (verified 2026-11-17, a person at the PC)

`keiko gateway-service uninstall` (one UAC approval) removed the service
(`cli.gateway-service.completed`: action `uninstall`, state `absent`, 4.4 s). The next
`keiko start` set it up by itself after one more UAC approval: `cli.gateway-service.setup` outcome
`installed`, prior state `absent`, lane `npm-runtime-package`, 4.3 s. The service runs again
(auto start, delayed) with the pinned supervisor `888130331e49…`, the setup record holds that pin,
and readiness reports `runtimeAvailable: true`.

## Not yet verified on a real host

- Whether the UAC prompt raised from the background server for the Workbench's **Repair** comes to
  the front.
- The desktop artifact built from this branch: a release-shaped Windows package comes from the
  `portable-assets` workflow (signed manifest, approved native bytes), which was not run. Its start
  goes through the same `keiko start` path verified above.
