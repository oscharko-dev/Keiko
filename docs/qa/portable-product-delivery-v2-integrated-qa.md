# Portable Product Delivery V2 Integrated QA

Status: Issue #1961 final cross-epic QA for program Epic #1944.

This ledger verifies the complete portable product delivery program after the portable runtime/setup
epic (#1942) and portable updater v2 epic (#1945) have both been integrated on the shared program
branch. It is a release-readiness artifact, not a new runtime subsystem.

## Current Integration State

| Area               | Evidence                                                        | Result                                                                                |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Program branch     | `epic/portable-product-delivery-v2`                             | Single integration branch for the full feature before any `dev` PR.                   |
| Latest dev sync    | `origin/dev@d0da7ec1` merged into program branch via `6be9a1f5` | Final QA runs against current `dev`, not the older program base.                      |
| Runtime/setup epic | #1942 closed                                                    | Portable artifacts, bundled Node runtime, first-run setup, and install records exist. |
| Updater epic       | #1945 closed                                                    | Portable-managed one-click updates extend the governed updater.                       |
| Final QA issue     | #1961 active                                                    | Owns ADR reconciliation, final gates, release-impact closeout, and final `dev` PR.    |
| Dev merge policy   | #1944, #1961                                                    | No prerequisite implementation epic targets `dev` separately.                         |

## ADR Reconciliation

`origin/dev` currently owns `ADR-0113-governed-documentation-browser`. The portable program branch
therefore uses `ADR-0115-portable-managed-install-and-release-asset-update-authority`.

| Check                              | Evidence                                                                           | Result                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Current `dev` ADR ownership        | `git ls-tree -r origin/dev docs/adr`                                               | `ADR-0113` is the governed documentation ADR.    |
| Program branch portable authority  | `docs/adr/ADR-0115-portable-managed-install-and-release-asset-update-authority.md` | Portable authority is `ADR-0115`.                |
| ADR index gate                     | `npm run check:adr-index`                                                          | Green after current-dev merge.                   |
| Stale portable citation correction | `docs/release/portable-runtime-artifact-contract.md`                               | Portable release-impact tuple now says ADR-0115. |

The older GitHub issue text that mentions provisional portable `ADR-0113` is superseded by the
repository state above.

## Product Journey Coverage

| Journey step                            | Primary evidence                                                                                                                                                 | Settlement                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Download                                | `docs/release/portable-runtime-artifact-contract.md`, `scripts/__tests__/release-portable-assets-workflow.test.mjs`                                              | Exactly three first-class stable artifacts are required: Windows x64, macOS arm64, macOS x64.   |
| Open launcher                           | `docs/release/portable-launch-setup-guide.md`, `scripts/__tests__/portable-launch-setup-smoke.test.mjs`                                                          | Users double-click `Keiko.exe` or `Keiko.app`; no Node/npm/shell primary path.                  |
| First-run setup                         | `scripts/portable-launch-setup-smoke.mjs`, `packages/keiko-cli/src/portable-maintenance.ts`                                                                      | Setup copies into a user-owned managed install root and records content-free attestation.       |
| App launch from managed install         | `docs/release/portable-launch-setup-guide.md`, launch/setup smoke                                                                                                | Windows search/Start Menu and Finder/Spotlight registration are user-local.                     |
| Update detection                        | `packages/keiko-server/src/update-preflight.test.ts`, `docs/qa/portable-updater-v2-qa-matrix.md`                                                                 | GitHub Release Assets are portable installability truth; release-impact is compatibility truth. |
| One-click update                        | `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.test.tsx`, `tests/e2e/update-ui-1696.spec.ts`                                                  | Existing update notice/window shows one detected recommended action for eligible installs.      |
| Download, verify, stage, activate       | `packages/keiko-server/src/update-portable-staging.test.ts`, `packages/keiko-server/src/update-portable-activation.test.ts`                                      | Asset verification, safe staging, activation, relaunch, and version verification are automatic. |
| Remediation completion                  | `packages/keiko-server/src/update-integration.test.ts`, `packages/keiko-server/src/update-remediation.test.ts`                                                   | Portable activation is not full success until remediation completes or is safely deferred.      |
| Sidecar-bearing and sidecar-free assets | `scripts/__tests__/portable-runtime.test.mjs`, `packages/keiko-server/src/update-preflight.test.ts`, `packages/keiko-server/src/update-portable-staging.test.ts` | Sidecar payloads are inert and update only as part of the complete Keiko release asset.         |

## Platform Settlement

Windows x64, macOS arm64, and macOS x64 are equally release-blocking. macOS arm64 and macOS x64 have
the same product importance and the same signing/notarization expectation.

| Target        | Required asset          | Required launcher | Release status                 |
| ------------- | ----------------------- | ----------------- | ------------------------------ |
| `windows-x64` | `keiko-windows-x64.zip` | `Keiko.exe`       | First-class, release-blocking. |
| `macos-arm64` | `keiko-macos-arm64.zip` | `Keiko.app`       | First-class, release-blocking. |
| `macos-x64`   | `keiko-macos-x64.zip`   | `Keiko.app`       | First-class, release-blocking. |

## Local Manual UX Review Harness

Final human review uses a disposable fake-release harness instead of waiting for a newer public
release. The harness is test-only repo tooling; production updater code still requires real GitHub
release assets, checksums, release-impact binding, signing/notarization evidence, CSRF, staging,
activation, relaunch, and version verification.

Run:

```sh
npm run portable:manual-review
```

The command builds the packages and static UI, then writes `.portable-runtime/manual-review-*` with:

- `README.md` for the human click-through instructions.
- `manual-review-plan.json` describing all targets and scenarios.
- `scripts/start-<target>-<scenario>.sh` and `.cmd` launchers for quick UX review.
- `artifacts/current/<target>/` slots for the current fresh-install ZIP artifacts when they exist
  locally.

Each scenario launcher starts a local Keiko review server with an isolated HOME, state directory,
managed install root, UI database, evidence directory, and fake GitHub release asset set. The
scenario runtime root is outside the repository in the OS temp directory so the normal Keiko
workspace database guard stays active. Mutating update scenarios overwrite only that scenario's
disposable managed install root. They do not touch the operator's normal Keiko install.

The generated matrix covers:

| Area                 | Scenario coverage                                                                     |
| -------------------- | ------------------------------------------------------------------------------------- |
| Current release      | `current-release`                                                                     |
| Fresh install        | `fresh-install` plus copied current artifacts under `artifacts/current/<target>/`     |
| Happy path update    | `happy-update` for `windows-x64`, `macos-arm64`, and `macos-x64`                      |
| Negative artifacts   | `bad-checksum`, `bad-manifest`, `missing-asset`, `missing-signing`, `hostile-archive` |
| Remediation          | `remediation-required`                                                                |
| Sidecar variants     | `sidecar-absent`, `sidecar-present`, `sidecar-failure`                                |
| Install-mode blocks  | `policy-disabled`, `unmanaged-bootstrap`, `system-managed`                            |
| Compatibility paths  | `legacy-package-manager`                                                              |
| Release fetch errors | `network-failure`                                                                     |

Minimum final manual smoke remains one full happy-path update for each first-class target, one fresh
install/open check for each first-class artifact, one remediation-required flow, and one negative
artifact flow proving the active install stays intact.

## Security, Accessibility, And UX Settlement

- Public portable update metadata is resolved through the local server boundary; browser UI does not
  fetch GitHub directly.
- Update mutation is explicit, user-confirmed, CSRF-gated, lock-guarded, and unavailable for
  unsupported, unmanaged, or machine-managed v1 installs.
- Portable staging rejects traversal, unsafe roots, symlinks, digest mismatch, missing runtime
  files, and missing signing/notarization evidence before activation.
- Local update and remediation state remains content-free: no customer repositories, package
  payloads, prompts, model output, private paths, raw logs, credentials, or token-bearing artifacts.
- The primary path is download, extract, open, setup, then update in-app. It does not require Node,
  npm, shell commands, manual restart, or manual version verification.
- npm/Yarn remains compatibility-only and is not promoted as a separate user-facing update tab.
- Existing update-window accessibility evidence remains the proof source for the adapted updater
  surface; final verification reruns the update UI smoke before the `dev` PR is marked ready.

## Release-Impact Closeout

The final user-visible release-impact entry is:

`2026-07-06-keiko-0.2.14-portable-product-delivery-v2`

It records:

- Release-note category `new-additions` with high priority.
- Three release-blocking targets: `windows-x64`, `macos-arm64`, `macos-x64`.
- Managed first-run install registration, update runtime state, and local remediation state as
  content-free affected state areas.
- Non-goals as machine-readable metadata: no promoted package-manager path, no rollback, no
  enterprise-managed rollout, and sidecar updates only as whole-product Keiko assets.

## Verification Ledger

Commands already run after the latest current-dev sync:

| Command                                                                                                                                                                                         | Result                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:adr-index`                                                                                                                                                                       | Pass: 87 unique ADR numbers, all indexed, no orphan links.                                                                                                                                      |
| `npm run check:release-impact`                                                                                                                                                                  | Pass: current package version has reviewed update-impact metadata.                                                                                                                              |
| `npm run check:portable-manifest`                                                                                                                                                               | Pass: 1 manifest.                                                                                                                                                                               |
| `npm run check:version-consistency`                                                                                                                                                             | Pass: all workspace packages and exported constants report `0.2.14`.                                                                                                                            |
| `npx vitest run packages/keiko-cli/src/memory.test.ts packages/keiko-server/src/update-portable-activation.test.ts`                                                                             | Pass: 2 files, 20 tests.                                                                                                                                                                        |
| `npm run typecheck`                                                                                                                                                                             | Pass.                                                                                                                                                                                           |
| `npm run lint`                                                                                                                                                                                  | Pass.                                                                                                                                                                                           |
| `npm run format:check`                                                                                                                                                                          | Pass.                                                                                                                                                                                           |
| `npm run arch:check`                                                                                                                                                                            | Pass: no dependency violations; import policy and contract boundary checks passed.                                                                                                              |
| `npm run arch:check:negative`                                                                                                                                                                   | Pass: gate fired on 48 fixtures as expected.                                                                                                                                                    |
| `npm test`                                                                                                                                                                                      | Pass: 1,011 files, 17,183 tests passed, 1 skipped.                                                                                                                                              |
| `npm run clean && npm run build && npm run build:ui && npm run prepare:bin && npm run prune:package-build-artifacts && npm run prune:package-native-optionals && npm run check:package-surface` | Pass: editor bundle size check passed; package surface passed with 4,315 package files.                                                                                                         |
| `npm run check:editor-release-evidence` on macOS                                                                                                                                                | Expected local platform mismatch: committed Linux fingerprint `8e39300...`; macOS measurement `b11bedda...`. Do not refresh this evidence from macOS; the Linux `ui` CI check is authoritative. |

Final #1961 verification must run before the program PR is marked ready:

```sh
npm run check:adr-index
npm run check:release-impact
npm run check:portable-manifest
npm run portable:manual-review
npm run smoke:portable-launch-setup
npx vitest run scripts/__tests__/portable-manual-review.test.mjs
npx vitest run scripts/__tests__/portable-runtime.test.mjs scripts/__tests__/release-portable-assets-workflow.test.mjs scripts/__tests__/release-publish-pipeline.test.mjs scripts/__tests__/portable-launch-setup-smoke.test.mjs scripts/__tests__/release-impact-governance.test.mjs scripts/__tests__/release-impact-notes.test.mjs
npx vitest run packages/keiko-contracts/src/update-session.test.ts packages/keiko-server/src/update-install-mode.test.ts packages/keiko-server/src/update-preflight.test.ts packages/keiko-server/src/update-portable-staging.test.ts packages/keiko-server/src/update-portable-activation.test.ts packages/keiko-server/src/update-session.test.ts packages/keiko-server/src/update-session-routes.test.ts packages/keiko-server/src/update-integration.test.ts packages/keiko-server/src/update-local-state.test.ts packages/keiko-server/src/update-remediation.test.ts packages/keiko-server/src/update-remediation-routes.test.ts packages/keiko-cli/src/update.test.ts
npm --workspace @oscharko-dev/keiko-ui run test -- src/lib/api.test.ts src/app/components/desktop/update/UpdateWindow.test.tsx src/app/components/desktop/update/UpdateStartupNotice.test.tsx
npm run test:e2e:update-ui-1696
npm run format:check
npm run typecheck --workspace @oscharko-dev/keiko-ui
npm run lint --workspace @oscharko-dev/keiko-ui
npm run test:coverage:ui
npm run clean
npm run build
npm run prepare:bin
npm run build:ui
npm run check:editor-release-evidence
npm run prune:package-build-artifacts
npm run prune:package-native-optionals
npm run check:package-surface
.keiko-scripts/verify-receipt.sh 1961
.keiko-scripts/audit-receipt.sh 1961 --findings 0 --user-facing false
```

After the child branch merges back into `epic/portable-product-delivery-v2`, the final program branch
must receive a fresh #1944 verify receipt and the final PR to `dev` must wait for real GitHub checks.

## Known Limits

- No autonomous merge to `dev`.
- No rollback, downgrade, prerelease/private channel install, silent background update, or
  organization-managed rollout.
- No MSI/MSIX/PKG/DMG/MDM/Jamf/Intune/SCCM/Munki packaging in v1.
- No Linux portable artifact.
- No independent OpenCode or sidecar updater.
- No runtime storage of package payloads, customer data, raw logs, prompts, model output, private
  paths, credentials, or token-bearing evidence.
