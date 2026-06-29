# ADR-0098: Git client repository state, history, remotes, and fetch/pull sync API — read-route reuse plus a non-governing sync executor with a sibling evidence ledger

## Status

Accepted (Issue #1573, Epic #1572, 2026-06-27)

## Version

0.2.0

## Context

Epic #1572 redesigns Keiko's local Git surface into a single GitHub-Desktop-inspired window.
The reuse contract for that epic (`docs/git-delivery/git-client-desktop-reuse-contract.md`)
audited every Desktop flow against an existing Keiko building block and found that **most of the
surface is already satisfied by reuse**: the Changes list, per-file/scope diff, branch list, and
clone reads exist as `GET /api/git/status` / `/api/git/diff` / `/api/git/branches` in
`gitRoutes.ts`; the entire governed mutation/publish/PR/merge/evidence write surface exists under
`gitDelivery/*` and the `keiko-tools` gateways; and the window registry, rail, and design tokens
exist in `keiko-ui`. The write contract is frozen — no child issue adds a BFF mutation route.

Issue #1573 is the **API foundation** child. Its job is precisely the small set of genuine gaps the
reuse contract isolated in its Section 3, plus the read-only/preview/execute sync surface the
History and Sync panes need. It is backend + contracts only; it ships no UI, and it changes no
existing route or contract.

Three forces shape this ADR.

**Force 1 — Three server-side reads are genuine gaps, not parallel implementations.** The reuse
contract §3 named exactly three reads that do not exist today and that the History tab, remote
management, and the Fetch/Pull/Push sync banner require:

1. **Commit history / log.** No `git log` endpoint exists; `gitRoutes.ts` exposes status/diff/
   branches only. The History pane cannot render a commit timeline or per-commit detail without
   one. (Hand-off: #1573 produces it, #1576 consumes it.)
2. **Remotes list.** `repositoryUrlAllowed`/clone handle a clone URL, but there is no `git remote -v`
   read endpoint to enumerate the configured remotes and fetch/push URLs of an already-open
   repository. The repository and sync surfaces need this. (Hand-off: #1573 → #1576.)
3. **Ahead/behind sync state.** The existing `parseBranch` deliberately strips the upstream tracking
   segment and `parseBranches` returns local `refs/heads` only with no upstream, so there is no
   ahead/behind/upstream datum for a fetch/pull/push sync UI. (Hand-off: #1573 → #1576 sync banner.)

Each gap is a real missing read, not a re-derivation of something that already exists. The reuse
contract §3 mandated that each be added as a **sibling `GET` in `gitRoutes.ts`** reusing
`resolveRepository`, the hardened runner, `redacted()`, and the `GitRouteOptions` byte-cap/timeout
pattern, registered alongside the existing reads. This ADR ratifies that placement.

**Force 2 — Fetch and pull are network Git, but they are not governed mutations.** The History and
Remotes gaps are pure local reads, but the Sync banner additionally needs to **execute** a fetch or
a pull. The governed Git delivery stack already has an execution kernel (`runGitMutation`, ADR-0081)
fronted by the closed `GitDeliveryActionKind` taxonomy (ADR-0080). The naive move would be to add
`fetch`/`pull` as two new action kinds and route them through the kernel. The #1572 reuse contract
§3 forbids this: the governed write contract is **frozen**, and the action-kind taxonomy is a
control-plane invariant the governed epic (#470) holds. `GitDeliveryActionKind` carries no
fetch/pull, and adding them would force a change across every exhaustive per-kind policy/risk/
preview table, widening the governed authority surface for two operations that — unlike a push,
commit, or merge — do not write to the local refs the governance model exists to protect a
fast-forward-only pull updates tracking refs and fast-forwards the current branch; a fetch updates
only remote-tracking refs. This is the deliberate reuse boundary D4 records.

**Force 3 — Sync must still be evidence-compatible and content-free.** Declining to govern fetch/pull
through the kernel must not mean declining to audit them. The governed stack's evidence pattern
(`mutationEvidenceLedger.ts`, ADR-0083) — one date-bucketed document per UTC day via
`EvidenceStore.update ?? get+put`, `deepRedactStrings`, a bounded bucket, fail-closed on corruption,
best-effort so an audit write never throws into the caller — is the proven reuse target. Sync mirrors
it in a **sibling** module rather than extending the mutation ledger, because the mutation ledger's
records are keyed to kernel outcomes and the fetch/pull outcome taxonomy is different (D5).

### Scope boundary (Issue #1573)

In scope: three read contracts (`git-repository-summary.ts`, `git-history.ts`, plus the read fields
of `git-sync.ts`) and the sync request/response/outcome contracts; the three read routes
(`gitRepositoryReads.ts`) plus a shared porcelain-v2 parser (`gitPorcelainStatus.ts`); the
non-governing sync executor (`gitDelivery/syncExecution.ts`), its sibling evidence ledger
(`gitDelivery/syncEvidence.ts`), and its routes (`gitDelivery/syncRoutes.ts`); the barrel exports and
route registrations; tests; and this documentation.

Out of scope: any UI (deferred to #1574–#1578); any change to an existing route, contract, or the
governed mutation taxonomy; conflict resolution, merge, or push (push remains the governed publish
gateway, ADR-0085); and any package version bump (all new exports are additive).

## Decision

### D1 — Three additive read contracts reusing the existing repository-state unions

Three new strict-leaf contract modules are added in `keiko-contracts`, each pure (no filesystem,
process, clock, or crypto) and each reusing the `GitRepositoryState`, `GitUnavailableReason`, and
`GitRepositoryValidation` unions already exported by `git-repository.ts` (Issue #1386). No existing
union is changed.

- `git-repository-summary.ts` — `GitRepositorySummary` (branch, detached, `GitUpstreamSummary`,
  ahead/behind, staged/unstaged/untracked/conflicted counts, clean flag, `GitRemoteSummary[]`,
  optional `GitLastSyncMetadata`, truncated) and a dedicated `GitRemotesResponse` reusing
  `GitRemoteSummary`. `GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION = "1"`. Validators
  `validateGitRepositorySummary` / `validateGitRemotesResponse`.
- `git-history.ts` — `GitHistoryEntry` (sha, shortSha, subject, author, ISO date, refs[],
  parentCount, changedFileCount) and the paginated `GitHistoryResponse` (entries, limit, skip,
  truncated). `GIT_HISTORY_SCHEMA_VERSION = "1"`. Validator `validateGitHistoryResponse`.
- `git-sync.ts` — the sync contracts (D3): `GitSyncOperation`, `GitSyncOutcome` (13 members),
  `GitSyncBlockReason`, `GitSyncExecuteRequest`, `GitSyncPreview`, `GitSyncExecuteResponse`,
  `GIT_SYNC_SCHEMA_VERSION = "1"`, the frozen `GIT_SYNC_OPERATIONS` / `GIT_SYNC_OUTCOMES` /
  `GIT_SYNC_BLOCK_REASONS` arrays, the `isGitSyncOperation` / `isGitSyncOutcome` guards, and the
  `validateGitSyncPreview` / `validateGitSyncExecuteResponse` validators. `GitSyncPreview` imports
  `GitUpstreamSummary` from `git-repository-summary.ts`, so the upstream shape is defined once.

The barrel (`index.ts`) re-exports each module in its own `export type {…}` + `export {…}` block,
following the existing `git-repository.js` block (isolatedModules: runtime values in the value block,
types in the type block). The exports are additive; `KEIKO_CONTRACTS_VERSION` is untouched.

### D2 — The read routes reuse the hardened `gitRoutes.ts` seams unchanged in behavior

`gitRepositoryReads.ts` adds three GET handlers — `handleGitSummary` (`/api/git/summary`),
`handleGitHistory` (`/api/git/history`), `handleGitRemotes` (`/api/git/remotes`) — each wrapped in
`runFilesHandler` and each reusing the existing `gitRoutes.ts` building blocks:

- `resolveRepository(ctx, deps, options)` for selected-root containment, `rev-parse --show-toplevel`,
  and unsafe-owner / missing classification. An unavailable resolution short-circuits to a
  content-free `available: false` envelope with zeroed counts and empty remotes.
- `optionsWithDefaults` for the byte-cap/timeout normalization, and `options.runner` (defaulting to
  `defaultGitProcessRunner`) for the bounded process effect through fixed argv and the hardened
  `gitEnv()` (`GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, no system/global config), with spawn-error → exit code 127 and a
  byte-cap/timeout truncation flag.
- `classifyFailure` to map a non-zero status read to the existing reason union (`git-missing`,
  `unsafe-repository`, `not-a-repository`, `git-error`).
- `deps.redactor` applied to every response body, so any URL inside a remote is redacted at the
  boundary.

The only edit to `gitRoutes.ts` is **behavior-preserving**: `resolveRepository`,
`optionsWithDefaults`, `classifyFailure`, `interface RepositoryContext`, and
`interface NormalizedGitRouteOptions` gain `export` so the sibling file can consume them. No logic
in `gitRoutes.ts` changes, and the existing `/api/git/status` / `/api/git/diff` / `/api/git/branches`
routes are byte-for-byte unchanged.

The three routes are registered in `routes.ts` immediately after `/api/git/branches`, each as
`handler: (ctx, deps) => handleX(ctx, deps, deps.gitRouteOptions)`, matching the existing reads'
injection of `gitRouteOptions` so tests can supply a fake runner.

### D3 — A shared porcelain-v2 parser is the single source of branch/ahead-behind/dirty truth

`gitPorcelainStatus.ts` exports `parsePorcelainV2Branch(stdout)` returning a `PorcelainV2Status`
(branch, detached, `GitUpstreamSummary`, ahead, behind, staged/unstaged/untracked/conflicted counts,
dirty). It parses `git status --porcelain=v2 --branch -z`: the `# branch.head` / `# branch.upstream`
/ `# branch.ab` headers, the ordinary (`1 `) and rename/copy (`2 `) XY change records (X = index/
staged status, Y = worktree/unstaged status), the unmerged (`u `) and untracked (`? `) records, and
the extra NUL-separated original-path field that rename records carry. Both `gitRepositoryReads.ts`
(for `handleGitSummary`) and `gitDelivery/syncExecution.ts` (for the sync preview and post-op
re-read) consume this one parser, so the ahead/behind/dirty semantics are audited in one place and
cannot diverge between the read and sync surfaces.

### D4 — Fetch/pull deliberately do NOT enter `GitDeliveryActionKind` / `runGitMutation`

This is the load-bearing reuse-vs-new boundary. `gitDelivery/syncExecution.ts` runs fetch/pull
through a dedicated bounded executor, **not** the #472 kernel:

- It reuses `defaultGitProcessRunner` (the same hardened, fixed-argv, fixed-env, byte-capped,
  timeout-bounded runner the read routes use) but composes its own argv:
  `fetch --no-tags [remote]` and `pull --ff-only --no-edit [remote]`. The `--ff-only` flag makes a
  pull refuse anything but a fast-forward, so a pull can never create a merge commit or rewrite local
  history outside the governed surface.
- It does **not** import `runGitMutation`, the policy packs, the approval-token gate, or any
  `GitDeliveryActionKind`. `GitDeliveryActionKind` carries no `fetch`/`pull` member, and this ADR
  does not add one.

The rationale is reuse-vs-new discipline (the Stop Condition against widening a frozen control
plane): adding two action kinds would ripple through every exhaustive per-kind policy/risk/preview/
recovery table in the governed contract and would extend the kernel's authority to two operations
the governance model was not built to mediate. A fetch writes only remote-tracking refs; a
fast-forward-only pull advances the current branch by replay, never by a mutation the kernel's
preflight/approval lifecycle is needed to guard. The control surface fetch/pull actually need is the
fixed argv plus the hardened environment of the reused runner, which is exactly what this executor
provides — without taking on the kernel's heavier governance machinery or weakening it by widening
its taxonomy. The deliberate boundary is documented here so a future maintainer does not "fix" the
asymmetry by routing fetch/pull through the kernel.

#### D4a — Two process environments: hardened for local reads, credential-capable for network sync

The reused runner is parameterized over its environment by a small factory,
`createGitProcessRunner(buildEnv)`, which holds the unchanged spawn / byte-cap / timeout /
spawn-error-to-127 machinery and takes the environment as its only seam. Two runners are built from
it, because a **local read** and a **network sync** have opposite credential requirements:

- **`gitEnv` (local reads — `defaultGitProcessRunner`).** Fully config-isolated: `HOME` and
  `XDG_CONFIG_HOME` are pointed at `/nonexistent`, `GIT_CONFIG_GLOBAL` at the null device, and
  `GIT_CONFIG_NOSYSTEM=1`. A `status`/`diff`/`branches`/`summary`/`history`/`remote` read never
  authenticates to a remote, so it must not be able to load a user `~/.gitconfig`, a credential
  helper, or an SSH identity. This is the correct, unchanged behavior for every read route and for
  the sync preview and the post-op ahead/behind re-read.
- **`networkGitEnv` (the fetch/pull command only — `defaultGitNetworkProcessRunner`).** A fetch or
  pull against a private or SSH remote *must* be able to authenticate, so this env inherits the real
  process environment (the user's global `~/.gitconfig` `credential.helper`, the macOS `osxkeychain`
  helper, and the real `~/.ssh` identities). It still **never prompts**: `GIT_TERMINAL_PROMPT=0` and
  `GIT_SSH_COMMAND="ssh -oBatchMode=yes -oStrictHostKeyChecking=yes"` force the operation to
  **fail closed** when no stored credential satisfies the remote (`auth-failed`) or when SSH cannot
  verify a known host key (`untrusted-host-key`), rather than hang on an interactive prompt or trust
  a first-use host implicitly.

`syncExecution.ts` therefore resolves two runners from its seams: the local read runner
(`seams.runner ?? defaultGitProcessRunner`) drives `buildSyncPreview` and the pre/post ahead-behind
re-reads, while the network runner (`seams.runner ?? defaultGitNetworkProcessRunner`) drives **only**
the actual `git fetch` / `git pull` command. Because tests inject `seams.runner`, both runners
collapse to the single fake runner under test, so determinism is preserved; only in production do the
two environments diverge. This corrects a latent availability defect: routing the network command
through the config-isolated `gitEnv` hid every stored credential and pointed SSH key discovery at
`/nonexistent/.ssh`, so an authenticated fetch/pull failed `auth-failed` regardless of valid
credentials. The split keeps the security posture of the local reads exactly as before while making
sync functional for private and SSH remotes. The deliberate output-display follow-ups (the shared
redactor not stripping the colon-less `https://<token>@host` token form, and git-output strings not
being stripped of bidi/zero-width characters before reaching the browser) are recorded as
low-severity items and are out of scope for #1573.

### D5 — Sync is evidence-compatible through a sibling ledger, not the mutation ledger

`gitDelivery/syncEvidence.ts` is a sibling of `mutationEvidenceLedger.ts` and mirrors its persistence
shape exactly: ONE document per UTC date bucket (run id `git-sync-evidence-YYYY-MM-DD` via
`gitSyncEvidenceRunIdFor`), written through `EvidenceStore.update ?? get+put`, redacted leaf-by-leaf
with `deepRedactStrings`, bounded to the most recent N records
(`GIT_SYNC_EVIDENCE_DEFAULT_BUCKET_CAP = 500`), fail-closed on a corrupt bucket (it throws rather
than overwrite existing audit evidence), and best-effort (`recordGitSyncEvidence` never throws into
the caller; a persistence failure is reported through an injectable `onPersistError` sink).

The record (`GitSyncEvidenceRecord`) is content-free by construction: the operation, the typed
`GitSyncOutcome`, a content-free `repoIdHash = sha256Hex(workspace.root).slice(0, 24)` (never the
path itself), the branch and remote **names**, the ahead/behind counts before and after, and an
epoch-ms timestamp. No URL, secret, or command output enters the record. A separate ledger (not an
extension of the mutation ledger) keeps the two outcome taxonomies — kernel terminal status vs the
fetch/pull `GitSyncOutcome` — structurally distinct, consistent with the domain-separation precedent
in ADR-0083.

### D6 — The sync routes mirror the push route structure but never govern

`gitDelivery/syncRoutes.ts` mirrors `pushRoutes.ts`: the same bounded body read
(`readGitDeliveryBody`), allowed-key whitelist (`schemaVersion`, `projectId`, `remote`), credential-
shape and unsafe-format-char scans (`scanForbiddenStrings` / `scanUnsafeFormatChars`), an
`isSafeGitRef` operand guard on the optional remote alias (rejecting whitespace, a leading `-`, a
`:`, and control characters so a malformed remote is a clean 400 rather than an internal error), a
configured-remote check that prevents the optional alias from becoming an arbitrary Git
`<repository>` operand,
content-free typed error envelopes (`GitDeliverySyncErrorCode`), and a
`createGitDeliverySyncRouteGroup(options)` factory with an injectable `execution` seam plus a
`GIT_DELIVERY_SYNC_ROUTE_GROUP` default export. CSRF and JSON content-type are enforced **centrally**
in `server.ts` for every POST and are not re-checked here.

The group registers four POST routes:

- `/api/git-delivery/fetch/preview` and `/api/git-delivery/pull/preview` — READ-ONLY readiness. They
  resolve the workspace through `resolveProjectWorkspace(deps, projectId)` (404 when the project is
  unknown), run `buildSyncPreview` (a 409 when the worktree cannot be inspected), and return the
  redacted `GitSyncPreview`. They never mutate and never record evidence.
- `/api/git-delivery/fetch/execute` and `/api/git-delivery/pull/execute` — require a successful
  executable pre-op preview before network Git runs. Inspectable blocked previews return a typed
  `GitSyncOutcome` and append content-free `recordGitSyncEvidence`; uninspectable worktrees return a
  409 without invoking network Git.

The group is registered in `routes.ts` by spreading `...GIT_DELIVERY_SYNC_ROUTE_GROUP` next to the
other git-delivery groups, with a comment citing #1573.

### D7 — No existing route or contract changed

The only file with an existing public surface that is edited is `gitRoutes.ts`, and that edit only
adds `export` to five already-defined symbols — behavior-preserving. `/api/projects`,
`/api/repositories/clone`, `/api/git/status|diff|branches`, every `gitDelivery/*` route, and every
existing contract type are byte-for-byte unchanged. `GitDeliveryActionKind`, the governed policy
packs, the mutation kernel, and `mutationEvidenceLedger.ts` are untouched. All new surface is
additive, so no package version is bumped.

## Consequences

### Positive

- The three reuse-contract §3 gaps (history, remotes, ahead/behind) are closed with sibling reads
  that reuse `resolveRepository` / `defaultGitProcessRunner` / `redacted()` rather than a parallel
  Git read subsystem (D2), exactly as the reuse contract mandated.
- The shared porcelain-v2 parser (D3) makes the summary read and the sync preview consume identical
  branch/ahead-behind/dirty logic, so the two surfaces cannot disagree.
- Fetch/pull gain an audited, bounded execution path without widening the frozen governed mutation
  taxonomy (D4), preserving the #470 control-plane invariant the reuse contract protects.
- The local reads stay fully config-isolated while the fetch/pull command alone runs with a
  credential-capable, non-interactive, fail-closed environment (D4a), so authenticated private/SSH
  remotes work without relaxing the security posture of any read route.
- Sync remains fully evidence-compatible through a sibling ledger that mirrors the proven mutation-
  ledger pattern (D5), so an operator can audit every executed sync with a content-free record.
- Every response body and evidence record is content-free (counts, typed codes, branch/remote names,
  ISO dates, hashes) and passes through `deps.redactor`, so a remote URL or credential never reaches
  the browser or the ledger.
- The change is additive end to end (D7); no existing route, contract, or version moves.

### Negative

- The fetch/pull execution path and the kernel mutation path are now two execution surfaces in
  `gitDelivery/`. The asymmetry is deliberate (D4) and documented, but a maintainer must understand
  why sync does not route through `runGitMutation` before changing either.
- The sync evidence ledger is a second ledger alongside the mutation ledger. The duplication of the
  bounded-bucket/redaction/fail-closed mechanics is accepted in exchange for keeping the two outcome
  taxonomies structurally separate (D5), mirroring the domain-separation reasoning of ADR-0083.
- A `pull --ff-only` refuses any non-fast-forward, so a divergent branch reports `not-fast-forward`
  and the user must resolve it through the governed merge gateway. This is intentional: the sync
  executor never creates a merge commit.

### Neutral

- The read routes are always registered (no deployment enable flag), consistent with the existing
  `/api/git/status|diff|branches` reads; each handler still degrades to a typed `available: false`
  envelope when Git is missing, the path is not a repository, or the owner is unsafe.
- `GitSyncPreview` reuses `GitUpstreamSummary` from `git-repository-summary.ts`, so the upstream
  shape is defined once and shared across the summary and sync contracts.
- The sync routes use `resolveProjectWorkspace` (a `projectId` that is the workspace root path,
  authorized through the project store), the same authorization seam the governed push/commit routes
  use, so an unregistered path cannot drive a fetch or pull.

## Alternatives Considered

### Alternative 1: Add `fetch` and `pull` as governed `GitDeliveryActionKind` members through the kernel

- **Pros**: one execution authority for every network and local Git operation; sync would inherit the
  kernel's policy/approval/evidence lifecycle for free.
- **Cons**: the governed write contract and the action-kind taxonomy are frozen by the #1572 reuse
  contract §3 and are a #470 control-plane invariant. Adding two kinds ripples through every
  exhaustive per-kind policy/risk/preview/recovery table and extends the kernel's authority to
  operations it was not built to mediate — a fetch touches only remote-tracking refs and a
  fast-forward-only pull advances by replay, neither of which is the local-ref write the governance
  model exists to guard. It would weaken the control plane for no governance benefit.
- **Why rejected**: D4. Reuse the hardened runner, not the kernel; keep the taxonomy frozen.

### Alternative 2: Record sync outcomes in the existing mutation evidence ledger

- **Pros**: one ledger, one bounded bucket, one export path.
- **Cons**: the mutation ledger's records are keyed to kernel terminal outcomes; the fetch/pull
  `GitSyncOutcome` taxonomy is different, and conflating them would couple two unrelated outcome
  domains at the storage layer and complicate independent retention. ADR-0083 already establishes
  that evidence domains stay structurally separate even when their infrastructure is similar.
- **Why rejected**: D5. A sibling ledger mirrors the proven pattern without conflating taxonomies.

### Alternative 3: Add ahead/behind and history by extending the existing `parseBranch` / status route

- **Pros**: no new contract or route; the sync UI would read everything from one enriched status
  envelope.
- **Cons**: the existing `/api/git/status` response is consumed byte-for-byte by the Changes pane and
  its tests; widening it would change a frozen contract (violating "only ADD code"), and `parseBranch`
  deliberately strips the upstream segment. History in particular is a paginated `git log` read with
  a different shape that does not belong in the status envelope.
- **Why rejected**: D1/D7. Additive sibling contracts keep the existing status route unchanged and
  give history its own paginated envelope.

### Alternative 4: Duplicate the porcelain-v2 parsing in the read route and the sync executor

- **Pros**: each module is self-contained with no shared import.
- **Cons**: the XY change-record and `# branch.*` header semantics are subtle (rename records carry
  an extra NUL field; ahead/behind is `+A -B`); two copies would drift, and a single-line mutation in
  one copy could pass while the other is correct, exactly the divergence the summary-vs-sync surfaces
  must not have.
- **Why rejected**: D3. One `parsePorcelainV2Branch` consumed by both surfaces is audited once.

## Related

- [ADR-0080](ADR-0080-governed-git-delivery-contracts.md): the governed Git delivery contracts and
  the frozen `GitDeliveryActionKind` taxonomy this ADR deliberately does not extend (D4).
- [ADR-0081](ADR-0081-governed-git-mutation-execution-kernel.md): the `runGitMutation` kernel the
  sync executor deliberately does not enter (D4).
- [ADR-0083](ADR-0083-governed-git-mutation-evidence-ledger.md): the bounded, date-bucketed,
  redacted, fail-closed evidence-ledger pattern the sync ledger mirrors in a sibling module (D5).
- [ADR-0085](ADR-0085-governed-remote-publish-gateway.md): the governed push authority; push remains
  governed and is out of scope for #1573's read/preview/execute sync surface.
- `docs/git-delivery/git-client-desktop-reuse-contract.md`: the #1572 reuse contract whose §3
  isolated the three read gaps this ADR closes and whose §3 froze the write contract.
- `docs/git-delivery/git-client-repository-api.md`: the endpoint reference for the routes this ADR
  ratifies (query/body, response shapes, the `GitSyncOutcome` taxonomy, and the reused safety
  constraints).
- Epic [#1572](https://github.com/oscharko-dev/Keiko/issues/1572); Issue
  [#1573](https://github.com/oscharko-dev/Keiko/issues/1573); consuming UI issue
  [#1576](https://github.com/oscharko-dev/Keiko/issues/1576).

## Date

2026-06-27
