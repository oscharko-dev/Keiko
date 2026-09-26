# ADR-0085: Governed Remote Publish Gateway for Push and Upstream Orchestration

## Status

Accepted

## Context

Epic #470 has built the governed Git delivery stack through five prior slices:

- ADR-0080 (#471): typed contract surface — action kinds, risk taxonomy, lifecycle envelope, policy evaluator.
- ADR-0081 (#472): mutation kernel — single execution authority (`runGitMutation`), preflight evaluators, narrow **local** adapter port, no-shell spawn boundary.
- ADR-0082 (#473): approval and preview presentation layer — content-free action sheet, BFF projection route.
- ADR-0083 (#474): evidence ledger — bounded append-only record for every terminal outcome, audit-export route.
- ADR-0084 (#475): first end-user-visible local flows — branch / staging / commit with interactive preview, commit-intent composition.

Issue #476 adds the **governed publish layer**: it turns local commit completion into safe remote delivery. `git push` must stop being a raw transport call and become a controlled publish workflow with explicit preview, policy enforcement, and recovery semantics. This is the point where local quality meets shared-team risk, so the controls become stricter, not looser.

The #472 kernel deliberately deferred this slice. Its command union comment states remote kinds are "delivered by later slices (#476–#478) that extend this union and register their executors", and its local adapter allowlist (`GIT_MUTATION_ALLOWED_SUBCOMMANDS`) deliberately excludes `push/fetch/pull/clone` because "remote and provider execution is a later slice (#476–#478) **behind a separate gateway, never this local adapter**". Issue #476 honours both statements.

Six forces constrain the design:

**Force 1 — Separate remote authority, never the local adapter.** The narrow `GitLocalMutationAdapter` (ADR-0081) is the local write authority and must stay network-free. A push subcommand must never become reachable through it. Remote execution belongs to a dedicated gateway with its own dedicated allowlist.

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

Issue-bound Workbench delivery (#3387) added a `verifiedCommitSha` operand to the same command,
contract and adapter, originally optional. A #3394 review of the merged slice found the field
enforced nowhere outside that one issue-bound path: the interactive/manual governed-git-flow route
built and dispatched an ordinary `<sourceBranchName>:<remoteBranchName>` push with no pinned commit
at all, so "a moving local branch can never substitute another commit after approval" was true only
for the one caller that happened to always populate the field, not as a property of the push
gateway itself. D6 below closes that gap: `verifiedCommitSha` is now `readonly verifiedCommitSha:
string` on `GitPushCommand` (mandatory, contract-validated as a complete 40- or 64-character Git
object id — `isGitObjectId`), and every push, from either dispatch path, pins an explicit
`<verifiedCommitSha>:refs/heads/<target>` refspec. There is no remaining code path that can build or
execute an unpinned push argv.

Two dispatch paths exist in the Node executor (`git-publish-node.ts`), selected by whether the
request carries a canonical GitHub URL (`remoteUrl === undefined ? runPinnedPush(...) :
runVerifiedPush(...)`), and both now share the mandatory-pinning invariant:

- **`runVerifiedPush`** — unchanged mechanism, issue-bound Workbench delivery only. The refspec is
  `<verifiedCommitSha>:refs/heads/<literal feature branch>`; a moving local branch can never
  substitute another commit after approval. This path still rejects upstream tracking setup, ref
  expressions, forced updates and non-branch destinations. The run owner binds the approved
  repository, remote, base and head, checks authority before dispatch and reconciles the actual
  remote head afterwards; the argv builder alone does not grant delivery authority. A real
  bare-remote test advances the local branch after approval and proves only the approved immutable
  commit is published.
- **`runPinnedPush`** — the interactive/manual governed-git-flow route, dispatching through the
  user's own configured remote alias (never a literal URL) via `buildPushArgv`'s pinned refspec.
  Unlike `runVerifiedPush` it now also honours `setUpstreamTracking`: a raw commit source cannot be
  tracked by `push --set-upstream` itself (`-u` silently no-ops on a SHA source), so tracking is
  established as a separate, local-only, no-network follow-up — `git branch
  --set-upstream-to=<remoteAlias>/<remoteBranchName> <sourceBranchName>` (`buildSetUpstreamToArgv`)
  — run through the SAME sandboxed publish executor immediately after a successful pinned push
  (`applyUpstreamTrackingIfRequested`). The follow-up is best-effort: its failure never undoes or
  fails the push, which has already succeeded by the time it runs. A failure (thrown, or a plain
  non-zero exit — `onTerminated` does not fire here, since it only covers a run the harness itself
  force-terminated, never an ordinary exit) is reported through the dedicated, content-free
  `onUpstreamTrackingFailure` seam, which the owning server logs via its existing activity-log port
  (`git.delivery.push.upstream-tracking-failed`, category `diagnostic`) — visibility for an operator,
  never a reason to change the push's own reported outcome (AGENTS.md §7/§8).

Verified issue-bound pushes also capture an exact canonical GitHub transport URL. The workspace
Git metadata owner creates a temporary minimal bare Git view in the existing executor-owned
ephemeral directory facility, outside both the authorized checkout and its Git metadata. It shares
only the authorized object store and bounded shallow identities. The dedicated push executor selects that view, suppresses
global/system Git configuration, disables HTTP redirects and passes the approved URL literally.
It never reopens the checkout's live remote, push-URL or URL-rewrite configuration for that effect.
The temporary view carries no source index, branch refs, hooks or original config and is removed
after the attempt. Pre-dispatch checks bind directory identities and the exact generated metadata
contents. The workspace boundary denies access to that external effect directory; protection from
an arbitrary process with the same host-user privileges is the separate runtime-containment
qualification (#2951), not a property of a temporary pathname or an inode check.
Existing authority, cancellation, environment redaction and the push-only
allowlist still apply. This is transient effect metadata, not another managed workspace or clone.

For that verified HTTPS path, Git uses the standard `gh auth git-credential` protocol through one
host-scoped helper after clearing inherited helpers. The helper executable is resolved by the
existing trusted PATH owner and its absolute path is quoted for Git's credential shell. It targets
only `https://github.com`, pins the gh host and noninteractive behavior, and refuses account/config
selectors resolving inside the managed workspace. Keiko does not invoke the helper separately or
read its credential bytes; Git and gh exchange them directly. SSH keeps its existing account/agent
lane. Hermetic tests exercise the actual Git credential protocol using synthetic values and prove
a hostile configured helper executes without the reset and is excluded with it; they do not qualify
live authentication or native Windows credential execution.

Preparation failures use the production factory's existing activity-log and structured diagnostic
ports with the run correlation. No remote URL, path or credential enters those events.

### D2 — The publish-rejection taxonomy is derived in the trusted layer, surfaced as typed tokens

`GitPublishRejectionReason` is a closed union: `non-fast-forward | fetch-first | no-upstream | auth-failed | permission-denied | protected-ref | remote-unavailable | unknown`. The Node executor (`git-publish-node.ts`) classifies a non-zero `git push` exit by matching git's own English status phrases in the captured (secret-redacted) output via the pure `classifyGitPublishRejection` matcher, then maps the reason to:

- a content-free `GitDeliveryExecutionErrorCode` (`gitPublishRejectionToErrorCode`) recorded in evidence — `non-fast-forward`/`fetch-first` → `precondition-failed`; `auth-failed`/`permission-denied`/`protected-ref` → `provider-rejected`; `remote-unavailable` → `network-failure`; `no-upstream` → `precondition-failed`; `unknown` → `provider-rejected`; and
- a reused `GitDeliveryRecoveryHint` (`gitPublishRecoveryHintFor`) carrying the #473 action-hint vocabulary and the #474 three-way disposition, surfaced live so the user reads "configure upstream" / "integrate remote changes" / "request access" rather than a bare error code.

Raw stderr never leaves the executor. Only the typed reason, the error code, and the recovery hint cross the boundary.

### D3 — Non-fast-forward is detected before execution as well as during

`git-mutation-preflight.ts` gains one additive finding code `non-fast-forward`. `preflightPush` emits it (blocking, user-actionable) when the snapshot reports `behindCount > 0` and the push is not a force push: the local branch is behind its upstream, so a normal push cannot fast-forward. This is best-effort divergence detection from the tracking ref (no network probe). The authoritative non-fast-forward signal is still produced at execution time by D2's rejection classification, so detection is layered (before and during), satisfying AC3 without adding a network read to the inspection path. The exhaustive `ACTION_HINT_BY_PREFLIGHT_FINDING` evidence table receives the new case (compile-enforced).

### D4 — Protected and shared targets are stricter by policy data, not call-site logic

`KEIKO_DEFAULT_PUBLISH_POLICY_PACK` (server, alongside `KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK`) authorises `push` as `constrained` by two constraints: a `risk-class-ceiling` of `publish` (which blocks force-push, classed `recovery-or-rewrite`, satisfying Force 4) and a `protected-branch` DENY-list of shared targets (`dev`, `develop`, `main`, `master`, `trunk`, `production`, `stable`, `release`, and the `release/` / `releases/` prefixes). A push whose remote target matches one of those fails the constraint and is blocked with `policy-pack-blocked`. Protected and shared targets are therefore treated more strictly than ordinary user branches purely by policy data.

**This is a deny-list, not an allow-list, and the difference is load-bearing.** An earlier revision of this ADR described a `branch-pattern` allow-list of safe namespaces (`claude/`, `feat/`, …), under which anything unlisted would be BLOCKED. The shipped constraint is the inverse: `KEIKO_PROTECTED_REMOTE_BRANCHES` enumerates the shared targets to refuse, and any branch not on that list is permitted. Both postures are defensible — the deny-list keeps ordinary feature work friction-free without needing every future naming convention pre-registered — but they fail in OPPOSITE directions for an unanticipated branch name, so the text now records the one the code actually implements. Operators wanting the stricter allow-list posture author it as an org or repo pack. Operators who require approval-gating (rather than blocking) for a protected target author an org or repo pack with an `approval-gated` rule; the evaluator already supports that decision, so no code changes for that posture. The default pack is fail-closed: publish is only ever evaluated when governed git delivery is enabled, and any target outside the safe namespaces is denied.

### D5 — The publish lifecycle reuses the ledger and the response projection

`executeGovernedPublish` (server) mirrors `executeGovernedMutation`: resolve and authorise the project workspace, read a trustworthy snapshot, run `runGitPublish`, append a content-free evidence record via the existing `recordGitDeliveryMutationEvidence` and `buildGitDeliveryEvidenceRecord` (which already projects push `remoteRefHash`), and — since the git activity-log wiring (AGENTS.md §8 Rule 1) — write one body-free activity-log line through the SAME `logGitDeliveryMutation` the local mutation path uses. The lifecycle shape is identical and `actionKind: "push"` is what separates the two in the log, so this reuses that vocabulary rather than minting a parallel op. Note the distinction the evidence ledger does not cover: the ledger is the audit artifact, the activity log is the operator's reconstruction record, and a publish used to appear in the first and not the second. Evidence is recorded for the permitted-and-executed path and for every blocked/held path before the route responds. The push preview route is read-only — snapshot, preflight, policy projection, no execution, no evidence — exactly the action-sheet/commit-preview pattern (ADR-0082 D2 / ADR-0084 D2).

The accepted Authority Envelope is re-checked immediately before remote dispatch. If continuity is
lost after admission, no process is spawned, the route returns the correlated 403 authority-denial
contract, and the existing mutation ledger records one `blocked` / `authority-denied` /
`policy-forbidden` terminal outcome rather than either dropping the attempt or persisting the
adapter's synthetic internal failure.

### D6 — `verifiedCommitSha` is mandatory on every push, and a new blocking preflight finding re-verifies it against the freshly read local head (#3394 review)

A review of the merged #476/#3387 slices (PR #3394) raised two findings. Finding 1: commit pinning
was optional on the governed push route's contract shape, so a caller of the interactive route
(never the issue-bound one) could omit `verifiedCommitSha` entirely and fall through to an unpinned
push — the "moving local branch can never substitute another commit after approval" guarantee D1
describes was therefore not a property of the gateway, only an accident of one caller's behaviour.
Finding 2 (mirrored in ADR-0086 D12) is that a mutated command could be approved for one commit and
executed after the branch moved, with nothing re-checking that the commit approved is the commit
that ships.

Both are closed the same way this gateway closes every other risk in its scope: as reusable kernel
machinery, not a call-site check.

- **The contract shape.** `GitDeliveryPushInputs.verifiedCommitSha` (`keiko-contracts/git-delivery.ts`)
  changes from `verifiedCommitSha?: string` to `readonly verifiedCommitSha: string`, and
  `isPushInputs` validates it unconditionally with the existing `isGitObjectId` guard — a request
  shaped without it, or with a malformed value, is a shape-invalid `400` at the contract boundary,
  never a silent default. `GitPushCommand.verifiedCommitSha` and `GitPublishExecRequest.verifiedCommitSha`
  (`git-publish-gateway.ts`) follow the same shape; `buildPushArgv` always builds the pinned refspec
  (D1) — there is no remaining branch that builds an unpinned one.
- **The new preflight finding.** `git-mutation-preflight.ts` gains `"verified-commit-drifted"` in
  `GitPreflightFindingCode`, and `preflightPush` emits it (blocking, user-actionable) when
  `inputs.verifiedCommitSha !== snapshot.headSha`. Preflight always runs against a **freshly re-read**
  `GitWorktreeSnapshot` (never a value cached from an earlier preview), so this is the actual
  anti-drift gate: it catches "the local branch moved since this push was approved" before any
  adapter call happens, for either dispatch path. It replaces `pushNeedsUpstream` /
  `"no-upstream-configured"`, a narrower check that only existed to catch the "no tracking relation
  and no pinned commit" combination the now-mandatory field makes unreachable by construction
  (AGENTS.md §7: delete the dead code rather than leave an always-false guard in place). Losing that
  check does not reduce coverage — an actually-unconfigured upstream on a pinned push still fails,
  just later and more informatively, when git itself rejects the pinned refspec.
- **The branch-identity finding (review of the drift check).** `snapshot.headSha` is the head of
  the branch that is *checked out*, so `verified-commit-drifted` only speaks for `sourceBranchName`
  when that branch is the checkout. `preflightPush` therefore also emits
  `"source-branch-not-checked-out"` (blocking, user-actionable) when `snapshot.currentBranchName`
  is not `inputs.sourceBranchName` — including a detached head, where no branch is checked out at
  all. A caller naming a branch the snapshot never read is refused outright instead of being judged
  (and possibly passed) by another branch's head; the pinned refspec then publishes exactly the
  commit the checked-out branch was at when it was reviewed. Recovery hint: `adjust-policy-target`
  (re-target the push, or check the named branch out, and preview again).
- **Why this does not defeat D1's own guarantee for the issue-bound path.** D1's canonical-URL path
  intentionally publishes the exact approved commit even when the local branch has since moved
  further — that is the whole point of pinning. A blanket "input must equal live local head" check
  would instead block that legitimate case as drift. The server-side effect wiring
  (`draftDeliveryEffects.ts`'s `pushSnapshot`) resolves this by reading the real snapshot and then,
  for a `push` command only, substituting `headSha: command.verifiedCommitSha` before preflight ever
  sees it — the check trivially holds for the commit that was actually approved, and D1's guarantee
  is preserved exactly as before. The interactive/manual route takes no such override: for it, the
  check is evaluated against the real live local head, so a genuine local drift between preview and
  execute is caught rather than pinned around. Both behaviours are proven by test: a real bare-remote
  integration test advances the local branch after approval and confirms the pinned commit still
  publishes on the issue-bound path (D1's existing coverage), and a new preflight test confirms the
  interactive path blocks with `verified-commit-drifted` when the local head has moved since the
  value being pushed was captured.
- **Cross-reference.** ADR-0086 D12 documents the equivalent enforcement for `pr-create` and
  `pr-update` (a live-head re-read immediately before the provider dispatch, rather than a preflight
  finding, since PR gateway has no local-snapshot preflight to extend — see Alternative 3 there).
- **Where a legitimate caller gets the value.** A mandatory field is only safe if the normal flow
  never has to ask a human to type a commit SHA. The read-only push preview route already resolves a
  live snapshot to project policy and preflight; it now additionally returns that snapshot's own
  `headSha` as `headCommitSha` on the preview response body. The interactive UI (`GitClientWindow.tsx`)
  captures that value at preview time and resubmits it as `verifiedCommitSha` on the approve/execute
  calls that follow — never re-reading the head at execute time itself, and only when the preview is
  still valid for the current target (mirrors the existing `previewedKey === targetKey` staleness gate
  already used for the visible preview). Approval (`/push/approve`) mints a claim bound to the whole
  typed command including this field, so a claim minted for one `verifiedCommitSha` cannot be
  redeemed for another. Preview itself stays read-only and never requires the field: it has no claim
  to mint and nothing to pin yet.

## Consequences

### Positive

- Remote publish becomes governed end-to-end with no parallel orchestrator, no new evidence schema, no new approval model, and zero contract change — the kernel's pure machinery is reused.
- The local mutation authority stays network-free: push is reachable only through the dedicated gateway and its single-subcommand allowlist, preserving the ADR-0081 invariant.
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
- **Cons**: Adds a network verb to the kernel that the local adapter would have to dispatch, eroding the ADR-0081 invariant that local writes can never reach a network subcommand. The local adapter's allowlist exclusion of `push` and its structural "no network verb" tests would have to be relaxed or specially-cased. The push execution also needs richer rejection data than the local adapter's `GitDeliveryExecutionResult`-only return allows.
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

- ADR-0080: Governed Git delivery contracts (push input shape, execution error codes, recovery vocabulary reused unchanged)
- ADR-0081: Governed Git mutation execution kernel (local adapter network-free invariant preserved; preflight push case reused)
- ADR-0082: Governed Git approval and preview surface (read-only BFF preview pattern)
- ADR-0083: Governed Git mutation evidence ledger (`recordGitDeliveryMutationEvidence` / `buildGitDeliveryEvidenceRecord` push projection reused)
- ADR-0084: Governed local Git flows (governed flow card extended with a publish section; execution wiring pattern mirrored)
- ADR-0019: Modular Package Architecture (leaf-package rule; dependency direction; `arch:check`)
- ADR-0018: Terminal allowlist (read-only baseline preserved; push NOT added to it)
- ADR-0043: Sandbox network enforcement (push uses `inherit`; `none` honoured elsewhere)
- Issue #476: Safe publish orchestration for push, upstream handling, and protected-target awareness (this ADR)
- Issues #477–#478: PR command center, merge governance (next children; extend provider execution)
- Issue #470: Epic — governed end-to-end Git delivery
- ADR-0086 D12: the equivalent mandatory-commit-pinning enforcement for `pr-create`/`pr-update` (PR
  #3394 review, finding 2)
- PR #3394: review that found commit pinning optional on this route (finding 1) and unenforced on PR
  create/update (finding 2); D6 and ADR-0086 D12 are the fix

## Date

2026-06-25
