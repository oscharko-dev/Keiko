# ADR-0043: Enforced execution isolation (`@oscharko-dev/keiko-sandbox`)

## Status

Proposed (2026-06-20). Authored for Issue
[#1202](https://github.com/oscharko-dev/Keiko/issues/1202) (Parent Epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189)) under an explicit owner decision to build
the enforced egress-isolation primitive that unblocks editor-driven test generation. This ADR is the
citable decision record referenced by the new `keiko-sandbox` package, the `network: "none"`
enforcement at the keiko-tools spawn boundary, and the honest network-enforcement flag in
keiko-verification. It supersedes the dangling "ADR-0006 / ADR-0007" isolation references that earlier
code comments anticipated (no such files existed); those comments are updated to cite ADR-0043.

## Date

2026-06-20

## Version

1.0

## Context

The Keiko Editor epic's wave-2 surface (Issue #1202) generates unit tests and, before surfacing a
candidate as apply-ready, runs an **assured pre-filter** that **executes untrusted, model-generated
code** (build → pass → stability N≥5 → coverage increase → mutation/oracle strength). Executing
model-generated code is the highest-risk operation in the editor flow (OWASP LLM05: improper output
handling — data exfiltration, supply-chain callbacks, reverse shells). The Review Addenda and the
owner therefore required that this execution happen in an **isolated context with an enforced,
deny-by-default network-egress boundary, proven by an automated test in which an outbound connection
from the runner fails**.

Before this ADR, the platform could not provide that boundary: `keiko-contracts/src/tools.ts` shipped
`DEFAULT_SANDBOX_POLICY.network = "inherit"`, `keiko-verification/src/limits.ts` reported the network
dimension `enforced: false`, and no code path honoured `NetworkPolicy "none"`. The capability was
described as "deferred to the container wave" with no implementation. Issue #1202 was correctly held
open as blocked on this missing capability.

The product must run on macOS, Linux, and Windows. Enforced network isolation is an OS/kernel concern
with no single cross-platform API: Linux has unprivileged network namespaces (bubblewrap / `unshare
--net`); macOS has the Seatbelt sandbox (`sandbox-exec`); Windows has no native unprivileged
equivalent and relies on a container runtime. A container runtime (`docker`/`podman run
--network=none`) is the one primitive that enforces egress identically on all three.

## Decision

### D1 — A dedicated, reusable isolation package

Introduce `@oscharko-dev/keiko-sandbox`, a near-leaf package (depends only on `keiko-contracts` for
the `SandboxPolicy`/`NetworkPolicy`/attestation types). It owns the **isolation strategy only**:
backend availability probing, deterministic per-platform backend selection, pure construction of the
wrapper argv/profile that denies egress, a content-free `SandboxAttestation` (`{ backend,
networkEnforced, platform }`), and the fail-closed verdict. It performs **no process spawning** — the
wrapper builders and selection are pure functions, the probe is a thin filesystem read. The package is
the platform's reusable isolation brain, consumable anywhere an enforced run is needed.

### D2 — One spawn boundary applies the wrapper

The single subprocess boundary remains `keiko-tools/src/exec.ts` `runCommand`. When a caller passes
`policy.network === "none"`, `runCommand` asks keiko-sandbox for an enforcing wrapper and spawns the
wrapped command, recording the attestation on `CommandResult`. No second spawning path is introduced
(preserving the ADR-0019 invariant that verification and tools share one command boundary). Callers
that do not request `network: "none"` are unaffected — egress enforcement is opt-in per call, so the
read-only command tools keep `network: "inherit"` and their existing behaviour.

### D3 — Hybrid backends, fail-closed

keiko-sandbox selects, per platform: bubblewrap (`bwrap --unshare-net`) then `unshare --map-root-user
--net` on Linux; `sandbox-exec` with a `deny network-outbound` Seatbelt profile (loopback/unix
sockets allowed) on macOS; and a container runtime (`docker`/`podman run --network=none`) as the
universal fallback, primarily for Windows. If no enforcing backend is available, the decision is
**fail-closed**: `runCommand` rejects before spawning and the assured pre-filter reports the candidate
as **untrusted evidence only** (`unverified`), never `assured`. Untrusted code is never executed
without an enforced boundary.

### D4 — Honest enforcement reporting

`keiko-verification`'s `buildAppliedLimits` derives the network dimension's `enforced` flag from the
run's attestation rather than a hardcoded `false`, and the keiko-tools command audit metadata records
`networkEnforced`/`backend`. The platform's self-reported isolation posture now matches reality.

### D5 — CI-proven egress denial

A live egress proof (`packages/keiko-sandbox/src/egress.test.ts`) spawns the host's selected backend
and asserts that an outbound TCP connection from inside `network: "none"` **fails** while the same
connection succeeds without isolation (a negative control proves the test is meaningful). It is wired
into the required `ci` job (which installs bubblewrap and relaxes the Ubuntu 24.04 unprivileged-userns
restriction) as a non-skippable step, so the boundary is proven on every run. Locally it runs under
Seatbelt on macOS.

### D6 — Shared isolated-execution path for #1204/#1206

The enforced `network: "none"` boundary is the single isolated-execution path the editor verification
issues (#1204 post-apply verification, #1206 model/secret boundary) reuse. #1202 is its first
consumer via the assured pre-filter's disposable execution root; the project-specific toolchain
harness composed on top (copy → baseline → apply → gates → dispose) is expressed over injectable
ports so #1204 can generalise it without a parallel spawn path.

### D7 — Merge governance (this delivery)

By explicit owner decision for this delivery, the implementing PR may be merged autonomously once the
required `ci` check is green and review has settled — a documented departure from ADR-0042 D8's
owner-gated merge for the editor integration line, scoped to this change.

## Consequences

- `NetworkPolicy "none"` is now a real, enforced control; `DEFAULT_SANDBOX_POLICY.network` stays
  `"inherit"` so the blast radius is limited to callers that explicitly opt in.
- The security posture is strictly stronger: untrusted-code execution is gated behind an enforced,
  CI-proven egress boundary, or it does not run at all.
- Windows enforced egress depends on a container runtime being installed at run time; without one (or
  any other backend) the pre-filter fails closed. The CI proof runs on the Linux `ci` host.
- No new npm runtime dependency is added — backends are system binaries spawned through the existing
  boundary, so the supply-chain and SBOM surface is unchanged.
- Architecture boundaries are extended, not relaxed: keiko-tools and keiko-server may depend on
  keiko-sandbox (dependency-cruiser rules + package-graph allowlist updated); keiko-sandbox may depend
  only on keiko-contracts.

## Amendment — Issue #1204 realises D6 (2026-06-20)

Authored for Issue [#1204](https://github.com/oscharko-dev/Keiko/issues/1204) under an explicit owner
decision to build the editor patch-apply + post-apply verification surface on the enforced boundary this
ADR introduced. It records the consuming decisions; it relaxes nothing in D1–D7.

### D8 — Backend-aware enforced verification (the realisation of D6)

D2 left `keiko-verification`'s `policyForStep` hardcoded to `network:"inherit"` with a comment that
"enforced verification isolation is owned by #1204". #1204 makes the orchestrator **backend-aware**:
`VerificationDeps` gains a `networkEnforcement` mode (`"inherit"` | `"enforce-or-degrade"` |
`"enforce-or-fail-closed"`, default `"enforce-or-fail-closed"`) and an injected
`enforcedNetworkAvailable` flag, and `policyForStep` honours the resolved per-step network. A
`network:"none"` verification step now fails closed by default unless the caller attests an enforcing
backend; callers that intentionally need inherited network must pass `"inherit"` explicitly. The
honest `enforced` flag in `appliedLimits` is now derived from the run's `SandboxAttestation` (D4)
rather than left `false`.

keiko-verification stays free of a keiko-sandbox dependency: the caller (keiko-server, which already
depends on keiko-sandbox) probes once via `probeNetworkIsolation` and injects the boolean. The editor
post-apply path runs `"enforce-or-fail-closed"` — it executes the applied test under an enforced
`network:"none"` boundary or not at all.

### D9 — Network-only isolation for in-place post-apply verification

The assured pre-filter (#1202) runs in a disposable execution-root copy (`filesystem:"execution-root"`).
Post-apply verification (#1204) is a different operation: it re-confirms an already-assured candidate
**in place**, against the real workspace the user explicitly applied the patch to, so it enforces
**network egress only** (`filesystem` inherited). A `network:"none"` run is enforceable on more backends
(macOS Seatbelt, Linux bubblewrap/`unshare`) than the execution-root boundary, widening coverage while
keeping the data-exfiltration threat (OWASP LLM05) blocked.

### D10 — Merge governance for this delivery

By explicit owner decision for this delivery (mirroring D7), the #1204 PR may be merged autonomously into
the epic integration branch `feat/keiko-editor` once the required `ci` check is green and review has
settled. This is the same scoped departure from ADR-0042 D8's owner-gated merge for the editor
integration line; it does not authorise autonomous merge into the protected release line.
