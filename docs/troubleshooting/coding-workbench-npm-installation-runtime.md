## Start a coding run on an npm installation

| Field             | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                                           |
| Surface           | Local UI / Run engine                                                                             |
| Stable identifier | `runtimeAvailable: false`; "Starting a coding run stays unavailable until … is confirmed active." |

**Symptom**

Keiko was installed with `npm install -g @oscharko-dev/keiko`. The Coding Workbench lists its coding
models, and every attempt to start a run shows:

> Starting a coding run stays unavailable until this installation's coding runtime is confirmed
> active.

`GET /api/coding-workbench/runtime/readiness` answers `runtimeAvailable: false` with
`runtimeUnavailableReason: "platform-unqualified"`.

**Root Cause**

Nothing has to be confirmed by a person. The Coding Workbench runs every task through a coding
engine (OpenCode) and a native secure workspace read helper. The desktop packages carry both; the
npm package carries neither, so until 1.1.2 an npm installation could never start a run.

**Diagnostic Steps**

1. `keiko support export --out bundle.jsonl`, then `keiko support analyze bundle.jsonl`.
2. Look for `coding-runtime.dev-lane.activated` with `lane: "npm-runtime-package"`. When it is
   absent, no runtime package is installed.
3. `coding-runtime.dev-lane.refused` with `lane: "npm-runtime-package"` means a runtime package is
   installed and failed verification; `reason` names the first failed check
   (`payload-tampered`, `secure-read-helper-stale`, `native-helper-directory-untrusted`, …).

**Resolution**

Install the runtime package for the Mac's processor next to Keiko, then restart Keiko:

```bash
npm install -g @oscharko-dev/keiko-coding-runtime-darwin-arm64   # Apple silicon
npm install -g @oscharko-dev/keiko-coding-runtime-darwin-x64     # Intel Mac
keiko restart
```

Keiko finds the package by name and, at every start, verifies the OpenCode executable, its license
and SBOM, and the helper against digests compiled into Keiko itself. A refused package is
reinstalled from the registry; it is never repaired in place. After an update of Keiko, update the
runtime package as well when the release notes name a new one.

The npm lane is digest-verified, not platform-signed: the readiness answer reports
`runtimeEvidenceClass: "functional-not-platform-qualified"`, and on macOS the engine runs without
the Endpoint Security containment a signed desktop package adds. Windows and Linux installations
use the desktop packages.

**Prevention**

The Workbench names the runtime package in the message above since 1.1.2.
