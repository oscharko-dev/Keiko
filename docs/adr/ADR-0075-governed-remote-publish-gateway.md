# ADR-0075: Governed Remote Publish Gateway for Push and Upstream Orchestration

## Status

Accepted

## Context

Epic #470 has built the governed Git delivery stack through five prior slices:

- ADR-0070 (#471): typed contract surface — action kinds, risk taxonomy, lifecycle envelope, policy evaluator.
- ADR-0071 (#472): mutation kernel — single execution authority (`runGitMutation`), preflight evaluators, narrow **local** adapter port, no-shell spawn boundary.
- ADR-0072 (#473): approval and preview presentation layer — content-free action sheet, BFF projection route.
- ADR-0073 (#474): evidence ledger — bounded append-only record for every terminal outcome, audit-export route.
- ADR-0074 (#475): first end-user-visible local flows — branch / staging / commit with interactive preview, commit-intent composition.

Issue #476 adds the **governed publish layer**: it turns local commit completion into safe remote delivery. `git push` must stop being a raw transport call and become a controlled publish workflow with explicit preview, policy enforcement, and recovery semantics. This is the point where local quality meets shared-team risk, so the controls become stricter, not looser.

The #472 kernel deliberately deferred this slice. Its command union comment states remote kinds are "delivered by later slices (#476–#478) that extend this union and register their executors", and its local adapter allowlist (`GIT_MUTATION_ALLOWED_SUBCOMMANDS`) deliberately excludes `push/fetch/pull/clone` because "remote and provider execution is a later slice (#476–#478) **behind a separate gateway, never this local adapter**". Issue #476 honours both statements.

Six forces constrain the design:

**Force 1 — Separate remote authority, never the local adapter.** The narrow `GitLocalMutationAdapter` (ADR-0071) is the local write authority and must stay network-free. A push subcommand must never become reachable through it. Remote execution belongs to a dedicated gateway with its own dedicated allowlist.

**Force 2 — Reuse the kernel's pure machinery.** Preflight (`evaluateGitPreflight`, push case already present since #472), policy (`evaluateGitPolicy`), the lifecycle-result shape (`GitMutationLifecycleResult`), and the evidence builder (`buildGitDeliveryEvidenceRecord`, push case already present since #474) are reused unchanged. No second policy system, no second evidence schema.

**Force 3 — Stricter for protected and shared targets.** A push to a protected or shared branch must trigger stricter approval or blocking behaviour according to policy rather than being treated like an ordinary user branch. Risk escalation is data on the policy pack, not inferred from a branch-name string at the call site.

**Force 4 — Force-push blocked by default.** Force-relevant or history-rewrite-adjacent publish behaviour is blocked by default. There is no force path in #476: the policy ceiling blocks it, and the pure argv builder additionally refuses to emit a force flag (defence in depth).

**Force 5 — Content-free, but recover without guessing.** Evidence and wire payloads carry typed codes, counts, flags, and branch/remote NAMES only — never raw command output, diff content, or secrets. Yet non-fast-forward, missing-upstream, and auth/permission failures must be categorised clearly enough that a user can recover without guessing (AC3). The richer publish-rejection taxonomy is derived inside the trusted tools layer from git's own status phrases and surfaced as typed enum tokens — never raw stderr.

**Force 6 — Evidence for allowed AND blocked attempts.** Every publish attempt — permitted, preflight-blocked, policy-blocked, approval-held, executed-and-rejected — records a content-free evidence record (AC5). Remote publish cannot bypass preview, policy, or evidence capture.

### Scope boundary (Issue #476)

In scope: a dedicated remote publish gateway in keiko-tools (pure orchestrator + narrow remote adapter port + dedicated push allowlist + publish-rejection taxonomy); a Node push executor that classifies rejections from git output; a non-fast-forward preflight finding; server push preview/execute routes reusing the gateway, ledger, and a default-safe publish policy pack; a publish section in the existing governed flow card; integration/browser evidence.

Out of scope: full PR creation flow beyond a minimal bootstrap hook (#477), merge execution (#478), force-push or history rewrite, a network reachability pre-probe (reachability is classified at execution time), and any widening of the read-only terminal allowlist or the local mutation allowlist.

### Cross-branch ADR numbering

The governed-git feat branch uses ADR numbers 0058–0063. An independent voice-digital-twin feat branch independently used 0058–0069. These are non-conflicting while both branches are un-merged to `dev`; numbers are per-branch-local until a feat-to-dev PR is opened. The merge coordinator must verify global ADR sequencing on `dev` before merging.

## Decision

We will introduce a dedicated remote publish gateway in keiko-tools, a Node push executor on the existing internal subpath, one additive preflight finding, two new server routes reusing the kernel machinery and the ledger, a default-safe publish policy pack, and a publish section in the existing governed flow card. keiko-contracts is **not** modified — the push input shape, execution error codes, and recovery vocabulary it already defines are sufficient.

### D1 — The publish gateway is a parallel execution authority, not an extension of the local adapter

`packages/keiko-tools/src/git-publish-gateway.ts` (pure) defines:

- `GitPushCommand` — the concrete push operands (`sourceBranchName`, `remoteAlias`, `remoteBranchName`, `forcePush`, `setUpstreamTracking`).
- `GitRemotePublishAdapter` — the narrow remote port with a single typed method `publish(req)`. Like the local adapter, it has **no** generic `run(args)` escape hatch.
- `GIT_PUBLISH_ALLOWED_SUBCOMMANDS = ["push"]` and `GIT_PUBLISH_COMMAND_RULES` — a dedicated allowlist, structurally separate from both the read-only inspection rules and the local mutation rules. It permits only `push`, and mirrors the mutation rules' defence-in-depth flag denials.
- `buildPushArgv(req)` — a pure argv builder that validates operands (no NUL, no flag-injection on refs/aliases), emits a single explicit refspec `src:dst`, adds `--set-upstream` only when requested, and **refuses to build any force argv** (throws on `forcePush === true`).
- `runGitPublish(request, deps)` — the publish lifecycle orchestrator. It reuses `evaluateGitPreflight` (push case), `evaluateGitPolicy`, and the approval/constraint gate logic to produce a `GitMutationLifecycleResult` of kind `push`, executing through the injected `GitRemotePublishAdapter` only when preflight passes, policy permits, and any required approval is satisfied. It returns a `GitPublishLifecycleResult` that wraps the lifecycle result with the live publish-rejection reason and a recovery hint.

The local kernel (`runGitMutation`) and the local adapter are **unchanged**. The structural invariant tests proving the local allowlist excludes network verbs remain true because push never flows through the local adapter.

### D2 — The publish-rejection taxonomy is derived in the trusted layer, surfaced as typed tokens

`GitPublishRejectionReason` is a closed union: `non-fast-forward | fetch-first | no-upstream | auth-failed | permission-denied | protected-ref | remote-unavailable | unknown`. The Node executor (`git-publish-node.ts`) classifies a non-zero `git push` exit by matching git's own English status phrases in the captured (secret-redacted) output via the pure `classifyGitPublishRejection` matcher, then maps the reason to:

- a content-free `GitDeliveryExecutionErrorCode` (`gitPublishRejectionToErrorCode`) recorded in evidence — `non-fast-forward`/`fetch-first` → `precondition-failed`; `auth-failed`/`permission-denied`/`protected-ref` → `provider-rejected`; `remote-unavailable` → `network-failure`; `no-upstream` → `precondition-failed`; `unknown` → `provider-rejected`; and
- a reused `GitDeliveryRecoveryHint` (`gitPublishRecoveryHintFor`) carrying the #473 action-hint vocabulary and the #474 three-way disposition, surfaced live so the user reads "configure upstream" / "integrate remote changes" / "request access" rather than a bare error code.

Raw stderr never leaves the executor. Only the typed reason, the error code, and the recovery hint cross the boundary.

### D3 — Non-fast-forward is detected before execution as well as during

`git-mutation-preflight.ts` gains one additive finding code `non-fast-forward`. `preflightPush` emits it (blocking, user-actionable) when the snapshot reports `behindCount > 0` and the push is not a force push: the local branch is behind its upstream, so a normal push cannot fast-forward. This is best-effort divergence detection from the tracking ref (no network probe). The authoritative non-fast-forward signal is still produced at execution time by D2's rejection classification, so detection is layered (before and during), satisfying AC3 without adding a network read to the inspection path. The exhaustive `ACTION_HINT_BY_PREFLIGHT_FINDING` evidence table receives the new case (compile-enforced).

### D4 — Protected and shared targets are stricter by policy data, not call-site logic

`KEIKO_DEFAULT_PUBLISH_POLICY_PACK` (server, alongside `KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK`) authorises `push` as `constrained` by two constraints: a `risk-class-ceiling` of `publish` (which blocks force-push, classed `recovery-or-rewrite`, satisfying Force 4) and a `branch-pattern` allow-list of safe publish namespaces (`claude/`, `feat/`, `fix/`, `chore/`, `docs/`). A push whose remote target does not match a safe namespace — e.g. `dev`, `main`, `release/*`, or any other shared/protected branch — fails the branch-pattern constraint and is blocked with `policy-pack-blocked`. Protected and shared targets are therefore treated more strictly than ordinary user branches purely by policy data. Operators who require approval-gating (rather than blocking) for a protected target author an org or repo pack with an `approval-gated` rule; the evaluator already supports that decision, so no code changes for that posture. The default pack is fail-closed: publish is only ever evaluated when governed git delivery is enabled, and any target outside the safe namespaces is denied.

### D5 — The publish lifecycle reuses the ledger and the response projection

`executeGovernedPublish` (server) mirrors `executeGovernedMutation`: resolve and authorise the project workspace, read a trustworthy snapshot, run `runGitPublish`, and append a content-free evidence record via the existing `recordGitDeliveryMutationEvidence` and `buildGitDeliveryEvidenceRecord` (which already projects push `remoteRefHash`). Evidence is recorded for the permitted-and-executed path and for every blocked/held path before the route responds. The push preview route is read-only — snapshot, preflight, policy projection, no execution, no evidence — exactly the action-sheet/commit-preview pattern (ADR-0072 D2 / ADR-0074 D2).

## Consequences

### Positive

- Remote publish becomes governed end-to-end with no parallel orchestrator, no new evidence schema, no new approval model, and zero contract change — the kernel's pure machinery is reused.
- The local mutation authority stays network-free: push is reachable only through the dedicated gateway and its single-subcommand allowlist, preserving the ADR-0071 invariant.
- Force-push is blocked by two independent mechanisms (policy ceiling + argv-builder refusal); neither can be bypassed from the request body.
- Protected/shared-target strictness is authored as policy data, so a team can tighten or relax it (block vs approval-gate) without code changes.
- Non-fast-forward, missing-upstream, and auth/permission failures each map to a distinct typed recovery hint, so users recover without guessing while evidence stays content-free.

### Negative

- The publish gateway reimplements a thin slice of the policy/approval gate logic that the local orchestrator also contains, because the lifecycle is genuinely a separate (remote) execution authority. The duplication is bounded (gate resolution + envelope assembly) and is covered by its own tests.
- Pre-execution non-fast-forward detection relies on the tracking-ref distance in the snapshot, which can be stale relative to the live remote. The authoritative signal is the execution-time rejection; the preflight finding is an advisory-grade early warning surfaced as blocking to stop an obviously-doomed push.
- A push performs network egress under the default `inherit` sandbox network policy. This is intended for publish but means the publish executor — unlike the local mutation adapter — depends on outbound connectivity, adding `remote-unavailable` as a transient failure mode.

### Neutral

- The publish allowlist has its own command rule set, structurally separate from the mutation and inspection rule sets. Adding a subcommand to one never touches the others.
- `KEIKO_DEFAULT_PUBLISH_POLICY_PACK` encodes this repository's branch conventions. A deployment with different conventions overrides it via injected server config; no default behaviour changes until governed git delivery is explicitly enabled.
- The governed-git branch uses ADR numbers 0058–0063; the merge coordinator resolves the global sequence at feat-to-dev merge.

## Alternatives Considered

### Alternative 1: Extend the local adapter / `runGitMutation` union with a push kind

- **Pros**: One execution authority; reuses the existing dispatch and envelope assembly directly.
- **Cons**: Adds a network verb to the kernel that the local adapter would have to dispatch, eroding the ADR-0071 invariant that local writes can never reach a network subcommand. The local adapter's allowlist exclusion of `push` and its structural "no network verb" tests would have to be relaxed or specially-cased. The push execution also needs richer rejection data than the local adapter's `GitDeliveryExecutionResult`-only return allows.
- **Why rejected**: Force 1. The #472 comment explicitly places remote execution "behind a separate gateway, never this local adapter". A parallel gateway keeps the local authority network-free and lets the remote path return its richer typed rejection.

### Alternative 2: Surface raw `git push` stderr to the user for recovery guidance

- **Pros**: Maximally informative; no taxonomy to maintain.
- **Cons**: Violates the content-free invariant (Force 5). Push stderr can carry remote URLs, tokens embedded in URLs, hostnames, and path fragments. Persisting or returning it would leak across the trust boundary.
- **Why rejected**: The typed `GitPublishRejectionReason` + reused `GitDeliveryRecoveryHint` deliver "recover without guessing" while keeping the wire and the ledger content-free.

### Alternative 3: Probe remote reachability with `git ls-remote` during preview

- **Pros**: Detects auth/permission/divergence before the user executes.
- **Cons**: Adds a network subcommand to the read-only inspection allowlist, performs network egress on every preview (a read-only, frequently-called path), and duplicates the execution-time classification. Auth/permission/remote-moved are inherently execution-time facts.
- **Why rejected**: Reachability and auth/permission are classified at execution time from the real push attempt (D2); non-fast-forward is detected pre-execution from the tracking ref (D3). Adding a network read to the preview path is unnecessary egress for a marginal early-warning gain.

### Alternative 4: Allow force-push behind an approval token now

- **Pros**: Completes the publish surface in one slice.
- **Cons**: Force-push is history-rewrite-adjacent and explicitly out of scope (#476 Out of Scope). An approval path for force would need its own policy semantics, audit treatment, and recovery model.
- **Why rejected**: AC4 requires force-push blocked by default "unless an explicit future policy path allows it". The argv builder refuses force and the default ceiling blocks it; a future ADR can introduce a governed force path with its own controls.

## Related

- ADR-0070: Governed Git delivery contracts (push input shape, execution error codes, recovery vocabulary reused unchanged)
- ADR-0071: Governed Git mutation execution kernel (local adapter network-free invariant preserved; preflight push case reused)
- ADR-0072: Governed Git approval and preview surface (read-only BFF preview pattern; `isGitDeliveryTrusted` gate reused)
- ADR-0073: Governed Git mutation evidence ledger (`recordGitDeliveryMutationEvidence` / `buildGitDeliveryEvidenceRecord` push projection reused)
- ADR-0074: Governed local Git flows (governed flow card extended with a publish section; execution wiring pattern mirrored)
- ADR-0019: Modular Package Architecture (leaf-package rule; dependency direction; `arch:check`)
- ADR-0018: Terminal allowlist (read-only baseline preserved; push NOT added to it)
- ADR-0043: Sandbox network enforcement (push uses `inherit`; `none` honoured elsewhere)
- Issue #476: Safe publish orchestration for push, upstream handling, and protected-target awareness (this ADR)
- Issues #477–#478: PR command center, merge governance (next children; extend provider execution)
- Issue #470: Epic — governed end-to-end Git delivery

## Date

2026-06-25
