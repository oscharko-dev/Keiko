# Editor patch apply, verification orchestration, and evidence linkage (Issue #1204)

Issue [#1204](https://github.com/oscharko-dev/Keiko/issues/1204) (Parent Epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189)) completes the generated-test lifecycle from
the editor flow: explicit patch apply with guardrails, post-apply verification in an enforced isolation
boundary, evidence linkage across proposal → apply → verification, and a guarded revert proposal on
failure. It is wave-2 work, unblocked by the enforced deny-by-default egress boundary delivered in
[#1202](https://github.com/oscharko-dev/Keiko/issues/1202) (ADR-0043). This document records the
behaviour and, in particular, the **isolation boundary** the post-apply verification runs under
(Review Addendum AC: "the isolation boundary is documented").

## Surface

`POST /api/editor/patch-apply` (`packages/keiko-server/src/editor/patchApplyRoutes.ts`). Wave-2, shipped
**switched off**: the route is gated behind `KEIKO_EDITOR_PATCH_APPLY` (default off → `disabled`, no
validation, write, or execution). Post-apply verification runs **by default** when apply is enabled and
is skipped only when explicitly disabled — by deployment policy
(`KEIKO_EDITOR_PATCH_APPLY_VERIFICATION` set to a disable token) or per request (`verify: false`). Both
branches are covered by tests.

## Apply (deterministic, fail-closed)

The reviewable candidate's unified diff is round-tripped from the generation response
(`EditorTestGenerationWireResponse.applyableDiff`) and re-validated from scratch — the client's framing
is never trusted (ADR-0042 D2: the browser never parses the diff; the server does). Apply reuses the
keiko-tools patch workflow (`validatePatch` → `applyPatch`), which provides, for free:

- **Explicit decision (AC1).** A patch is applied only on an explicit `"apply"` decision; `"reject"`
  mutates nothing.
- **Scope validation (AC2).** `validatePatch` rejects any target path that escapes the workspace or
  matches an always-on deny pattern (`out-of-scope`).
- **No silent overwrite (AC7/AC14).** A create whose target already exists is rejected
  (`would-overwrite`) unless the user explicitly confirms (`allowOverwrite: true`), threaded through
  keiko-tools as a new opt-in `allowOverwrite` apply option (default false = no-silent-overwrite).
- **Write-conflict detection.** A target that changed after the patch was proposed fails the per-hunk
  pre-image check (`write-conflict`).
- **Bounded patches and atomic application.** Size/line/file limits are enforced; multi-file apply is
  atomic with rollback.

## Post-apply verification isolation boundary

After a successful apply, the just-applied test file(s) are re-confirmed **in place** as a targeted-test
step through the keiko-verification orchestrator (`packages/keiko-server/src/editor/postApplyVerification.ts`).
This is a confirmation that an already-assured candidate still holds (integration + write-conflict); it
does **not** re-run the generation-time mutation/coverage gate (that stays in #1202/#1203).

The execution boundary (Review Addendum / owner addendum):

| Dimension             | Control                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network egress        | **`network:"none"`, OS/container-enforced via keiko-sandbox (ADR-0043)** when an enforcing backend is available; otherwise **fail-closed** (the untrusted test is not executed).                                                                               |
| Wall-time             | Bounded (`DEFAULT_VERIFICATION_LIMITS.wallTimeMs`), enforced by the keiko-tools command boundary.                                                                                                                                                              |
| Output                | Bounded (`maxOutputBytes`) and redacted before it leaves the boundary.                                                                                                                                                                                         |
| Environment           | A fixed env allowlist; `HOME`/`USERPROFILE` are scrubbed by keiko-sandbox (no credential leakage).                                                                                                                                                             |
| Filesystem            | **Inherited** — the applied test legitimately reads the real workspace where the user applied the patch. Egress (the exfiltration threat) is the enforced control; the disposable execution-root boundary is the generation-time pre-filter's concern (#1202). |
| Process tree / memory | Bounded by the orchestrator's resource monitor.                                                                                                                                                                                                                |

**Backend-aware enforcement.** The keiko-verification orchestrator's `policyForStep` is now backend-aware
(`VerificationDeps.networkEnforcement` + `enforcedNetworkAvailable`). The default mode (`"inherit"`)
preserves the historical behaviour byte-for-byte for every existing caller. The editor post-apply path
runs in `"enforce-or-fail-closed"`: it probes keiko-sandbox once (`probeNetworkIsolation`), requests an
enforced `network:"none"` run when a backend exists, and **denies the step before spawning** when none
does — untrusted, model-generated code never runs without an enforced egress boundary. The
`appliedLimits` network dimension reports the enforcement honestly from the run's sandbox attestation
(ADR-0043 D4).

**Egress proven, not documented (AC8/AC12/AC15).** The canonical, CI-non-skippable proof is
`packages/keiko-sandbox/src/egress.test.ts` (an outbound TCP connection from inside `network:"none"`
fails, with a negative control). The post-apply verification traverses the same
`runCommand({ policy: { network: "none" } })` boundary; `postApplyVerification.test.ts` adds a
host-adaptive proof that this exact boundary blocks egress and attests `networkEnforced`.

## Evidence linkage (proposal → apply → verification)

Three lifecycle phases are recorded distinctly and tied together by the shared, content-free `patchId`
correlation (`packages/keiko-server/src/editor/patchApplyEvidence.ts`):

- **proposal** — recorded by the test-generation evidence (#1202).
- **apply** — decision, outcome status, content-free change counts, and rejection reason enums.
- **verification** — command label, hashed root, timeout, env-allowlist size, network status, sandbox
  backend, secret-redaction status, and pre/post-apply flag (owner addendum AC13).

Every record is content-free: enum literals, counts, and SHA-256 hashes only — never patch text, a test
log line, a workspace path, or a secret.

## Guarded rollback (no silent revert)

When post-apply verification fails, the response carries a **guarded revert proposal**: the inverse
unified diff (`invertPatch`) that restores the pre-apply state, surfaced for the user to review and
explicitly re-apply through the same route. The server never reverts silently (Out of Scope: "Silent
rollback without user approval") and performs no unreviewed follow-up mutation (AC5).

## Browser/UI status

The host control plane (`requestEditorPatchApply`) and the content-free status adapter
(`mapWireToPatchApplyView`) surface the apply/reject/verify outcome — applied counts, the verification
outcome and isolation posture, rejection reasons, and the guarded revert availability — as a tone +
announce-able headline. The apply/reject/verify flow is proven by the server-route integration tests
(apply, reject, out-of-scope, would-overwrite, write-conflict, invalid, verification-passed,
verification-failed-with-revert, skipped, denied) and the adapter tests. Wiring the apply control into
the editor card's diff-preview surface lands with the test-generation feature enablement; the feature is
default-off and no Playwright `@smoke` runs on `feat/keiko-editor` PRs.
