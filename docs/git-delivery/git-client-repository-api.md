# Git Client Repository State, History, Remotes, and Sync API

This document is the endpoint reference for the read and fetch/pull-sync API foundation introduced in
Issue #1573 (Epic #1572) and defined by
[ADR-0098](../adr/ADR-0098-git-client-repository-state-and-sync-api.md). It is written for engineers
building the Git client window (#1574–#1578) against these routes and for reviewers verifying that the
reads stay bounded and content-free and that fetch/pull stay audited without entering the governed
mutation taxonomy.

The three gaps these reads close — commit history, remotes enumeration, and ahead/behind sync state —
were isolated in `git-client-desktop-reuse-contract.md` §3. Everything else the Git window needs is
reused unchanged: the Changes list, per-file/scope diff, and branch list are the existing
`/api/git/status` / `/api/git/diff` / `/api/git/branches` reads; the governed mutation/publish/PR/
merge/evidence write surface is the existing `gitDelivery/*` routes and the `keiko-tools` gateways.
This slice adds no mutation route and changes no existing route or contract.

## 1. Common model

### Repository resolution and availability

The three GET reads resolve the target repository through `resolveRepository` in `gitRoutes.ts`: the
`root` query parameter is contained within the selected project root, then `git rev-parse
--show-toplevel` confirms a repository and surfaces an unsafe-owner or missing classification. When the
repository cannot be resolved, the handler returns HTTP 200 with a content-free `available: false`
envelope (zeroed counts, empty arrays) carrying a typed `reason`:

| `reason`            | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `not-a-repository`  | The resolved path is not a Git repository.                    |
| `git-missing`       | The `git` executable is unavailable (runner exit code 127).   |
| `unsafe-repository` | Git refused the repository owner (`dubious ownership`).       |
| `git-error`         | A non-zero Git status read that none of the above classifies. |

`state` is `available` when `available` is true, `unsafe` for `unsafe-repository`, and `unavailable`
otherwise. The reason union is reused from `git-repository.ts` (`GitUnavailableReason` plus the
`unsafe-repository` / `git-error` literals); these reads do not introduce a new reason taxonomy.

### Bounded, hardened Git execution

Every Git invocation runs server-side through `defaultGitProcessRunner` (or an injected
`gitRouteOptions.runner` in tests) with fixed argv prefixed by `--no-pager --no-optional-locks -C
<repositoryRoot>`, a hardened environment (`GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, no system/global config, no shell), a byte cap,
and a timeout. Exceeding the byte cap or the timeout sets `truncated: true`; a spawn failure maps to
exit code 127. There is no client-supplied argv anywhere in this surface.

### Content-free responses

Response bodies carry counts, typed codes, branch and remote **names**, ISO 8601 dates, and content-
free hashes only — never raw command output, diff text, secrets, or credentials. Every response body
passes through `deps.redactor`, which redacts URLs inside remote entries at the boundary.

## 2. Read routes (`gitRoutes.ts` siblings, registered in `routes.ts`)

### `GET /api/git/summary`

Repository state for the sync banner and header.

- **Query**: `root` (project-contained repository path).
- **Underlying reads**: `status --porcelain=v2 --branch -z --untracked-files=all`, then `remote -v`,
  then a best-effort `rev-parse --git-path FETCH_HEAD` `stat` for the last-fetch time.
- **Response** (`GitRepositorySummary`, `schemaVersion: "1"`):

| Field                                                               | Type                   | Notes                                                            |
| ------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `root`, `repositoryRoot`                                            | string                 | Selected root and resolved repository toplevel.                  |
| `state`, `available`, `reason`, `message`                           | —                      | Availability envelope (see §1).                                  |
| `branch`, `detached`                                                | string? / boolean      | `branch` absent and `detached` true for a detached HEAD.         |
| `upstream`                                                          | `GitUpstreamSummary`?  | `{ ref, remote?, branch? }`, e.g. `origin/main`.                 |
| `ahead`, `behind`                                                   | non-negative int       | Parsed from `# branch.ab +A -B`; 0 when no upstream.             |
| `stagedCount`, `unstagedCount`, `untrackedCount`, `conflictedCount` | non-negative int       | Parsed from porcelain-v2 change records.                         |
| `clean`                                                             | boolean                | True when there are no change records.                           |
| `remotes`                                                           | `GitRemoteSummary[]`   | `{ name, fetchUrl?, pushUrl? }`, deduplicated by name.           |
| `lastSync`                                                          | `GitLastSyncMetadata`? | `{ lastFetchAtMs }` when `FETCH_HEAD` exists; omitted otherwise. |
| `truncated`                                                         | boolean                | True when the bounded status read was truncated.                 |

- **Validator**: `validateGitRepositorySummary`.

### `GET /api/git/history`

Paginated commit timeline for the History pane.

- **Query**: `root`; `limit` (integer, default 50, clamped to 1..200); `skip` (integer, default 0,
  clamped to 0..100000). A non-integer `limit`/`skip` is rejected with HTTP 400 (`BAD_REQUEST`).
- **Underlying read**: `log --no-color --max-count=<limit> --skip=<skip>
--pretty=format:<record-separated H/h/P/an/aI/D/s> --shortstat`. An empty repository (no commits)
  is detected from stderr and returned as `available: true` with `entries: []`, not an error.
- **Response** (`GitHistoryResponse`, `schemaVersion: "1"`): the availability envelope plus
  `entries`, `limit`, `skip`, `truncated`. Each `GitHistoryEntry`:

| Field              | Type             | Notes                                                           |
| ------------------ | ---------------- | --------------------------------------------------------------- |
| `sha`, `shortSha`  | string           | Full and abbreviated commit hashes.                             |
| `subject`          | string           | Commit subject (`%s`).                                          |
| `author`           | string           | Author name (`%an`).                                            |
| `date`             | string           | Strict ISO 8601 author date (`%aI`).                            |
| `refs`             | string[]         | Decoration names (`%D`), e.g. `["HEAD -> main","origin/main"]`. |
| `parentCount`      | non-negative int | Parent count from `%P`; a merge commit reports 2.               |
| `changedFileCount` | non-negative int | From the `--shortstat` line; 0 for merge/empty commits.         |

- **Truncation**: `truncated` is true when the bounded read was truncated **or** when
  `entries.length === limit` (more commits may exist past the page).
- **Validator**: `validateGitHistoryResponse`.

### `GET /api/git/remotes`

Configured remotes for the repository/sync surface.

- **Query**: `root`.
- **Underlying read**: `remote -v`, parsed into `GitRemoteSummary[]` (fetch and push URLs
  deduplicated by remote name).
- **Response** (`GitRemotesResponse`, `schemaVersion: "1"`): the availability envelope plus
  `remotes` and `truncated`.
- **Validator**: `validateGitRemotesResponse`.

## 3. Sync routes (`gitDelivery/syncRoutes.ts`, registered as `GIT_DELIVERY_SYNC_ROUTE_GROUP`)

Four POST routes mirror the push route structure: a bounded body read, an allowed-key whitelist
(`schemaVersion`, `projectId`, `remote`), credential-shape and unsafe-format-char scans, an
`isSafeGitRef` guard on the optional remote alias, content-free typed error envelopes, and an
injectable `execution` seam. CSRF and JSON content-type are enforced centrally in `server.ts` for every
POST and are not re-checked here.

### Request body (all four routes)

`GitSyncExecuteRequest`-shaped:

| Field           | Type   | Required | Notes                                                                                                         |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `"1"`  | yes      | Must equal `GIT_SYNC_SCHEMA_VERSION`.                                                                         |
| `projectId`     | string | yes      | The workspace root path; authorized through the project store.                                                |
| `remote`        | string | no       | Optional remote alias; syntactically validated by `isSafeGitRef` and accepted only when present in `git remote`. |

### Error envelope

`{ error: { code, message } }` with `GitDeliverySyncErrorCode`:

| HTTP | Code                                     | Cause                                                                                               |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 400  | `GIT_DELIVERY_SYNC_BAD_REQUEST`          | Malformed JSON, extra key, missing/invalid field, unsafe remote ref, or an unsafe format character. |
| 413  | `GIT_DELIVERY_SYNC_PAYLOAD_TOO_LARGE`    | Body exceeds the bounded read size.                                                                 |
| 400  | `GIT_DELIVERY_SYNC_FORBIDDEN_PAYLOAD`    | A credential/header/URL-shaped string was detected.                                                 |
| 404  | `GIT_DELIVERY_SYNC_UNKNOWN_PROJECT`      | `projectId` is not a registered workspace.                                                          |
| 409  | `GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE` | Preview could not inspect the worktree (not a repository).                                          |

### `POST /api/git-delivery/fetch/preview` and `POST /api/git-delivery/pull/preview`

Read-only readiness. Resolves the workspace (404 when unknown), runs
`status --porcelain=v2 --branch -z --untracked-files=all` plus `git remote` (names only, never URLs),
and returns a redacted `GitSyncPreview`. Never mutates, never records evidence; a worktree that cannot
be inspected yields a 409.

`GitSyncPreview` (`schemaVersion: "1"`):

| Field                               | Type                  | Notes                                                  |
| ----------------------------------- | --------------------- | ------------------------------------------------------ |
| `operation`                         | `"fetch"` \| `"pull"` | The previewed operation.                               |
| `available`, `state`, `reason`      | —                     | Availability envelope.                                 |
| `branch`, `detached`, `upstream`    | —                     | Current branch / detached HEAD / `GitUpstreamSummary`. |
| `remote`                            | string?               | Echoed remote alias when supplied.                     |
| `ahead`, `behind`                   | non-negative int      | Ahead/behind vs the upstream.                          |
| `hasRemote`, `hasUpstream`, `dirty` | boolean               | Readiness inputs.                                      |
| `executable`                        | boolean               | True when the op can run now (`blockReason` absent).   |
| `blockReason`                       | `GitSyncBlockReason`? | See below.                                             |

`executable` gating: a **fetch** needs `hasRemote`; a **pull** needs `hasRemote`, an upstream, and a
non-detached HEAD. `GitSyncBlockReason` is one of `no-remote`, `no-upstream`, `detached-head`,
`git-missing`, `unsafe-repository`, `unavailable`. Validator: `validateGitSyncPreview`.

### `POST /api/git-delivery/fetch/execute` and `POST /api/git-delivery/pull/execute`

Runs ONE bounded fetch or pull through the preflight-gated credential-capable runner (NOT the governed
mutation kernel — see §4) only after a successful executable preview. Blocked inspectable previews
return the matching typed outcome and record content-free evidence without invoking network Git.
Settled network operations re-read branch/upstream/ahead/behind, build a redacted
`GitSyncExecuteResponse`, and append a content-free sync evidence record.

- **fetch argv**: `fetch --no-tags [remote]`.
- **pull argv**: `pull --ff-only --no-edit [remote]` (fast-forward only; never creates a merge commit).

`GitSyncExecuteResponse` (`schemaVersion: "1"`): `operation`, `status` (a `GitSyncOutcome`),
`available`, `branch?`, `upstream?`, `remote?`, `ahead?`/`behind?` (post-op counts when known), and
`truncated`. Validator: `validateGitSyncExecuteResponse`.

### `GitSyncOutcome` taxonomy

The evidence-friendly outcome union (`GIT_SYNC_OUTCOMES`, 13 members):

| Outcome             | Operation | Meaning                                                       |
| ------------------- | --------- | ------------------------------------------------------------- |
| `succeeded`         | both      | Fetch completed / pull fast-forwarded.                        |
| `up-to-date`        | pull      | Already up to date (stdout match).                            |
| `no-remote`         | both      | No such remote / not a Git repository on the remote leg.      |
| `no-upstream`       | pull      | No tracking information for the current branch.               |
| `detached-head`     | pull      | Detached HEAD (surfaced as a preview block; pull cannot run). |
| `dirty-worktree`    | pull      | Local changes would be overwritten.                           |
| `not-fast-forward`  | pull      | `--ff-only` refused a non-fast-forward.                       |
| `auth-failed`       | both      | Credentials/permission/terminal-prompt-disabled failure.      |
| `untrusted-host-key` | both     | SSH refused an unknown or changed host key.                   |
| `timeout`           | both      | The bounded process was truncated (timeout or byte cap).      |
| `git-missing`       | both      | The `git` executable was unavailable (exit code 127).         |
| `unsafe-repository` | both      | Dubious ownership / `safe.directory` refusal.                 |
| `git-error`         | both      | A non-zero result none of the above classifies.               |

Outcome classification scans stderr case-insensitively in a fixed precedence: truncation → exit code
127 → ownership → host-key trust → auth → remote/repository → (pull only)
tracking/fast-forward/local-changes → exit-code-0 success/up-to-date → `git-error`. Ownership,
host-key trust, and auth precede the generic remote checks so a credential or SSH-trust failure is
never mislabeled.

## 4. Reuse and safety boundaries

- **Reads reuse the existing seams.** `gitRepositoryReads.ts` reuses `resolveRepository`,
  `optionsWithDefaults`, `classifyFailure`, `defaultGitProcessRunner`, and `deps.redactor` from
  `gitRoutes.ts` (those five symbols were made `export` behavior-preservingly), plus the shared
  `parsePorcelainV2Branch` from `gitPorcelainStatus.ts` consumed identically by the sync preview.
- **Fetch/pull do NOT enter the governed mutation taxonomy.** `GitDeliveryActionKind` carries no
  fetch/pull, and the sync executor (`syncExecution.ts`) does not import `runGitMutation`, the policy
  packs, or the approval-token gate. It reuses only the hardened runner with fixed argv. The rationale
  (a fetch writes only remote-tracking refs; a fast-forward-only pull advances by replay) and the
  reuse-vs-new decision are recorded in
  [ADR-0098](../adr/ADR-0098-git-client-repository-state-and-sync-api.md) D4.
- **Sync evidence is a sibling ledger.** `syncEvidence.ts` mirrors `mutationEvidenceLedger.ts`: one
  UTC date-bucketed document (run id `git-sync-evidence-YYYY-MM-DD`), `EvidenceStore.update ?? get+put`,
  `deepRedactStrings`, a bounded bucket (default 500), fail-closed on corruption, and best-effort
  (never throws into the caller). The record is content-free: operation, typed outcome,
  `repoIdHash = sha256Hex(workspace.root).slice(0, 24)`, branch/remote names, ahead/behind before and
  after, and an epoch-ms timestamp.
- **Project authorization.** Sync routes resolve `projectId` (the workspace root path) through
  `resolveProjectWorkspace`; an unregistered path is rejected with 404, so a fetch or pull runs only
  inside a known project's worktree.
- **No existing surface changed.** `/api/git/status|diff|branches`, `/api/projects`,
  `/api/repositories/clone`, every `gitDelivery/*` route, and every existing contract are byte-for-byte
  unchanged. All new exports are additive; no package version is bumped.

## 5. Named limitations

- **Push is not here.** Push remains the governed publish gateway (ADR-0085). This surface covers only
  read, fetch, and pull; the Sync banner's push leg routes through the existing governed publish route.
- **Pull is fast-forward only.** A divergent branch reports `not-fast-forward`; resolving it is a
  governed merge (ADR-0087), not a sync-executor concern.
- **`lastSync` is best-effort.** It is the `FETCH_HEAD` mtime when that file exists; it is omitted when
  the repository has never fetched. It is not a guarantee of remote freshness.
- **History pagination is `git log` `--max-count`/`--skip`.** `truncated` flags that more commits may
  exist beyond the page; there is no total-count read.
