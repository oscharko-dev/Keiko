# ADR-0016: Deeper Files Explorer BFF Surface (`/api/files/*`)

## Status

Accepted

## Context

Issue #75 (parent epic #61, follow-up to #67) requires the desktop Files widget to read directory
trees and file previews from the selected registered project root with the same safety invariants
the workspace layer (ADR-0005) enforces: containment, the always-on deny list, redacted previews, and
bounded reads. The current BFF, `src/ui/files.ts`, already implements path containment, symlink
escape rejection, a 1000-entry directory cap, 1 MB text preview cap, 3 MB image preview cap, and
redaction over text previews. What it did not enforce until #75 was the deny list and `.gitignore`
filtering — the same two-tier `src/workspace/ignore.ts` rules that ADR-0005 D3 makes a load-bearing
safety boundary.

Three forces shape the decision.

**The Files BFF is project-root scoped, but its browsing path is dynamic.** The browser supplies a
registered project path as `root`; the BFF rejects unregistered roots before touching the filesystem.
Directory navigation and preview paths are then resolved inside that project root with lexical and
realpath containment checks. `src/workspace/` is keyed to a single registered workspace at the
harness level via `resolveWithinWorkspace`; the Files BFF keeps its own route-local path helpers so
it can return tree/preview metadata without changing the workspace context-pack API.

**The deny list is a server-side safety invariant the client must not be able to probe.** If the
UI exposed the matched deny pattern or the requested path in an error message, a developer (or any
script driving the UI) could enumerate which paths under a root are deny-listed and which are not.
That is an information leak even when no file content is read. The deny check therefore returns a
generic `403 DENIED` with a generic message; the client renders that as a generic
"excluded from the read surface for safety" alert, never the raw BFF body.

**`.gitignore` and the deny list have different consequences and must stay distinct.** The deny
list is tier 1: always on, applied to tree listings and previews, no opt-out. `.gitignore` is
tier 2: best-effort noise reduction. A user clicking a direct URL to a build artifact they want to
inspect should still receive a preview — `.gitignore` is not a safety boundary and never was.
Folding both into a single filter would either weaken the deny list or block legitimate previews.

## Decision

### D1 — Route family: `/api/files/*` is separate from `/api/workspace/*`

We keep `/api/files/*` (three GET handlers: `/api/files/directories`, `/api/files/tree`,
`/api/files/preview`) as a distinct route family from `/api/workspace/*` (ADR-0013). Both route
families read only from registered project roots. `/api/files/*` adds lazy tree/preview shapes for
the desktop Files widget, while `/api/workspace` keeps the context-pack summary shape. No write or
execute routes are added by #75 — the surface remains read-only.

### D2 — Deny enforcement: always-on, applied to both tree and preview

`isDenied` from `src/workspace/ignore.ts` is the single source of truth. The Files BFF wraps it in
`src/ui/files-deny.ts` purely to scope the error message and provide a typed call site. Three
enforcement points:

1. `listTreeEntries`: filter denied entries out of the response before the truncation counter
   advances. A directory packed with deny-listed entries (e.g. `node_modules/**`) cannot exhaust
   the 1000-entry budget and hide real files behind `truncated: true`.
2. `listFilesDirectories`: reject denied directory selections and omit denied child directories from
   the folder-picker response.
3. `readFilesTree`: if the resolved relative path itself is denied (e.g. navigating directly to
   `?path=.git`), throw `403 DENIED`.
4. `readFilesPreview`: if the resolved relative path is denied (e.g. `?path=.env`,
   `?path=node_modules/foo.js`), throw `403 DENIED` before opening the file.

Deny is applied before realpath and again after realpath. A symlink whose own name matches a deny
pattern is denied, and a safe-looking symlink alias whose real target is deny-listed is also denied.
This matches the workspace-layer read semantics and prevents both name-based and target-based
aliases from bypassing the filter.

The `.env.example` exception in `isDenied` is preserved automatically — no Files-specific carve-out
is added or needed.

### D3 — `.gitignore` enforcement: best-effort, tree listings only

`compileIgnore`/`isIgnored` from `src/workspace/ignore.ts` apply only to `listTreeEntries`.
`readFilesPreview` is unaffected: a user explicitly clicking a file URL still previews it.

The matcher is loaded per request from the resolved project root's `.gitignore` (no recursion into nested
`.gitignore` files; the workspace layer documents this bounded subset). A missing or unreadable
`.gitignore` produces `null`, which the call site treats as "no filter". There is no long-lived,
module-level cache: the BFF must stay stateless across registered projects so switching projects
within a single Files session never reuses a stale matcher.

### D4 — Generic safety message on the client; never leak the matched pattern or the path

The UI converts `ApiError` with `code === "DENIED"` into a single generic message:

> "This file is excluded from the read surface for safety (matches a deny pattern such as `.env`,
> `*.pem`, `node_modules`, `.git`, …)."

The raw BFF body is never rendered. The requested path is never echoed back into the alert. The
alert uses `role="alert"` so assistive technologies announce the block. Tree listings simply omit
denied entries server-side, so no client-side denied-row rendering is needed.

### D5 — Path containment stays duplicated, deliberately (tracked follow-up)

The Files BFF implements its own `normalizeRelativePath`, `isContained`, and `resolveInsideRoot`.
Functionally these are equivalent to `src/workspace/paths.ts` + `src/workspace/realpath.ts` but
they are not shared. Unifying them would require refactoring the workspace layer to expose reusable
tree/preview primitives in addition to context-pack discovery, which is larger than #75. The
duplication is deliberate but tracked as a follow-up; future
maintenance must keep `isDenied` and the symlink-containment check in lockstep with the workspace
layer.

## Consequences

### Positive

- **Always-on deny list closes the original information-leak risk.** `.env`, `id_rsa`,
  `*.pem`, `.npmrc`, `node_modules/**`, `.git/**`, `*.log`, and the rest of `DEFAULT_DENY_PATTERNS`
  can no longer be enumerated or previewed via `/api/files/*`. The single documented exception,
  `.env.example`, remains previewable.
- **`.gitignore` reduces visual noise without changing safety.** Build outputs and other ignored
  paths drop out of tree listings. Direct previews are unaffected.
- **No new write or execute surface.** ADR-0005 D1's "no arbitrary read of arbitrary paths"
  invariant is reinforced by binding reads to registered projects; ADR-0006 (sandbox boundary) is untouched.
- **Server-side filtering preserves the truncation budget.** A directory full of denied entries no
  longer hides real files behind `truncated: true`.
- **Single source of truth for deny rules.** Both `src/workspace/` and `src/ui/files.ts` read from
  the same `DEFAULT_DENY_PATTERNS` and the same `isDenied` function; there is no second
  list to drift.

### Negative

- **Path-containment logic is duplicated** between `src/ui/files.ts` and `src/workspace/paths.ts`
  / `src/workspace/realpath.ts`. A future bug fix to either copy must be ported to the other. This
  is the deliberate tradeoff in D5; it must be revisited if a third caller appears.
- **`.gitignore` is loaded once per `readFilesTree` request.** For deeply nested directory
  navigation this is N file reads for N tree fetches. The cost is bounded (a single small file at
  the root) and noise reduction does not need to be optimal, but a future optimisation could cache
  per-root for the lifetime of an HTTP request if profiling justifies it.
- **The denied-preview UI does not name the matched pattern.** A developer who genuinely needs to
  know why a file is blocked must consult `DEFAULT_DENY_PATTERNS` directly. This is intentional —
  the deny list must not be probable via error text.
- **Arbitrary folder browsing is not a Files BFF responsibility.** A developer can register a new
  project through the project flow, but `/api/files/*` does not accept raw host paths outside that
  registry.

### Known follow-ups

- Unify path-containment between `src/ui/files.ts` and `src/workspace/paths.ts` /
  `src/workspace/realpath.ts` if a third caller emerges.
- Per-request memoisation of the compiled `.gitignore` matcher across multiple `readFilesTree`
  calls in a single request lifecycle, if profiling shows it matters.
- Optional support for nested `.gitignore` files (currently only the project root's is read,
  matching the workspace layer's bounded subset).

## Alternatives Considered

### Alternative 1: Share `src/workspace/discovery.ts` and `resolveWithinWorkspace` directly

Have the Files BFF call into `src/workspace/discovery.ts` to enumerate entries, and use
`resolveWithinWorkspace` instead of the BFF's own `resolveInsideRoot`.

- **Pros**: one set of containment + deny + `.gitignore` rules; no duplication; bug fixes apply
  once.
- **Cons**: the workspace layer returns context-pack entries, not the tree/preview shapes the Files
  widget needs; refactoring it for UI tree navigation is larger than #75.
- **Why rejected**: the route still shares the registered-project boundary and deny/ignore
  primitives, but keeps the UI response shape local to `src/ui/files.ts`.

### Alternative 2: Apply `.gitignore` to previews as well as listings

Treat `.gitignore` as a hard filter on both tree and preview so a user cannot view an ignored
file via direct URL.

- **Pros**: simpler mental model ("ignored = invisible"); one filter, two surfaces.
- **Cons**: `.gitignore` is advisory and frequently incomplete (per ADR-0005 D3); it is not a
  safety boundary; users routinely want to inspect build artifacts (`generated/bundle.js`,
  coverage reports) that are ignored but not secret; blocking previews of every ignored file would
  break a legitimate developer workflow.
- **Why rejected**: `.gitignore` is tier 2 (noise reduction), not tier 1 (safety). Conflating
  them either weakens the deny list (if tier 2 is allowed to relax tier 1) or breaks legitimate
  previews. The two-tier semantics in `src/workspace/ignore.ts` are the correct shape and we
  mirror them.

### Alternative 3: Render the matched deny pattern in the UI for transparency

When a preview is denied, show the matched pattern (e.g. "Denied: matches `*.pem`") so the
developer knows exactly why.

- **Pros**: transparent UX; the developer can change file naming or update the deny list with
  full context.
- **Cons**: an attacker (or any script with UI access) can enumerate which patterns trigger which
  files; combined with directory-listing probing they could map the deny list and find
  near-misses; the deny list is meant to be a server-side safety invariant the client cannot
  probe.
- **Why rejected**: the deny list is a security boundary. Information about *why* a path was
  blocked is itself a leak. The generic safety message lists common deny categories so the
  developer has enough orientation without enabling enumeration.

## Related

- ADR-0005: Repository Context and Workspace Access Layer — defines `DEFAULT_DENY_PATTERNS`,
  `isDenied`, `compileIgnore`/`isIgnored`, the two-tier semantics this ADR mirrors, and the
  always-on/best-effort distinction.
- ADR-0006: Safe Tool Execution and Sandbox Boundary — unchanged; #75 adds no write/execute
  surface.
- ADR-0011: Wave-1 User Interface and Packaging — BFF route shape, `UiHandlerDeps` injection
  pattern, `errorBody` envelope, WCAG 2.2 AA baseline.
- ADR-0013: UI-Local Persistence — unrelated route family; mentioned only to clarify that
  `/api/files/*` is independent of `/api/projects`, `/api/chats`, and `/api/workspace`.
- ADR-0014: Keiko Workspace Shell Architecture — read-only mount discipline; ToolRail integration
  for the Files widget.
- Issue #61: Parent epic — local workspace shell.
- Issue #67: ToolRail Files MVP that this ADR's surface backs.
- Issue #75: Deeper files explorer integration (deny enforcement, `.gitignore` honoring, ADR).

## Date

2026-06-01
