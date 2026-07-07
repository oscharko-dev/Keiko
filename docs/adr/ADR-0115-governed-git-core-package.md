# ADR-0115: Governed git core package (keiko-git)

## Status

Accepted (2026-07-07).

## Context

Keiko's git integration had grown four independent implementations of the same low-level
primitives, spread across `keiko-server`, `keiko-tools`, and `keiko-workspace`:

- **Process execution.** `packages/keiko-server/src/gitRoutes.ts` owned a hardened spawn path
  (byte caps, wall-clock timeout, config-isolated env); `gitRepositoryRoutes.ts` carried a second,
  hand-rolled clone spawn with its own monitoring; `keiko-tools/src/exec.ts` governs a third spawn
  boundary for tool commands (a deliberate, separately-governed surface — see below).
- **Repository membership.** The server resolved "which repository owns this folder" with
  `rev-parse --show-toplevel` plus **string arithmetic** (`path.relative` on a stored root vs.
  git's answer). Four copies of the same `isContained` helper existed (`gitRoutes.ts`,
  `files.ts`, `store-handlers.ts`, and via import in `grounded-git-history-evidence.ts`), all
  case-sensitive on darwin.
- **Failure classification.** Phrase tables over git stderr existed in the server
  (`classifyFailure`) and in three keiko-tools gateways, with different vocabularies and
  ordering rules.
- **Environments.** `gitEnv` / `networkGitEnv` lived in the server; the network profile passed
  the host locale (`LANG`/`LC_ALL`) through to git.

Two production defect classes fell directly out of this duplication:

1. **Subfolder/repository recognition was flaky on macOS.** APFS (and NTFS) resolve paths
   case-insensitively and normalization-insensitively (NFC vs NFD — relevant for German folder
   names like `bär/`), but the containment comparison was byte-exact on darwin. A stored project
   root whose spelling differed from git's on-disk answer (`getcwd`-cased toplevel) produced
   `repository-root-outside-root` — "this folder is not a repository" — intermittently, for
   valid repositories and subfolders. Node's JS `realpath` does not normalize letter case, so
   realpath-ing both sides did not close the gap.
2. **Failure classification could silently degrade.** Because `networkGitEnv` inherited the host
   locale, a German system produced localized `fatal:`/`error:` lines, which phrase-based
   classifiers (sync/publish/PR/merge outcome mapping) cannot match — errors fell through to
   generic reasons and misleading user guidance.

## Decision

Introduce **`@oscharko-dev/keiko-git`** — a leaf package (dependency: `keiko-contracts` only,
enforced by dependency-cruiser rule `adr-0019-direction-2b-git-only-contracts` and the ADR-0019
package-graph allowlist) that owns the shared git core:

1. **One hardened process runner** (`createGitProcessRunner`, `defaultGitProcessRunner`,
   `defaultGitNetworkProcessRunner`): byte-capped output, wall-clock timeout with SIGTERM→SIGKILL
   escalation, spawn-error mapping to exit 127, and a `timedOut` result flag distinct from
   byte-cap truncation.
2. **Two hardened environments** (`gitEnv`, `networkGitEnv`), both pinning `LC_ALL=C` so every
   parsed or classified git message is stable English. The network profile keeps only
   credential-relevant account state (HOME/SSH agent), never inherits caller `GIT_*` overrides,
   and fails closed on every interactive path (terminal prompt, askpass, host-key TOFU).
3. **Repository membership by git, not by string math** (`resolveGitMembership`): one bounded
   `rev-parse --show-toplevel --show-prefix` invocation returns both the owning repository root
   and the selected folder's prefix inside it — correct for subfolders at any depth, linked
   worktrees and submodules (where `.git` is a file), and unborn HEAD.
4. **Platform-correct path containment** (`containsPath`): case- and NFC-insensitive on darwin
   and win32 (the platforms' default filesystem identity), byte-exact on Linux (where NFC/NFD
   are genuinely different directories and normalizing would loosen a security guard). Used as
   defense-in-depth only — membership itself comes from git.
5. **One failure classifier** (`classifyGitFailure`): exit-127 → `git-missing`, `timedOut` →
   `timeout`, dubious-ownership → `unsafe-repository`, not-a-repository, else `git-error`.

**Consumers.** `keiko-server` (routes, files/store containment, grounded git-history evidence,
clone) consumes the core; `gitRoutes.ts` re-exports the process surface so route modules and
tests keep one BFF-local seam. The wire contracts are unchanged: `timeout` maps onto the existing
`git-error` reason at the route boundary, and the precise classification stays available
server-side.

**Non-goals.**

- `keiko-tools`' exec boundary (ADR-0043 sandbox/egress governance, `gh` invocations, tool
  allowlists) remains its own governed spawn surface; the arch rules now permit keiko-tools →
  keiko-git for future reuse of parsers/classification, but the governed gateways are not folded
  into the core.
- `keiko-workspace` stays spawn-free by design (ADR-0019 rule 3b): its marker-based workspace
  detection and `.git`-file reading operate through the WorkspaceFs port within the connected
  scope's trust boundary. A **workspace root** (nearest ecosystem/VCS marker) is deliberately not
  the same concept as a **repository root** (git's toplevel); callers that need the latter use
  `keiko-git` via the server.

## Consequences

- Subfolder recognition no longer depends on how the user spelled a path: git decides
  membership, and the residual containment guard uses the platform's filesystem identity. The
  `repository-root-outside-root` false negative on APFS is gone.
- Sync/publish/PR/merge outcome classification is locale-independent; German host systems get
  the same typed reasons as English ones.
- A wedged git process (dead network filesystem, stuck hook) can no longer hang a route past its
  timeout: SIGTERM escalates to SIGKILL after a bounded grace period.
- New consumers get the hardened behavior by construction instead of copying it; the four
  containment copies are one function, and the clone path shares the runner's byte/time bounds.
- The package adds one node to the ADR-0019 graph: `contracts ← git ← {server, tools}` with the
  same inward-only direction discipline, machine-enforced in dependency-cruiser, the package
  graph allowlist, and `tsconfig.packages.json`.
