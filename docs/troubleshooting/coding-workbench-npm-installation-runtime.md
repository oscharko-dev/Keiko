## Start a coding run on an npm installation

| Field             | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                                           |
| Surface           | Local UI / Run engine                                                                             |
| Stable identifier | `runtimeAvailable: false`; "Starting a coding run stays unavailable until … is confirmed active." |

**Symptom**

Keiko was installed with npm (`npm install @oscharko-dev/keiko` in a project folder). The Coding
Workbench lists its coding models, and every attempt to start a run shows:

> Starting a coding run stays unavailable until this installation's coding runtime is confirmed
> active.

`GET /api/coding-workbench/runtime/readiness` answers `runtimeAvailable: false` with
`runtimeUnavailableReason: "platform-unqualified"`.

**Root Cause**

Nothing has to be confirmed by a person. The Coding Workbench runs every task through a coding
engine (OpenCode) and a native secure workspace read helper. The desktop packages carry both; the
npm package carries neither, so until 1.1.2 an npm installation could never start a run.

**Diagnostic Steps**

1. `keiko support export`, then `keiko support analyze <report.json>` on the report path it prints.
2. Look for `coding-runtime.dev-lane.activated` with `lane: "npm-runtime-package"`. When it is
   absent, no runtime package is installed.
3. `coding-runtime.dev-lane.refused` with `lane: "npm-runtime-package"` means a runtime package is
   installed and failed verification; `reason` names the first failed check
   (`payload-tampered`, `secure-read-helper-stale`, `native-helper-directory-untrusted`, …).
4. A run starts but the agent's `glob` and `grep` fail: read `coding-runtime.ripgrep.resolved` for
   the run. `layout: "npm-package"` with `reason: "missing"` means the installed runtime package
   predates the bundled ripgrep; `digest-mismatch` or `not-regular-file` means its `rg` is not the
   pinned release. The engine stays active either way; only search is degraded.

**Resolution**

Update to 1.1.2 or later. On a Mac, `npm install @oscharko-dev/keiko` then installs the coding
runtime for the Mac's processor by itself: the runtime packages are optional dependencies of Keiko,
and npm selects the one that matches the host.

The runtime is absent after an install with `--omit=optional` (or `optional=false` in the npm
configuration), or when a registry mirror does not carry the runtime package. Install the ONE
package that matches the Mac's processor (`uname -m` prints `arm64` or `x86_64`; npm refuses the
other one with `EBADPLATFORM`) in the folder where Keiko is installed, then restart Keiko. A global
installation (`npm install -g`) is not supported yet
([#3582](https://github.com/oscharko-dev/Keiko/issues/3582)).

Apple silicon (`arm64`):

```bash
npm install @oscharko-dev/keiko-coding-runtime-darwin-arm64 && npx keiko restart
```

Intel Mac (`x86_64`):

```bash
npm install @oscharko-dev/keiko-coding-runtime-darwin-x64 && npx keiko restart
```

Keiko finds the package by name and, at every start, verifies the OpenCode executable, its license
and SBOM, and the helper against digests compiled into Keiko itself. A refused package is
reinstalled from the registry; it is never repaired in place. The package also carries the pinned
ripgrep search executable, which Keiko verifies at every run launch; for a `missing` or mismatching
one, update the runtime package to the current release the same way. `KEIKO_RIPGREP_BINARY_PATH` is
a developer and qualification override, not the remedy for a customer installation.

The npm lane is digest-verified, not platform-signed: the readiness answer reports
`runtimeEvidenceClass: "functional-not-platform-qualified"`, and on macOS the engine runs without
the Endpoint Security containment a signed desktop package adds. Windows and Linux installations
use the desktop packages.

**Prevention**

The Workbench names the runtime package in the message above since 1.1.2.
