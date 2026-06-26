# ADR-0074: Governed Local Git Flows and Commit-Intent Composition

## Status

Accepted

## Context

Epic #470 has established the governed Git delivery foundation in three prior slices:

- ADR-0070 (#471): typed contract surface — action kinds, risk taxonomy, lifecycle envelope, policy evaluator.
- ADR-0071 (#472): mutation kernel — single execution authority (`runGitMutation`), preflight evaluators, narrow adapter port, no-shell spawn boundary.
- ADR-0072 (#473): approval and preview presentation layer — content-free action sheet, BFF projection route.
- ADR-0073 (#474): evidence ledger — bounded append-only record for every terminal outcome, audit-export route.

Issue #475 assembles these layers into the first end-user-visible governed local write flows: branch creation and switching, staging and unstaging, and commit with interactive preview. It also introduces commit-intent composition — typed quality warnings and a deterministic suggested prefix derived from the staged changeset — without touching the Model Gateway.

Six forces constrain the design:

**Force 1 — Kernel as sole execution authority.** Every local mutation must flow through `runGitMutation`. No parallel orchestrator, no generic shell escape, no widening of the read-only terminal allowlist (`isTerminalCommandAllowed`, ADR-0018).

**Force 2 — Reuse the ledger.** Evidence for the new flows is recorded by the existing `recordGitDeliveryMutationEvidence` and the existing `buildGitDeliveryEvidenceRecord` builder. No parallel evidence subsystem.

**Force 3 — Strict leaf purity.** keiko-contracts is IO-free, clock-free, and depends on no `@oscharko-dev/*` package. New contract modules must honour this invariant; `arch:check` enforces it.

**Force 4 — Content-free invariant.** Warnings, violations, and evidence records carry typed codes, counts, byte-lengths, and branch names — never raw commit message bodies, diff content, file contents, or path strings beyond the top-level structural areas already permitted by the kernel snapshot.

**Force 5 — Deterministic-first posture.** Suggestions and quality analysis are heuristics computed from typed structural facts (staged file count, distinct top-level path areas, a WIP marker regex). No Model Gateway call is required for #475.

**Force 6 — No terminal-allowlist widening.** `git switch` (branch switching) must be routed through a new governed kind, not through the existing read-only terminal policy. The contract must grow by one kind; the terminal allowlist must not.

### Scope boundary (Issue #475)

In scope: new keiko-contracts leaves for commit message policy and commit intent; the `branch-switch` kind addition to the existing action-kind union; a read-only snapshot reader and staged-path summary in keiko-tools; server execution routes for branch/staging/commit reusing the kernel and ledger; a keiko-ui governed flow surface.

Out of scope: remote push, PR creation, or merge (#476–#478); hunk-level staging (path-level only); Model Gateway calls; a new evidence schema or a new ledger; breaking-change detection; session correlation beyond what the existing evidence record carries.

### Cross-branch ADR numbering

The governed-git feat branch uses ADR numbers 0058–0062. An independent feat branch (voice digital twin) independently used numbers 0058–0069. These are non-conflicting while both branches are un-merged to `dev`; the numbers are per-branch-local until a feat-to-dev PR is opened. The merge coordinator must verify that the final ADR numbering on `dev` is globally sequential and adjust if needed before merging.

## Decision

We will introduce two new strict-leaf modules in keiko-contracts, extend the existing action-kind union by one kind, add a read-only snapshot reader and intent summary builder in keiko-tools, add two new server route groups that reuse the existing kernel and ledger, and add a governed local flow surface in keiko-ui.

### D1 — Layer placement

**keiko-contracts** gains two new strict leaf modules:

- `git-commit-policy.ts`: a pure commit message policy validator. Its public surface is `GitCommitMessagePolicy` (config: conventional-commit type/scope prefix, optional DCO signoff trailer, optional issue-key pattern, subject byte length cap), `GitCommitMessageViolationCode` (closed string-literal union: `empty-subject | missing-conventional-prefix | disallowed-type | subject-too-long | missing-issue-key | missing-signoff`), `GitCommitMessageValidation` (discriminated union on `ok`), `validateGitCommitMessage(message, policy)` (pure; content in, typed codes out — no raw message content retained), and `KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY` (conventional-commit enabled with the 11 types this repository uses; issue-key and signoff disabled by default). Each rule is a separate helper to stay within the 50-line/complexity-10 lint envelope.

- `git-commit-intent.ts`: a pure deterministic quality analyser. Its public surface is `GitCommitChangeSummary` (produced in keiko-tools: `stagedFileCount`, `areaCount`, `areas` as distinct top-level path segments bounded to 12, `touchesTests`), `GitCommitQualityWarningCode` (closed union: `mixed-scope | wip-marker | large-change | empty-body | non-conventional-subject`), `GitCommitIntentAnalysis` (warnings, mixed-scope flag, WIP flag, optional suggested type / scope / subject-prefix scaffold), and `analyzeGitCommitIntent({summary, message?, largeChangeThreshold?})` (pure; no IO, no model call).

The `branch-switch` action kind is added to the existing `GitDeliveryActionKind` union in `git-delivery.ts` (10 → 11 kinds), assigned `local-mutation` risk class in `GIT_DELIVERY_ACTION_RISK_DEFAULTS`, and given its own `GitDeliveryBranchSwitchInputs` member in `GitDeliveryResolvedInputs`. All exhaustive per-kind tables (preflight dispatch, preview file count, action-sheet `affectedBranchOf`) receive the new case; a compile error in any exhaustive mapped type or switch enforces this at the kernel and server layers.

**keiko-tools** gains:

- A read-only worktree snapshot reader (`git-worktree-snapshot-node.ts`) using a dedicated read-only command rule set (subcommands: `status --porcelain=v2 --branch`, `rev-parse`, `branch --list`, `remote`, `diff --cached --name-only`). This is structurally separate from `GIT_MUTATION_COMMAND_RULES` and does not widen the mutation allowlist.
- A pure `summarizeStagedChangeset(stagedPaths)` builder producing `GitCommitChangeSummary` (area = first path segment; tests detected by pattern; areas bounded to 12 distinct values).
- The `branch-switch` kind wired through `runGitMutation`: new `switchBranch` method on `GitLocalMutationAdapter`, `buildBranchSwitchArgv` pure builder, `preflightBranchSwitch` preflight evaluator (blocking finding `switch-target-missing` when the target is not in known local branches; advisory `detached-head` when HEAD is already detached), and `GitBranchSwitchCommand` in `GitMutationCommand`.

**keiko-server** gains two new route groups under `packages/keiko-server/src/gitDelivery/`:

- `localMutationRoutes.ts`: `POST /api/git-delivery/local-branch/create`, `/local-branch/switch`, `/staging/stage`, `/staging/unstage`. Each handler gates on `isGitDeliveryTrusted`, validates the typed envelope (allowed keys, secret-shape scan, unsafe-format-char scan), reads a fresh snapshot via the snapshot reader, calls `runGitMutation`, records evidence via `recordGitDeliveryMutationEvidence`, and returns a content-free outcome. Factory pattern mirrors `createHandleGitDeliveryActionSheet` for testability.
- `commitRoutes.ts`: `POST /api/git-delivery/commit/preview` (read-only: snapshot + staged paths → `analyzeGitCommitIntent` + `validateGitCommitMessage` + `evaluateGitPreflight` + `evaluateGitPolicy`; returns a content-free preview object; no mutation) and `POST /api/git-delivery/commit/execute` (message-policy gate first; if violations present, record blocked evidence and return typed violation codes before the kernel runs; else `runGitMutation` → evidence → content-free outcome).

**keiko-ui** gains a `GovernedGitFlowCard` desktop window (`registerWindowRender` type `"governedGitFlow"`) walking the Branch → Staging → Commit composer sequence, calling the new API routes, and rendering intent warnings and message-policy violations as text badges with `aria-live` regions. Inline styles via CSS custom properties only; `globals.css` is not touched.

### D2 — Commit-message policy is enforced at the server route, before the kernel

`validateGitCommitMessage` runs in the commit-execute handler before `runGitMutation` is called. A policy violation produces a content-free 409 with typed `GitCommitMessageViolationCode[]` and records a blocked evidence entry via `recordGitDeliveryMutationEvidence`. The kernel never sees a message that violates policy. The policy configuration is injected server-side from trusted config; it cannot be overridden from the request body.

This placement ensures the kernel remains a narrow execution primitive that knows only `messageByteLength` from the evidence perspective — it does not validate message semantics — while the policy gate is fully covered by server-route tests independently of kernel tests.

### D3 — Suggestions are deterministic heuristics, not model calls

`analyzeGitCommitIntent` derives its output entirely from `GitCommitChangeSummary` facts and the optional draft message string: `mixedScope` from `areaCount > 1`, `isWip` from a regex on the subject, `large-change` from a configurable file-count threshold, `suggestedScope` from the dominant single area, `suggestedType` from structural signals (`touchesTests` + single test area → `"test"`; single docs area → `"docs"`), `suggestedSubjectPrefix` assembled when both type and scope are derivable. No gateway call, no latency, no non-determinism.

### D4 — Content-free invariant is maintained by construction

`GitCommitMessageValidation` returns only `GitCommitMessageViolationCode[]`, never a substring of the message. `GitCommitIntentAnalysis` returns typed codes, flags, and a scaffold string assembled from derived structural tokens — never the raw staged paths or diff content. `GitCommitChangeSummary` carries `areas` (top-level path segments, bounded, low-sensitivity structural tokens) and counts; no full file paths, no diff hunks, no commit message body. Evidence records for this flow carry the same content-free fields as the ledger already defines (ADR-0073 D3).

### D5 — `branch-switch` is a governed kind, not a generic checkout

`git switch` modifies HEAD, can trigger repository hooks, and is a mutation. Routing it through the governed surface means it is subject to the same preflight evaluation (D1), policy evaluation, evidence recording, and approval model as every other local mutation kind. The alternative — routing branch switching through the read-only terminal policy or through an ungoverned shell call — would create a mutation path outside the kernel's authority, which ADR-0071 D1 prohibits.

## Consequences

### Positive

- The first end-user-visible governed local write surface (branch / staging / commit) is built entirely on the existing kernel, ledger, and policy evaluator — no new orchestration logic, no new evidence schema, no new approval model.
- Commit message policy is enforced fail-closed at the server before the kernel executes; a new type or team convention can be added by changing the injected `GitCommitMessagePolicy` config, not code.
- Quality warnings and suggested prefixes are deterministic and instantaneous; they require no model availability and produce reproducible output for the same staged changeset.
- The `branch-switch` addition is purely additive and compile-enforced: every exhaustive per-kind table becomes a compile error until the new case is handled.
- Staging (path-level) and branch switching are now governed and evidenced, closing a gap where local mutations could otherwise occur outside the audit record.

### Negative

- Adding `branch-switch` to the action-kind union requires coordinated updates across every exhaustive per-kind table in `keiko-contracts`, `keiko-tools`, and `keiko-server`. This is mechanical but spans multiple files.
- The commit-preview route performs a snapshot read and three pure evaluations on every preview call. For large repositories with many staged files, the porcelain parse has measurable latency; this is a local single-host deployment (ADR-0019 architecture thesis) so it is acceptable at the current scale, but a hot-preview path (on every keystroke) would require debouncing in the UI.
- Path-level staging only — no hunk editor. Users who want partial-file staging must use a separate tool for this flow; this is an explicit scope cut.
- Remote check linking (CI status, branch protection checks) is not surfaced in the commit preview. The preview shows local verification context only; linking to remote check runs is deferred to #476 / #477, where the provider adapter is introduced.

### Neutral

- The read-only snapshot reader has its own command rule set, structurally separate from `GIT_MUTATION_COMMAND_RULES`. Adding a new read-only subcommand to the snapshot reader does not touch the mutation allowlist, and vice versa.
- `KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY` mirrors this repository's own commit style (11 conventional-commit types; issue-key and signoff disabled). Teams with stricter policies override it via injected server config; no default behaviour changes until a policy is explicitly configured.
- The governed-git branch uses ADR numbers 0058–0062. An independent voice-digital-twin branch independently used 0058–0069. Numbers are per-branch-local until a feat-to-dev merge; the merge coordinator must resolve the global sequence.

## Alternatives Considered

### Alternative 1: Model-generated commit message suggestions

- **Pros**: Higher-quality suggestions that consider full diff semantics; no need for heuristic rules.
- **Cons**: Introduces a Model Gateway dependency on every commit preview call, adding latency, non-determinism, and a new failure mode (model unavailable → preview blocked). Violates Force 5 (deterministic-first posture) and the architecture pattern established across this epic. Suggestions that depend on raw diff content also threaten the content-free invariant if the model output is persisted.
- **Why rejected**: Force 5 is explicit. Deterministic heuristics from typed structural facts are sufficient for the scoped warnings (#475) — quality warnings and a prefix scaffold, not a full drafted message. Model-assisted drafting can be a future opt-in behind a separate ADR.

### Alternative 2: Single combined server route for all local mutations

- **Pros**: One route, one request-guard path, less code.
- **Cons**: A single route conflates the semantically distinct concerns of branch management, staging, and commit (which has a unique message-policy gate and a two-phase preview/execute lifecycle). Adding the commit preview as a read-only operation to a mutation route is architecturally incorrect — it would receive CSRF enforcement that the read-only preview does not require. Separate route groups mirror the existing `actionSheetRoutes.ts` / `evidenceRoutes.ts` pattern and give each concern one reason to change.
- **Why rejected**: Separation of concerns; the preview route is intentionally read-only and must not be conflated with mutating handlers.

### Alternative 3: Route `branch-switch` through the read-only terminal policy

- **Pros**: No contract change; no kernel extension; reuses the existing `isTerminalCommandAllowed` gate.
- **Cons**: `git switch` is a mutation. Routing it through the read-only terminal allowlist would either require widening that allowlist (explicitly prohibited by ADR-0070 D7 and Force 6) or introduce an ungoverned execution path outside the kernel's authority (prohibited by ADR-0071 D1). Either path breaks a hard invariant of the governed delivery architecture.
- **Why rejected**: Both options violate documented hard invariants. Branch switching must be a governed kind, evidenced and policy-checked like every other local mutation.

### Alternative 4: Infer commit-message policy from the repository's `.commitlintrc`

- **Pros**: Zero additional config; automatically aligned with repo conventions; familiar to developers who already use commitlint.
- **Cons**: Reading and parsing a `.commitlintrc` at runtime introduces IO in the server request path, creates a new class of config-parse failures, and requires understanding commitlint's plugin system — significantly out of scope. An untrusted `.commitlintrc` in the project root could also be crafted to widen policy, creating a trust boundary issue.
- **Why rejected**: The injected `GitCommitMessagePolicy` is the minimal typed surface that covers the concrete requirements. Commitlint integration can be a future addition that maps commitlint config to `GitCommitMessagePolicy` before injection; the gate itself does not need to know about commitlint.

### Alternative 5: Skip the commit-preview route; validate only at execute time

- **Pros**: Simpler server surface; one route per lifecycle phase instead of two.
- **Cons**: Without a preview route, the UI cannot surface intent warnings, message-policy violations, or preflight findings before the user commits. The user discovers a policy block only after submitting — a poor experience for a governed surface. The preview route also keeps `validateGitCommitMessage` out of the kernel (where it does not belong, per D2).
- **Why rejected**: The preview route is the architectural device that keeps policy validation outside the kernel while delivering feedback before execution. It is the same pattern as `POST /api/git-delivery/action-sheet` (ADR-0072 D2): read-only, projection only, no side effects.

## Related

- ADR-0070: Governed Git delivery contracts (action kinds, risk taxonomy, lifecycle envelope — extended by one kind here)
- ADR-0071: Governed Git mutation execution kernel (`runGitMutation`, preflight dispatch, adapter port — extended by one kind here)
- ADR-0072: Governed Git approval and preview surface (action-sheet BFF pattern reused for preview route; `isGitDeliveryTrusted` gate reused)
- ADR-0073: Governed Git mutation evidence ledger (`recordGitDeliveryMutationEvidence` reused for all five new routes)
- ADR-0019: Modular Package Architecture (leaf-package rule; dependency direction contracts ← tools ← server; `arch:check` enforcement)
- ADR-0018: Terminal allowlist (read-only git baseline preserved; `git switch` explicitly NOT added)
- Issue #475: Governed local branch / staging / commit flows + commit-intent composition (this ADR)
- Issues #476–#478: Remote push, PR, merge (next children; will extend provider execution and check-linking)
- Issue #470: Epic — governed end-to-end Git delivery

## Date

2026-06-25
