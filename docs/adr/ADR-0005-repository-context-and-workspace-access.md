# ADR-0005: Repository Context and Workspace Access Layer

## Status

Accepted

Accepted — module location superseded by ADR-0019 (now `packages/keiko-workspace/`, not
`src/workspace/**`; the single-package model was replaced by the modular monorepo package
architecture). D1–D5 remain live precedent (for example, in ADR-0023). D1 and D2 were amended by
issue #3347 on 2026-09-01 to record the evolved bounded-read surface, strong file identity, and the
canonical containment checks used by the shared content-read lanes and grounded retrieval. D2 also
records that denied workspace-root relocation through symlinks is rejected before effects run.

D2's "one workspace read, always redacted" is amended by [ADR-0165](ADR-0165-editor-raw-read-lane-and-the-redacting-barrel.md): the redacting read remains the only one on the package barrel and the only lane permitted to feed evidence, manifests, diagnostics, the workspace index, or a grounded answer, but a second, raw lane now exists behind the `./internal/editor-read` subpath for the editor's write-back path, which cannot derive correct offsets from redacted text.

## Context

Issue #5 delivers the layer that lets Keiko understand a developer's repository: detect the
workspace, discover and read files, and assemble a bounded, redacted "context pack" that later
waves feed to a model. In a regulated banking and insurance environment this layer is a security
boundary, not a convenience. Several forces shape the design:

**Untrusted path input.** Task descriptions, CLI arguments, and (in later waves) model output can
all name files. If any of those values reach `node:fs` unchecked, a `..` traversal or an absolute
path can read `/etc/passwd`, an SSH key, or another tenant's checkout. Path containment must be
enforced before every read, and the value handed to the filesystem must be the validated one.

**Secrets must never be read, let alone surfaced.** A repository routinely contains `.env` files,
private keys, and `.npmrc` tokens. `.gitignore` is advisory and frequently incomplete; relying on
it to keep secrets out of a context pack is unsafe. The layer needs an always-on deny list that is
independent of `.gitignore` and cannot be relaxed by it.

**Determinism for auditability (ADR-0004 continuity).** The harness is deterministic so runs are
reproducible. The context layer feeds the harness, so it must be deterministic too: the same
workspace and request must always produce the same pack. That rules out wall-clock ordering,
`Math.random`, and any hidden global state in selection or summarisation.

**Zero-dependency constraint (ADR-0001, load-bearing).** No new runtime npm dependency. This rules
out `ignore`, `globby`, `fast-glob`, and embedding/vector libraries. Glob handling and the
`.gitignore` subset are implemented with Node built-ins, and the translation must avoid
catastrophic-backtracking regular expressions (ReDoS).

**LOC and complexity discipline (ADR-0001).** File ≤ 400 LOC, function ≤ 50 LOC, cyclomatic
complexity ≤ 10. The layer is decomposed into many small single-responsibility files.

**Downstream stability.** Later waves (model context assembly, audit ledger #10, UI #13, and a
future embedding ranker) consume this layer. Its seams — the filesystem port, the retrieval
strategy, and the structured summary — must be typed interfaces defined now.

**Module location.** The new module lives under `src/workspace/**`, mirroring the existing
`src/gateway/**` and `src/harness/**` conventions (typed errors with redacted messages, a
`types.ts` of interfaces plus frozen tables, an `index.ts` barrel).

## Decision

### D1 — A single injectable `WorkspaceFs` port isolates workspace-content reads

Reads and enumeration of caller-controlled workspace content go through one read-only port,
`WorkspaceFs`, with a `nodeWorkspaceFs` adapter over `node:fs`. Keiko-owned persistence stores,
including the encrypted workspace-index store, use their own owning adapters and are outside this
content-read port. Its synchronous core provides UTF-8 reads, metadata, directory enumeration,
canonical paths, and existence checks. The evolved port also provides bounded directory
enumeration, a same-descriptor UTF-8 read, optional bounded byte/prefix/range reads, and a reusable
asynchronous file reader. Detection, discovery, structural analysis, context-pack assembly, and
workspace-content indexing depend on this port. Async facades use the same port; they do not create
a second scanner or bypass containment.

The production bounded reads require the owning lane's preflight `WorkspaceStat`, validate the
pathname with `lstat`, open without following a final-component symlink where the platform supports
it, and bind the opened descriptor to that expected device/inode/metadata snapshot. They check the
descriptor identity again after the read, reject non-regular files, and enforce their byte caps.
Owning guarded read lanes decide whether a stable hard link is authorized: grounded evidence
rejects it, while a separately hash-verified local-knowledge source may accept it.
`readDir(path, maxEntries)` allows callers to detect overflow without materializing an unbounded
directory. Strong metadata (`fileIdentity`, nanosecond timestamps, link count, and size) lets the
workspace index reject stale or substituted records. This keeps the security-relevant logic
testable with an in-memory fake, confines production workspace IO to one auditable adapter, and
keeps consumers independent of the host filesystem API.

The production `stat` and `exists` operations use no-follow metadata semantics: a symlink is
reported as a symlink entry rather than dereferenced. Detection reads manifests and ignore metadata
only through the bounded same-descriptor lane; a custom port without that capability yields absent
advisory metadata instead of falling back to an unbounded raw content read.

### D2 — Lexical containment plus canonical identity at guarded content-read IO edges

`resolveWithinWorkspace(root, candidate)` is a PURE function that rejects NUL bytes, `..` escapes,
and absolute paths outside the root, returning the normalised absolute path inside the root.
Containment is decided by `path.relative(root, candidate)`: a result of `""` is the root itself; a
result that equals `..`, starts with `..` + separator, or is absolute is an escape. This is purely
lexical and needs no filesystem.

Symlinks cannot be judged lexically — a link inside the root can point outside it — so the shared
content-read lanes and the grounded-retrieval paths enforce canonical containment separately at
their IO edges, not only during discovery. For an existing target, `containedRealPathInfo` resolves
it inside the canonical workspace root, and `isCanonicalAllowedContainedPath` proves that the
requested and canonical relative paths are identical and that neither the target nor a symlinked
root introduces a denied segment. A missing target may pass `isAllowedContainedPathParent` only
for an existence probe; that result does not authorize reading or enumeration. New consumers must
compose lexical resolution with these canonical and deny checks before handing a target to IO.

Where the production bounded-read lane is available, its descriptor read binds returned bytes to
the regular-file identity selected by the owning lane's preflight snapshot and rejects symlinks,
non-regular files, oversized inputs, and identities that change before or during the read. Guarded
evidence lanes additionally reject hard-link aliases before content access and revalidate pathname,
canonical containment, root identity, and the strong snapshot after the read before exposing bytes.
Request-local canonical-root reuse in grounded retrieval may avoid repeating initial discovery, but
the admitted root stays the authority anchor and every target is revalidated so replacement cannot
hide behind a new root identity.

`O_NOFOLLOW` protects only the final component, and Node exposes no portable `openat`-style API.
The contained metadata lane therefore binds the admitted root, each parent component, the final
pathname, and the opened descriptor to one lineage snapshot; general guarded lanes bind the
preflight target snapshot and perform the post-read checks above. These checks fail closed on a
persistent parent-component or root substitution. They cannot make several pathname syscalls atomic
against an adversary that alternates an intermediate component between observations; eliminating
that platform limit requires a supported directory-descriptor-relative API. Consumers that use an
older raw port method retain responsibility for the same lexical, canonical, deny, and post-read
validation policy. These checks preserve the static analyser's explicit sanitisation boundary while
binding returned bytes to the validated identity under the host API's documented limit.

A workspace root must not name, introduce, or relocate a denied path locus. Direct credential,
runtime-state, cache, dependency, and VCS roots remain denied even when their lexical and canonical
identities are equal; otherwise selecting `.aws` itself would make a root-relative `credentials`
file appear safe. Ordinary root admission has one narrow path-shaped exception: a project below
`.codex/worktrees/<non-empty descendant>`, because Codex stores real repository worktrees there.
The `.codex` state root and `.codex/worktrees` container themselves remain denied, as does a second
denied segment below an admitted worktree. Keiko also compares each normalised denied suffix at its
exact locus, so one admitted worktree cannot redirect to a separate `.codex` store. The
platform-defined macOS `/private` aliases for `/etc`, `/tmp`, and `/var` remain recognised; ordinary
aliases between roots with no denied locus remain valid. Identity comparison preserves component
case and Unicode spelling because those semantics are properties of the mounted volume, not the
host OS; uncertain spelling fails closed. The shared realpath boundary raises a typed denial before
any target IO; repository retrieval records that decision through the existing correlated,
body-free server activity log instead of presenting the protected root as an empty workspace.

Keiko-managed task worktrees use a separate capability path, never a second path-shape exception.
The server lifecycle owner re-proves the configured managed-root marker as a bounded, regular,
exact-schema file, the persisted workspace instance, deterministically derived exact path,
containment, permitted lifecycle purpose, and the persisted Git linked-worktree identity before
each operation. That identity binds the repository's Git common directory, worktree directory,
`.git` pointer, Git admin directory, and reciprocal `gitdir` backpointer descriptor identities;
deleting and recreating the same path
therefore revokes authority instead of manufacturing a replacement workspace. The owner then
supplies that operation with an unforgeable `WorkspaceFs` capability for the one canonical
worktree root. Generic workspace admission still rejects the same `.keiko` path, unregistered
siblings, aliases, and copied wrapper
objects. Capability minting and propagation are package-internal subpaths pinned to reviewed callers
by the import-policy gate; wrapping an authorised filesystem may preserve its exact authority but
cannot widen or manufacture it. Long-lived consumers must refresh the capability at each governed
effect so removal of the persisted instance or ownership proof revokes subsequent access.
Connected-context detection uses marker-only language metadata because its request-local candidate
inventory already performs the bounded repository walk; structural diagnostics derive additional
observed languages from that shared inventory instead of scanning the repository twice.

### D3 — Two-tier filtering: always-on security DENY vs. best-effort `.gitignore`

Filtering has two independent tiers:

1. **`isDenied(relPath)` — always-on, security.** A frozen `DEFAULT_DENY_PATTERNS` list covers
   secrets (`.env`, `.env.*` except `.env.example`, `*.pem`, `*.key`, `id_rsa`, `*.p12`, `*.pfx`,
   `.npmrc`), dependencies (`node_modules`), build output (`dist`, `build`, `out`, `coverage`),
   caches (`.cache`, `.next`, `.turbo`), VCS (`.git`), logs (`*.log`), and OS cruft (`.DS_Store`).
   A denied path is never discovered and never read, regardless of `.gitignore`. The single
   documented exception is `.env.example`. The check matches any path segment, so a denied
   directory denies everything beneath it.

2. **`compileIgnore` / `isIgnored` — best-effort noise reduction.** A DOCUMENTED, bounded subset
   of `.gitignore`: blank/comment lines, plain `name`, directory `dir/`, extension `*.ext`,
   leading-`/` anchor, `**` segments, and negation `!`. Later rules win, matching git's
   last-match-wins precedence. This tier only narrows results; it can never re-include a denied
   path because the deny tier runs first and independently.

Glob translation emits only linear regex pieces (`[^/]*` for `*`, `.*` for `**`), so there is no
nested unbounded quantifier and therefore no catastrophic backtracking (ReDoS).

### D4 — Deterministic, explainable context-pack selection with byte-budgeting and redaction

`buildContextPack` follows a single documented resolution order:

```
discover -> filter (deny / ignore / boundary)         [done by discovery]
         -> rank by an explainable category heuristic
         -> greedily add excerpts until the byte budget is exhausted
         -> truncate each excerpt to maxBytesPerFile and redact() it
         -> record per-entry metadata
```

Ranking attaches a `selectionReason` from a fixed vocabulary — `entrypoint`, `manifest`,
`documentation`, `config`, `source`, `test` — and orders candidates by that priority with a stable
lexical path tie-break. Selection is greedy against a UTF-8 byte budget; each excerpt is clamped to
`maxBytesPerFile` without splitting a multi-byte character, then redacted. The pack records
`{path, sizeBytes, excerptBytes, selectionReason, truncated}` per entry plus
`{workspaceRoot, totalCandidates, usedBytes, budgetBytes, droppedForBudget}`. No clock and no RNG
are used, so the pack is reproducible. Every excerpt and every error message passes through
`redact()` (reused from the gateway), so a secret that slips past the deny list is still scrubbed.

### D5 — A retrieval seam without embeddings

`RetrievalStrategy` is the typed extension point a future embedding ranker (e.g.
`multilingual-e5-large`) will implement. Wave 1 ships only the interface and a deterministic
`lexicalRetrievalStrategy` default. Embeddings, vector stores, and semantic indexing are explicitly
out of scope; the seam lets them arrive later without changing the context-pack API.

The CLI surface (`keiko context`) and the structured `WorkspaceSummary` (the only object the
CLI/SDK/UI render) are dry-run by construction: they build a summary and never construct an agent
session or call a model.

## Consequences

### Positive

- One shared containment policy and the `WorkspaceFs` boundary give content-read and grounded-
  retrieval callers a single auditable route to canonical, allowed targets, which is both a real
  security property and a clear story for static analysis.
- Secrets are excluded by an always-on deny list that `.gitignore` cannot override, and any excerpt
  or error is redacted as defence in depth.
- The context pack is deterministic and explainable: every selected file carries a reason and a
  size, and identical inputs yield byte-identical packs — directly reusable as audit evidence.
- The `WorkspaceFs` and `RetrievalStrategy` ports make the layer testable without temp files and
  extensible (embeddings) without an API change.
- No new runtime dependency; the `.gitignore` subset and globbing use only Node built-ins and avoid
  ReDoS by construction.

### Negative

- The `.gitignore` subset is intentionally partial: it does not implement every git matching
  nuance (e.g. `**` in the middle of a segment, character classes). Files that a full git
  implementation would ignore may still be discovered; this only adds noise, never a security hole,
  because the deny tier is independent.
- Lexical-only path containment in `paths.ts` is insufficient for aliases. Every new IO consumer
  must compose lexical resolution, the shared canonical/deny predicate, and the appropriate
  descriptor or bounded-enumeration operation; omitting any stage is a security defect.
- Core metadata calls remain synchronous for deterministic fakes, while bounded byte/range readers
  are asynchronous. A single in-flight synchronous host call cannot be pre-empted, so callers cap
  enumeration and check their shared absolute deadline before starting each subsequent unit of
  work. The deadline prevents new work after expiry; it cannot make an already-running syscall
  interruptible.

### Neutral

- Token budgeting uses UTF-8 bytes as a model-agnostic proxy, consistent with ADR-0004's
  `maxContextBytes` choice. A future tokeniser port can refine it without changing the interface.
- `denied`/`ignored` counts are surfaced via `discoverWithStats`; `discoverFiles` keeps the simple
  list signature for callers that do not need stats.

## Alternatives Considered

### Alternative 1: Reuse `.gitignore` as the sole filter (no separate deny list)

Treat the repository's `.gitignore` as the single source of truth for what to skip, including
secrets, and add no independent deny list.

- **Pros**: one mechanism to implement and reason about; matches developer expectations of "if it's
  gitignored, the tool won't read it"; less code.
- **Cons**: `.gitignore` is advisory and routinely incomplete. Plenty of repositories commit
  `.env.example` but forget to ignore a stray `.env.local`, or keep keys in a directory that is not
  ignored. A `!negation` rule can even re-include a secret. Relying on `.gitignore` to keep secrets
  out of a model context pack is a data-exfiltration risk in a regulated environment.
- **Why rejected**: security cannot depend on a file the repository author controls and frequently
  gets wrong. The always-on deny list (D3) is independent of `.gitignore` and cannot be relaxed by
  it; `.gitignore` is demoted to best-effort noise reduction.

### Alternative 2: Add a dependency (`ignore` + `fast-glob`) for filtering and discovery

Pull in the well-tested `ignore` package for full `.gitignore` semantics and `fast-glob`/`globby`
for discovery.

- **Pros**: complete and battle-tested `.gitignore` matching; fast, feature-rich globbing; less
  bespoke code to maintain; avoids subtle matching bugs.
- **Cons**: violates ADR-0001's zero-runtime-dependency constraint, which is load-bearing for the
  supply-chain security posture (ADR-0002). Each added dependency is new audit surface and a new
  update obligation. The full feature set is also more than this layer needs — discovery is a
  bounded recursive walk, not arbitrary glob expansion.
- **Why rejected**: the zero-dependency constraint is non-negotiable. A documented, bounded subset
  implemented with Node built-ins covers the layer's needs and keeps the dependency graph empty.

### Alternative 3: Canonicalise every path with `realpathSync` and compare prefixes (no lexical check)

Resolve every candidate (and the root) with `realpathSync`, then test whether the resolved
candidate string starts with the resolved root string.

- **Pros**: one mechanism handles both traversal and symlinks; intuitively "resolve then compare".
- **Cons**: `realpathSync` requires the path to exist, so it cannot validate a path before deciding
  whether to touch it, and it throws for not-yet-created paths. Naive string-prefix comparison is a
  classic bug: `/repo/root` is a prefix of `/repo/root-sibling`, so a sibling directory would pass.
  It also forces a filesystem call into what should be a pure, cheap, always-run check.
- **Why rejected**: a pure lexical check via `path.relative` (D2) is correct for traversal, needs no
  filesystem, runs before any IO, and avoids the prefix-collision bug. Symlink escape — the one case
  lexical analysis genuinely cannot catch — is handled with a targeted `realPath` check at the IO
  edge, where the path is known to exist.

### Alternative 4: Rank context with embeddings now (semantic retrieval in Wave 1)

Embed the task and every candidate file with `multilingual-e5-large` and rank by cosine similarity
from the start.

- **Pros**: more relevant context selection than a lexical heuristic; directly serves the eventual
  product goal of task-aware retrieval.
- **Cons**: requires an embedding model call (network, latency, cost) or a vector dependency,
  breaking both the dry-run-by-construction guarantee of `keiko context` and the zero-dependency
  constraint. Embedding output is also non-deterministic across model/provider versions, which
  conflicts with the reproducibility requirement.
- **Why rejected**: out of scope for this issue and incompatible with determinism and zero
  dependencies today. The `RetrievalStrategy` seam (D5) lets an embedding ranker be added later as a
  drop-in strategy without changing the context-pack API.

## Related

- ADR-0001: Project Foundation and Toolchain (zero-dependency constraint, strict TypeScript/ESM,
  LOC limits, module layout under `src/`).
- ADR-0002: CI and Supply-Chain Security Baseline (no new runtime deps; CodeQL `javascript-typescript`
  taint analysis — the validated path from `resolveWithinWorkspace` is the only value read).
- ADR-0003: Model Gateway Boundary (the `redact()` helper reused for excerpts and error messages;
  the typed-error pattern this module mirrors).
- ADR-0004: Agent Harness Boundary and State Machine (determinism discipline; UTF-8 bytes as a
  model-agnostic budget proxy; this layer feeds the harness `context-selection` state).
- Issue #5: Build repository context and workspace access layer.
- OWASP Path Traversal: https://owasp.org/www-community/attacks/Path_Traversal

## Date

2026-05-29
