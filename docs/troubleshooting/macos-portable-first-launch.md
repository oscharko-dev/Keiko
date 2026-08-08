# Resolve a macOS portable bundle that will not start on first double-click

| Field             | Value                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                                                                                                                 |
| Surface           | CLI                                                                                                                                                                     |
| Stable identifier | `"Keiko" is damaged and can't be opened.` / `keiko portable launch: macOS runtime activation is incomplete` / `existing same-path managed install root is not attested` |

**Symptom**

One of three first-launch dead ends on macOS, all fixed for artifacts staged after 0.3.0-beta.0:

1. Finder shows `"Keiko" is damaged and can't be opened. You should move it to the Trash.` and
   System Settings offers no "Open Anyway" button.
2. After approving the app, a double-click appears to do nothing: no window, no dialog, and no
   process. `.keiko/ui.log` under the state directory is never created.
3. A native alert reports `keiko portable setup: existing same-path managed install root is not
attested` after the bundle was moved to `/Applications` by hand before the first start.

**Root Cause**

1. The 0.3.0-beta.0 bundle shipped individually signed Mach-O binaries inside an app bundle that
   carried no resource seal. Gatekeeper reports that combination as damaged, a verdict with no
   recovery path in System Settings. Artifacts staged after beta.0 seal the bundle ad-hoc during
   staging (ADR-0163 D9), which turns the verdict into the normal unidentified-developer approval.
2. The portable launcher required the Endpoint Security activation manager to report `active`
   before starting the server. An unsigned evaluation install can never load that extension, so
   the requirement was an impossible precondition and the launch exited silently. The launcher now
   asks the platform whether the install carries a release signature and waives activation for
   unsigned installs (`waived-unsigned`), keeping the strict requirement for signed ones.
3. Portable setup refused to attest a bundle already sitting at the managed install location.
   Setup now adopts a same-path bundle in place when no install registration exists and the bundle
   passes full validation; the refusal remains for a bundle that fails validation or conflicts
   with an existing registration, which is the shape of post-attestation tampering.

**Diagnostic Steps**

```bash
# macOS only. 1) Is the bundle sealed? An unsealed beta.0 bundle prints
# "code has no resources but signature indicates they must be present".
codesign --verify --deep --strict <path-to>/Keiko.app

# 2) Why does a double-click do nothing? Run the launcher's exact command with visible output.
<path-to>/Keiko.app/Contents/MacOS/Keiko

# 3) What is the install state?
cat ~/.keiko/portable-install-state.json
```

If step 1 reports the missing-resources error, the download predates the seal (entry 1). If step 2
prints `macOS runtime activation is incomplete`, the CLI predates the activation waiver (entry 2).
If it prints `existing same-path managed install root is not attested`, compare the registration
from step 3: no file at all means the CLI predates same-path adoption; an existing `"status":
"managed"` record means the bundle at the managed location no longer matches its attested
identity — a genuinely refused state, not this entry's bug.

**Resolution**

1. Download the current release asset (0.3.0-beta.1 or later); every fix ships in the staged
   artifact itself. Extract the ZIP, then double-click `Keiko.app` inside the extracted folder.
2. When macOS reports it cannot verify the developer, open System Settings → Privacy & Security,
   scroll to Security, and choose "Open Anyway". This one-time approval is the documented cost of
   the unsigned evaluation lane (ADR-0163 D9); do not disable Gatekeeper globally.
3. If a previous broken attempt left a mismatched registration (`"status": "managed"` but launch
   still refuses), delete only `~/.keiko/portable-install-state.json` and the
   `/Applications/Keiko.app` copy, then repeat step 1 from the fresh download. Do not delete the
   rest of `~/.keiko`, which holds local product state.
