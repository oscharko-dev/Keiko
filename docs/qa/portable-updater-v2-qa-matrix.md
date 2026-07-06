# Portable Updater V2 QA Matrix

Status: Issue #1960 closeout evidence for Epic #1945, integrated under program Epic #1944.

This matrix closes the portable updater v2 implementation epic by mapping the user journey,
security/failure coverage, platform targets, and known limits to executable tests and release
evidence. It does not add runtime behavior; the implementation lives in the child issues and their
merged PRs.

## Scope Under Verification

Portable updater v2 extends the governed updater instead of creating a second updater subsystem. The
covered happy path is:

1. Detect an attested `portable-managed` install.
2. Select the matching public GitHub Release Asset for the current platform target.
3. Show one recommended update action in the existing update notice/window.
4. Download, verify, stage, activate, relaunch, and verify the new version.
5. Preserve release-impact remediation and local update state before full completion is reported.

The matrix preserves these non-goals:

- No rollback, downgrade, prerelease/beta/canary/private channel, or silent background update.
- No organization-managed rollout, enterprise mirror, MDM, MSI/MSIX/PKG/DMG, privileged helper, or
  admin elevation.
- No fake support or organization-managed UX. Blocked paths show only implemented recovery actions.
- No independent OpenCode/sidecar updater or runtime download path.
- No customer repository repair, remote backup, raw log persistence, prompt/model-output snapshot, or
  package payload storage in update state.
- The final cross-epic program release QA remains owned by #1961 before any `dev` PR.

## Child Coverage Map

| Child | PR                                                       | Epic merge commit | Coverage contributed                                                                                                                                  |
| ----- | -------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1954 | [#2018](https://github.com/oscharko-dev/Keiko/pull/2018) | `4e2f8029`        | Portable-managed install-mode contracts, attestation, unmanaged/bootstrap ineligibility, and npm/Yarn compatibility preservation.                     |
| #1955 | [#2021](https://github.com/oscharko-dev/Keiko/pull/2021) | `eb6a58fb`        | GitHub Release Asset preflight, target asset selection, release-impact binding, stable-only eligibility, and portable installability source of truth. |
| #1956 | [#2025](https://github.com/oscharko-dev/Keiko/pull/2025) | `c80add27`        | Asset download, manifest/checksum verification, bounded staging, traversal rejection, current-install preservation, and content-free stage state.     |
| #1957 | [#2027](https://github.com/oscharko-dev/Keiko/pull/2027) | `ef801d3d`        | Managed install swap/activation, registration and shortcut refresh, relaunch request, version verification, and activation failure preservation.      |
| #1985 | [#2030](https://github.com/oscharko-dev/Keiko/pull/2030) | `005344e7`        | Sidecar identity, license/SBOM/signing evidence, staged sidecar payload digest verification, and failed sidecar activation blocking.                  |
| #1958 | [#2032](https://github.com/oscharko-dev/Keiko/pull/2032) | `35cfd2ae`        | Existing update notice/window and CLI fallback adapted for eligible and blocked portable update paths without a separate updater UI.                  |
| #1959 | [#2036](https://github.com/oscharko-dev/Keiko/pull/2036) | `a0ad6b8c`        | Portable activation completion gated through existing release-impact remediation and content-free runtime state.                                      |
| #1960 | this PR                                                  | pending           | QA matrix, coverage map, security/failure settlement, and updater epic closeout evidence.                                                             |

## Platform Coverage

Every stable portable release that advertises portable delivery is release-blocked on exactly three
first-class artifacts.

| Target        | Asset                   | Priority                      | Evidence                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windows-x64` | `keiko-windows-x64.zip` | First-class, release-blocking | `packages/keiko-contracts/src/update-session.test.ts`, `scripts/__tests__/portable-runtime.test.mjs`, `scripts/__tests__/release-publish-pipeline.test.mjs`, `scripts/__tests__/portable-launch-setup-smoke.test.mjs`, `packages/keiko-server/src/update-portable-staging.test.ts`, `packages/keiko-server/src/update-portable-activation.test.ts`. |
| `macos-arm64` | `keiko-macos-arm64.zip` | First-class, release-blocking | `packages/keiko-contracts/src/update-session.test.ts`, `scripts/__tests__/portable-runtime.test.mjs`, `scripts/__tests__/release-publish-pipeline.test.mjs`, `scripts/__tests__/portable-launch-setup-smoke.test.mjs`, `packages/keiko-server/src/update-preflight.test.ts`, `tests/e2e/update-ui-1696.spec.ts`.                                    |
| `macos-x64`   | `keiko-macos-x64.zip`   | First-class, release-blocking | `packages/keiko-contracts/src/update-session.test.ts`, `scripts/__tests__/portable-runtime.test.mjs`, `scripts/__tests__/release-publish-pipeline.test.mjs`, `scripts/__tests__/portable-launch-setup-smoke.test.mjs`, `packages/keiko-server/src/update-preflight.test.ts`.                                                                        |

macOS arm64 and macOS x64 have equal release importance. Production signing checks must apply to
both macOS targets at the same level; see `scripts/__tests__/portable-runtime.test.mjs` cases for
equal macOS verification checks and production notarization checks.

## Coverage Map

| Area                           | Primary evidence                                                                                                                                                                                                                   | Coverage statement                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable target contract       | `packages/keiko-contracts/src/update-session.test.ts`, `scripts/__tests__/portable-runtime.test.mjs`                                                                                                                               | Exactly three supported targets and their asset names are canonical. Target or asset-name drift fails.                                                                                              |
| Release/publish asset gate     | `scripts/release-publish.mjs`, `scripts/__tests__/release-publish-pipeline.test.mjs`, `scripts/__tests__/release-portable-assets-workflow.test.mjs`                                                                                | Stable latest publishes require a reviewed portable asset bundle, exactly three assets, safe manifest paths, verified upload/download URLs, and no symlink/traversal inputs.                        |
| Managed install eligibility    | `packages/keiko-server/src/update-install-mode.test.ts`, `docs/release/portable-launch-setup-guide.md`                                                                                                                             | Only user-local managed installs are self-update eligible; unmanaged ZIP/bootstrap and system-managed installs are ineligible in v1.                                                                |
| Preflight and target selection | `packages/keiko-server/src/update-preflight.test.ts`                                                                                                                                                                               | GitHub Release Assets are the installability source of truth for portable-managed updates. Missing, malformed, prerelease, unsupported, or release-impact-missing assets block one-click readiness. |
| Download and staging           | `packages/keiko-server/src/update-portable-staging.test.ts`                                                                                                                                                                        | Download, manifest binding, checksum verification, staging, sidecar verification, traversal rejection, active-install preservation, and content-free stage state are covered.                       |
| Activation and relaunch        | `packages/keiko-server/src/update-portable-activation.test.ts`, `packages/keiko-server/src/update-session.test.ts`                                                                                                                 | Staged installs are promoted, registration/shortcuts are refreshed, relaunch/version verification is required, and activation failures preserve the current install when safe.                      |
| Session and local state        | `packages/keiko-server/src/update-session.test.ts`, `packages/keiko-server/src/update-integration.test.ts`, `packages/keiko-server/src/update-local-state.test.ts`                                                                 | Portable install activation is distinct from full update completion; runtime state stores summaries only and excludes payloads, raw logs, customer content, private paths, prompts, and secrets.    |
| Remediation                    | `packages/keiko-server/src/update-remediation.test.ts`, `packages/keiko-server/src/update-remediation-routes.test.ts`, `packages/keiko-server/src/update-integration.test.ts`                                                      | Release-impact remains the source of truth. Pending remediation keeps the update non-terminal, safe deferral degrades features, and failed/manual review states block completion.                   |
| UI and E2E smoke               | `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.test.tsx`, `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.test.tsx`, `tests/e2e/update-ui-1696.spec.ts`                                | The existing update notice/window shows one portable-managed action for eligible installs and blocked/manual download guidance for ineligible or malformed portable asset paths.                    |
| CLI fallback                   | `packages/keiko-cli/src/update.test.ts`, `packages/keiko-cli/src/update-output.ts`, `packages/keiko-cli/src/update.ts`                                                                                                             | CLI compatibility remains available but does not promote npm/Yarn as the normal user path; portable managed output avoids shell-primary recovery.                                                   |
| Security and redaction         | `scripts/__tests__/portable-runtime.test.mjs`, `packages/keiko-server/src/update-portable-staging.test.ts`, `packages/keiko-server/src/update-portable-activation.test.ts`, `packages/keiko-server/src/update-local-state.test.ts` | Manifest, staging, activation, and audit paths fail closed on secrets, private paths, credential URLs, raw logs, package-manager output, state payload references, traversal, and payload mismatch. |

## Scenario Matrix

| Scenario                              | Starting condition                                                                                       | Expected result                                                                                                          | Primary evidence                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Current release                       | Running version already equals latest stable target.                                                     | No install action; current release notes may be shown.                                                                   | `update-preflight.test.ts`, `UpdateWindow.test.tsx`.                                             |
| Stable portable update available      | `portable-managed` install with matching reviewed GitHub Release Asset.                                  | Existing update window shows one `Update Keiko` action; no npm/channel choice.                                           | `update-preflight.test.ts`, `UpdateWindow.test.tsx`, `update-ui-1696.spec.ts`.                   |
| Unsupported portable bootstrap        | Keiko runs from an unmanaged ZIP/bootstrap folder.                                                       | One-click self-update is blocked; user can download latest manually when relevant.                                       | `update-install-mode.test.ts`, `update-preflight.test.ts`, `UpdateWindow.test.tsx`.              |
| System or IT-managed install          | Portable install record indicates system-managed authority.                                              | Self-update is ineligible in v1; no mutation of machine-wide locations.                                                  | `update-install-mode.test.ts`.                                                                   |
| Policy disabled                       | Local update mutation policy is disabled.                                                                | Server and CLI fail closed before staging or mutation.                                                                   | `update-session.test.ts`, `update.test.ts`.                                                      |
| Missing platform asset                | Release lacks the selected target asset or companion manifest/checksum asset.                            | One-click readiness is blocked with portable asset-missing evidence.                                                     | `update-preflight.test.ts`, `release-publish-pipeline.test.mjs`.                                 |
| Malformed manifest                    | Portable manifest is invalid or does not bind to the asset.                                              | One-click readiness is blocked before download/stage mutation.                                                           | `update-preflight.test.ts`, `portable-runtime.test.mjs`.                                         |
| Checksum mismatch                     | Checksum binding does not match the selected asset.                                                      | One-click readiness or staging fails closed; current install remains unchanged.                                          | `update-preflight.test.ts`, `update-portable-staging.test.ts`.                                   |
| Missing signing/notarization evidence | Production manifest lacks required Authenticode or Developer ID/notarization proof.                      | Production verification fails; pull-request/staging artifacts remain explicitly non-production.                          | `portable-runtime.test.mjs`, `verify-portable-runtime-signing.mjs`.                              |
| Network/download failure              | Asset or release metadata request cannot complete safely.                                                | Report is degraded or staging fails; no success state is claimed.                                                        | `update-preflight.test.ts`, `update-portable-staging.test.ts`.                                   |
| Archive traversal or unsafe entry     | Asset contains traversal, absolute, drive-relative, UNC, wrong-root, or symlink entries.                 | Extraction/staging fails closed without mutating the active install.                                                     | `portable-runtime.test.mjs`, `update-portable-staging.test.ts`.                                  |
| Sidecar absent                        | Portable asset has no sidecar runtimes.                                                                  | Update remains valid when Coding Workbench sidecar is not included.                                                      | `update-preflight.test.ts`, `update-portable-staging.test.ts`, `portable-runtime.test.mjs`.      |
| Sidecar present                       | Release-impact and manifest require a bundled sidecar payload.                                           | Sidecar metadata, license/SBOM/signing evidence, platform, and digest are verified as part of the complete Keiko asset.  | `update-preflight.test.ts`, `update-portable-staging.test.ts`, `portable-runtime.test.mjs`.      |
| Sidecar failure                       | Required sidecar missing, wrong platform, incomplete evidence, or digest mismatch.                       | One-click readiness or activation is blocked; no independent sidecar updater is introduced.                              | `update-preflight.test.ts`, `update-portable-staging.test.ts`, `portable-runtime.test.mjs`.      |
| Staging success                       | Asset downloads and verifies.                                                                            | Stage summary and audit events are content-free; no payload path or private URL is persisted.                            | `update-portable-staging.test.ts`, `update-local-state.test.ts`.                                 |
| Activation success                    | Staged install promotes, registration/shortcut refresh succeeds, relaunch/version verification succeeds. | Session can proceed to success only if remediation says the update can complete.                                         | `update-portable-activation.test.ts`, `update-session.test.ts`.                                  |
| Activation failure                    | Candidate incomplete, registration refresh fails, relaunch fails, or version verification fails.         | Failure is retryable where safe; current install is preserved when possible.                                             | `update-portable-activation.test.ts`, `update-session.test.ts`.                                  |
| Pending remediation                   | Release-impact/local health requires follow-up after activation.                                         | Update remains non-terminal; affected features are unavailable or degraded until action completes or is safely deferred. | `update-integration.test.ts`, `update-remediation.test.ts`, `update-remediation-routes.test.ts`. |
| Remediation failure                   | User-approved remediation fails or throws.                                                               | Full update completion remains blocked and state is resumable/content-free.                                              | `update-remediation.test.ts`.                                                                    |
| Safe remediation defer                | Deferrable follow-up is deferred.                                                                        | Affected features are marked degraded and update completion may proceed only when safe.                                  | `update-remediation.test.ts`.                                                                    |
| UI blocked path                       | Portable asset malformed or install mode ineligible.                                                     | Update window exposes retry/check/current-details/manual-download paths only; no shell-primary or legacy tab UX.         | `UpdateWindow.test.tsx`, `update-ui-1696.spec.ts`.                                               |
| CLI compatibility path                | User invokes `keiko update` from a supported package-manager install.                                    | npm/Yarn compatibility remains, but portable-managed output does not promote package-manager commands.                   | `update.test.ts`, `update-output.ts`.                                                            |

## Security Settlement

- Public update metadata stays server-side; the browser only calls the local BFF.
- GitHub Release Assets are used for portable installability; release-impact remains the
  compatibility and remediation source of truth.
- Mutation is explicit, user-approved, policy-gated, lock-guarded, and unavailable for unsupported
  install modes.
- Archive staging rejects traversal, wrong-root entries, symlink escapes, missing runtime files, and
  digest mismatch before activation.
- Production portable manifests fail closed on unverified signing/notarization, rollback eligibility,
  secrets, private paths, credential URLs, raw logs, package-manager output, and state payload
  references.
- Runtime state persists content-free summaries only: target, asset identifiers, hashes, status,
  warning codes, stage/activation ids, and remediation status. It does not persist customer
  repositories, prompts, model output, package payloads, raw logs, private paths, or credentials.

## UX Settlement

- The primary portable user journey stays download once, click launcher, then use the existing update
  notice/window with one explicit update action.
- Eligible portable-managed updates do not ask for terminal commands, manual restart, or manual
  version verification on the happy path.
- Blocked paths show only implemented recovery: retry/check again, open current version when safe,
  view redacted details, choose another location where setup owns that decision, or download latest
  manually.
- npm/Yarn remains compatibility-only. No legacy tab or channel chooser is promoted in the app.
- Remediation remains visible, resumable, and blocking/degraded as dictated by release-impact/local
  health state.

## Verification Commands

Run from the repository root when refreshing #1960 evidence:

```sh
npm run build:packages
npx vitest run packages/keiko-contracts/src/update-session.test.ts packages/keiko-server/src/update-install-mode.test.ts packages/keiko-server/src/update-preflight.test.ts packages/keiko-server/src/update-portable-staging.test.ts packages/keiko-server/src/update-portable-activation.test.ts packages/keiko-server/src/update-session.test.ts packages/keiko-server/src/update-session-routes.test.ts packages/keiko-server/src/update-integration.test.ts packages/keiko-server/src/update-local-state.test.ts packages/keiko-server/src/update-remediation.test.ts packages/keiko-server/src/update-remediation-routes.test.ts packages/keiko-cli/src/update.test.ts
npx vitest run scripts/__tests__/portable-runtime.test.mjs scripts/__tests__/release-portable-assets-workflow.test.mjs scripts/__tests__/release-publish-pipeline.test.mjs scripts/__tests__/portable-launch-setup-smoke.test.mjs scripts/__tests__/release-impact-governance.test.mjs scripts/__tests__/release-impact-notes.test.mjs
npm --workspace @oscharko-dev/keiko-ui run test -- src/lib/api.test.ts src/app/components/desktop/update/UpdateWindow.test.tsx src/app/components/desktop/update/UpdateStartupNotice.test.tsx
npm run test:e2e:update-ui-1696
npm run typecheck
npm run lint
npm run format:check
npm test
npm run arch:check
npm run arch:check:negative
.keiko-scripts/verify-receipt.sh 1960
.keiko-scripts/audit-receipt.sh 1960 --findings 0 --user-facing false
```

Final program QA in #1961 must re-run the integrated program evidence after the latest `dev` sync and
must prove the complete first-run setup plus updater journey before any `dev` PR is marked ready for
human review.

## Known Limits And Follow-ups

The following remain intentionally out of #1960 and #1945:

- Rollback and downgrade UX.
- Enterprise-managed rollout, MDM, MSI/MSIX/PKG/DMG, privileged helper, or admin elevation.
- Organization-managed update control surfaces or support-center workflows.
- Private channels, prerelease channels, canary channels, silent background updates, and remote
  backups.
- Final all-platform release artifact execution against real signed production binaries. #1961 owns
  integrated release QA for the full program branch.
