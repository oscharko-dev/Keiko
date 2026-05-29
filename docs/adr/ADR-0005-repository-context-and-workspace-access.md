# ADR-0005: Repository Context and Workspace Access Layer

## Status

Accepted

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

### D1 — A single injectable `WorkspaceFs` port isolates all filesystem I/O

All filesystem access goes through one port, `WorkspaceFs` (`readFileUtf8`, `stat`, `readDir`,
`realPath`, `exists`), with a `nodeWorkspaceFs` adapter over `node:fs` (synchronous, mirroring the
gateway's `readFileSync` usage). Detection, discovery, context-pack assembly, and reading all
depend on the port, never on `node:fs` directly. This makes the security-relevant logic testable
with an in-memory fake (no temp files), confines every real IO call to one auditable file, and
keeps the rest of the module pure.

### D2 — Lexical containment in `paths.ts`; realpath/symlink containment at the IO edge

`resolveWithinWorkspace(root, candidate)` is a PURE function that rejects NUL bytes, `..` escapes,
and absolute paths outside the root, returning the normalised absolute path inside the root.
Containment is decided by `path.relative(root, candidate)`: a result of `""` is the root itself; a
result that equals `..`, starts with `..` + separator, or is absolute is an escape. This is purely
lexical and needs no filesystem.

Symlinks cannot be judged lexically — a link inside the root can point outside it — so symlink
containment is enforced separately at the IO edge in `discovery.ts`: any entry whose `realPath`
resolves outside the root (or whose `realPath` cannot be resolved) is skipped, never followed. The
returned value of `resolveWithinWorkspace` is the ONLY path handed to the filesystem, so a static
analyser's path sanitiser (CodeQL `javascript-typescript`) sits exactly on the read boundary.

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

- A single boundary function gates every read; the validated path is the only one the filesystem
  ever sees, which is both a real security property and a clear story for static analysis.
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
- Lexical-only path containment in `paths.ts` is insufficient for symlinks; the realpath check must
  be applied at the IO edge. The split is documented but is a place a future caller could get wrong
  if it reads files without going through `readWorkspaceFile`.
- Synchronous IO mirrors the existing gateway style but blocks the event loop on very large
  repositories. The `maxFiles`/`maxDepth` caps bound this; an async port is a future option.

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
