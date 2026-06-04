# ADR-0020: Workspace Tooling and Architecture Gate

## Status

Accepted

## Date

2026-06-03

## Version

1.2

## Context

ADR-0019 defines the target package topology, required dependency direction, and trust-boundary rules for Keiko's modular monorepo. It defers four operational questions to the implementation sprint (Issue #157): workspace manager choice, directory layout, TypeScript project-reference strategy, architecture-gate tooling, and stub strategy. This ADR resolves those questions so that extraction PRs #158–#170 can proceed without re-litigating foundational choices.

Nothing in this ADR migrates domain source files. It only establishes the skeleton that will hold those migrations.

## Decision

### D1 — Workspace Manager: npm workspaces

We will use **npm workspaces** (npm ≥10, already pinned to `npm@10.9.8` in `package.json`).

The `package.json` `packageManager` field is already pinned to `npm@10.9.8`. The CI `ci` job uses `actions/setup-node` with `cache: "npm"` and `npm ci`; the `ui` job uses `npm --prefix ui ci`. Switching to pnpm would require updating every CI job, regenerating lockfiles, validating `--prefix`-equivalent behaviour, and re-auditing supply-chain tooling — a scope expansion orthogonal to this sprint. npm workspaces satisfy the stated requirements: reproducible installs (`npm ci` + committed `package-lock.json`), workspace package references (`"workspaces": ["packages/*"]`), release checks via the existing `prepack` chain, and enterprise supply-chain governance via the existing CycloneDX SBOM step. pnpm may be reconsidered in a later ADR once extraction is complete and the migration cost is better understood.

### D2 — Directory Layout

We will use the following layout for this sprint:

```
/
├── packages/          # internal library packages (workspace members)
│   └── keiko-contracts/
├── src/               # root @oscharko-dev/keiko source (unchanged until extraction PRs)
├── ui/                # Next.js application — unchanged, NOT a workspace member yet
└── package.json       # workspace root + @oscharko-dev/keiko product package
```

The `workspaces` field in `package.json` is `["packages/*"]` only. `ui/` is explicitly not declared as a workspace member. It retains its own `ui/package-lock.json`, its own `node_modules`, and its existing `npm --prefix ui` CI lifecycle unchanged.

Integrating `ui/` into the workspace is owned by Issue #167 ("Extract keiko-ui workspace app and browser-safe type seams"), which is the planned step for runtime composition packages per ADR-0019 §"Migration Strategy". Doing it here would: (1) duplicate #167's work; (2) force an unplanned lockfile consolidation — npm workspaces produce one root `package-lock.json`, which would re-resolve and potentially version-shift `ui/`'s dependency graph; (3) expand this PR's test surface beyond a minimal stub.

The `apps/<name>/` convention is reserved as the intended future sibling location for runnable applications (distinguishing them from publishable library packages under `packages/`). Issue #167 will decide whether `ui/` moves there or stays at the root. This ADR does not prejudge that decision.

### D3 — TypeScript Project References

We will use a shared `tsconfig.base.json` at the repo root and per-package `tsconfig.json` files using TypeScript project references.

**Base config** (`tsconfig.base.json` at repo root): contains all strict compiler options currently in `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `verbatimModuleSyntax`, `skipLibCheck`, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`). It does not set `rootDir`, `outDir`, `composite`, `declaration`, or `declarationMap` — those are per-package concerns.

**Each workspace package** (`packages/<name>/tsconfig.json`) extends `../../tsconfig.base.json` and sets:
- `composite: true` (required for project references)
- `declaration: true`, `declarationMap: true`
- `rootDir: "src"`, `outDir: "dist"`
- `references: [...]` listing its declared `@oscharko-dev/keiko-*` peer packages

**Root package `tsconfig.json`**: retains its current role (full type-check program including `src/`, `tests/`, `*.config.ts`) and additionally includes `packages/*/src/**/*.ts` directly in its `include` glob so that `npm run typecheck` at the root (`tsc -p tsconfig.json --noEmit`) checks all packages in one pass. Per-package `tsconfig.json` files use `composite: true` and act as the per-package build configs; the root tsconfig deliberately does NOT add `references` entries, because `tsc -p ... --noEmit` with references would trigger TS6305 (referenced project's `dist/*.d.ts` must already exist). Project references become load-bearing only when the build script migrates to `tsc -b`, which is deferred per the "Build" paragraph below. The root `tsconfig.build.json` remains the emit config for the root package only and is unchanged.

**Per-package typecheck**: `npm run typecheck -w @oscharko-dev/keiko-contracts` runs the package's own `tsc -p tsconfig.json --noEmit`. No new tooling required.

**Build**: `tsc -b` at the root (project-references build) is the eventual target. During this sprint, `build` remains `tsc -p tsconfig.build.json` because only one stub package exists; the switch to `tsc -b` lands when the first real extraction PR makes incremental compilation load-bearing.

### D4 — Architecture Gate: dependency-cruiser

We will use **dependency-cruiser** to encode and enforce the forbidden dependency directions from ADR-0019.

**Why dependency-cruiser over eslint-plugin-import or custom lint rules**: dependency-cruiser operates on the resolved static import graph across the entire workspace in one pass. It understands package boundaries, can distinguish `type`-only imports from value imports, and produces graph output useful for PR review. ESLint import rules are per-file and cannot express cross-package topology invariants.

**Rules file location**: `.dependency-cruiser.cjs` at the repo root. A CommonJS config is required because dependency-cruiser's config loader does not support ESM.

**Rules that must be encoded** — every named rule in ADR-0019 §"Required Dependency Direction" and §"Trust-Boundary Rules":

From §"Required Dependency Direction":

1. `contracts` must not import from any other `@oscharko-dev/keiko-*` package.
2. `security` may only import from `contracts`.
3. `model-gateway`, `workspace`, `tools`, `evidence` may only import from `contracts` and `security`.
4. `harness` may only import from `contracts`, `security`, `model-gateway`, `workspace`, `tools`, `evidence`.
5. `workflows` may only import from `contracts`, `security`, `model-gateway`, `workspace`, `tools`, `harness`, `evidence`.
6. Domain packages must not import from `server`.
7. Domain packages must not import from `cli`.
8. `ui` must not import Node-only domain packages as value imports; type-only exceptions require an explicit gate override with a justification comment.
9. The root product package must not introduce new domain logic (enforced by restricting `packages/keiko/src/` to composition and re-export imports only).

From §"Trust-Boundary Rules":

1. Direct LLM provider SDK imports (e.g. `openai`, `@anthropic-ai/*`, any `*-ai-sdk`) are forbidden everywhere except inside `keiko-model-gateway`.
2. Browser-visible packages (`keiko-ui`) must not import credential-bearing provider config modules.
3. `keiko-ui` must not import `keiko-model-gateway` internals (enforces safe error routing structurally).
4. Direct `node:fs` imports are forbidden in `keiko-tools`, `keiko-harness`, `keiko-workflows` post-extraction; workspace file access must route through `keiko-workspace`.
5. Patch application must route through `keiko-tools`; post-extraction, direct `node:fs` write imports are forbidden in `keiko-harness` and `keiko-workflows`.
6. `keiko-evidence` is an allowed dependency only from `harness`, `workflows`, `server`, and `cli`; other domain packages are forbidden from importing it.
7. `cli` and `server` may wire dependencies but must not bypass package ports (the direction rules above enforce this).
8. Package-local test files may use narrowly scoped `--do-not-follow` override blocks; production source must not use those exceptions.

**Severity during extraction sprint**: rules are committed as `severity: "error"` for package paths that currently exist; `severity: "warn"` for package paths that do not yet exist. This avoids false-clean results while preventing the gate from blocking on packages that have not been extracted yet.

**CI integration**: The architecture gate runs as a step inside the existing `ci` job, after `npm run lint`, as `npm run arch:check`. This avoids adding a new required job (which would require branch-protection changes). Once the extraction sprint completes and the gate is fully exercised, a dedicated `arch` job may be split out via a follow-up ADR.

The `arch:check` script covers the entire workspace source: `dependency-cruiser --validate .dependency-cruiser.cjs src packages`. This ensures the `keiko-contracts` stub package is under the gate from day one. As further packages are extracted into `packages/`, they are automatically covered without a script change.

### D5 — Minimal Stub Strategy

We will create **one real stub package**: `packages/keiko-contracts/`.

Contents:
- `package.json`: `name: "@oscharko-dev/keiko-contracts"`, `version: "0.0.1"`, `private: true`, `type: "module"`, `exports` pointing to `dist/index.js` and `dist/index.d.ts`.
- `src/index.ts`: a single typed export (`export const KEIKO_CONTRACTS_VERSION = "0.0.1" as const;`) sufficient to prove workspace resolution, project-reference linking, and the import chain end-to-end.
- `tsconfig.json` per D3.
- A package-local `vitest.config.ts` and one trivial unit test to confirm `npm test -w @oscharko-dev/keiko-contracts` works.

No files under the root `src/` are moved or modified.

**Negative gate test**: `tests/architecture/fixtures/bad-import.ts` contains a deliberately rule-violating import (e.g. a simulated `contracts` package re-importing from a higher-level package, or a provider SDK import outside `model-gateway`). This file is:
- Excluded from the root `tsconfig.json` `include` array and `tsconfig.build.json` so it never participates in the real program or build.
- Added to the ESLint flat config `ignores` list so the lint job does not flag the deliberate violation.
- Targeted by `npm run arch:check:negative`, which runs `dependency-cruiser --validate .dependency-cruiser.cjs tests/architecture/fixtures/` and **asserts a non-zero exit code** (the gate must fire). This step runs in CI alongside `arch:check`.

This proves the gate is live without leaving a real violation in the production import graph.

### D6 — Script Topology

Root scripts preserve their current semantics exactly:

| Existing script | Behaviour after this PR |
| --- | --- |
| `npm run typecheck` | Unchanged: `tsc -p tsconfig.json --noEmit`. Root tsconfig adds `packages/*/src/**/*.ts` to its `include` glob (per D3 — direct include, not `references`, to avoid TS6305 under `--noEmit`). |
| `npm run lint` | Unchanged: `eslint . --max-warnings=0`. ESLint flat config un-ignores `packages/*/src` as packages are extracted; `ui/` continues to be ignored (unchanged). |
| `npm test` | Unchanged: `vitest run`. Root vitest config `include` gains `packages/*/src/**/*.test.ts`. |
| `npm run build` | Unchanged this sprint: `tsc -p tsconfig.build.json`. Updated to `tsc -b` when first real extraction makes project references load-bearing. |
| `npm run prepack` | Chain unchanged in full, including the `ui:ci` step which continues to use `npm --prefix ui`. |

New root scripts added by this PR:

| New script | Command |
| --- | --- |
| `arch:check` | `dependency-cruiser --validate .dependency-cruiser.cjs src packages` — covers root source and all workspace packages; gate must pass |
| `arch:check:negative` | Runs gate against fixture and asserts non-zero exit code — proves gate fires on violations |

Per-workspace targeted equivalents via npm `-w` flag require no new `scripts` entries:
- `npm run typecheck -w @oscharko-dev/keiko-contracts`
- `npm test -w @oscharko-dev/keiko-contracts`
- `npm run build -w @oscharko-dev/keiko-contracts`

### D7 — Explicit Non-Goals of This ADR

This ADR does not decide:

- Whether or how internal workspace packages are published independently to npm (deferred to Issue #169).
- Package `exports` fields, `files` manifests, or `types` entries for any package other than the `keiko-contracts` stub.
- Per-package SBOM generation and attestation (deferred to Issue #169).
- Any domain source migration — that begins in Issues #158–#168.

## Consequences

### Positive

- All tooling questions left open by ADR-0019 are resolved before any extraction PR lands.
- The architecture gate is committed and enforced in CI before the first package boundary is created, making it structurally impossible to land an extraction PR that violates the dependency graph.
- npm workspaces requires no toolchain change: existing `npm ci`, lockfile, cache, SBOM steps, and `ui/` CI lifecycle are unchanged.
- Negative gate test gives reviewers confidence the gate fires on real violations.
- Script topology is purely additive; no existing script changes.

### Negative

- dependency-cruiser is a new devDependency.
- Architecture gate rules start in warn-only mode for unextracted packages. Until packages are extracted, the gate does not block violations in the not-yet-extracted `src/` tree for those package boundaries.

### Neutral

- `tsconfig.base.json` adds a third tsconfig file. The three files have distinct roles: `tsconfig.base.json` (shared options), `tsconfig.json` (type-check program), `tsconfig.build.json` (emit).
- The `tsc -b` migration for `build` is deferred; until it lands, incremental project-reference compilation is not active.

## Alternatives Considered

### Alternative 1: pnpm workspaces

- **Pros**: Stricter phantom-dependency prevention; content-addressed store; cleaner lockfile format.
- **Cons**: Requires changing `packageManager` field, all CI `npm ci` steps, `--prefix` patterns, and cache strategy. Introduces lockfile format change.
- **Why rejected**: `packageManager` is pinned to `npm@10.9.8` and all CI is npm-native. Migration risk is orthogonal to the sprint goal. pnpm remains an option for a later ADR.

### Alternative 2: Move ui/ to apps/ui/ in this PR

- **Pros**: Eliminates the `src/ui/` BFF vs `ui/` Next.js app naming ambiguity earlier; aligns the directory tree with the eventual target layout.
- **Cons**: Duplicates the work owned by Issue #167. Forces an unplanned lockfile consolidation: npm workspaces produce one root `package-lock.json`, which would re-resolve `ui/`'s dependency graph and risk version shifts. Expands this PR's diff and test surface well beyond a minimal stub. Violates ADR-0019 §"Migration Strategy" which extracts runtime composition packages (server, cli, ui) last.
- **Why rejected**: The migration sequence in ADR-0019 exists to bound risk at each step. Moving the UI here skips steps 2–4 of that sequence. Issue #167 is the correct owner.

### Alternative 3: eslint-plugin-import boundary rules instead of dependency-cruiser

- **Pros**: No new tool; already using ESLint.
- **Cons**: Per-file analysis cannot express whole-graph invariants or validate the workspace package topology independently of the TS compiler.
- **Why rejected**: dependency-cruiser is the reference tool named in ADR-0019 and addresses cross-package topology directly.

### Alternative 4: Dedicated arch-gate CI job

- **Pros**: Gate failure visible as a named required check.
- **Cons**: Requires branch-protection configuration change to add a new required check; needs admin coordination.
- **Why rejected**: Embedding in the existing `ci` job keeps the gate live with zero branch-protection changes. A dedicated job can be split out via follow-up ADR once the gate matures.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md): Modular Package Architecture (parent decision — this ADR operationalises it)
- Issue #157: Establish workspace tooling and architecture dependency gates
- Issues #158–#170: Package extraction PRs that depend on this ADR
- Issue #169: Independent package publishing and per-package SBOM (deferred)

## Revision Policy

If workspace manager, layout, gate tooling, or stub strategy changes materially, increment the version and record the reason below.

## Version History

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 2026-06-03 | Initial operational addendum to ADR-0019: workspace manager, layout, TS references, architecture gate, stub strategy, and script topology for Issue #157. |
| 1.1 | 2026-06-03 | D3 clarification: root tsconfig uses direct `packages/*/src/**/*.ts` include rather than `references` entries to avoid TS6305 under `tsc -p ... --noEmit`. Same one-pass typecheck intent; project references remain inside each package and become load-bearing when the build migrates to `tsc -b`. |
| 1.2 | 2026-06-03 | D6 script-topology table updated to match D3's direct-include strategy (drift caught in review). No behaviour change. |
