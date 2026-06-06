# Test Intelligence Standalone Compatibility for Keiko Quality Intelligence Migration

**Document Purpose**: Record the compatibility contract for the standalone `@oscharko-dev/test-intelligence` package during Keiko's native Quality Intelligence migration (Epic #270, issue #286). This document establishes what workflows and artifacts remain supported on the standalone product path without automatic breakage, which artifacts Keiko will ignore or import explicitly, and which product decisions are deferred to later explicit governance issues.

**Audience**: Product managers, operations teams, and implementors who need to understand whether existing standalone Test Intelligence workflows will continue to work during and after the Keiko-native migration.

---

## 1. Scope and Directional Decision

The standalone `@oscharko-dev/test-intelligence` package remains a separate repository and product surface during Keiko's native Quality Intelligence implementation. Keiko does not import any Test Intelligence runtime, store, CLI, gateway, harness, or Workbench build output.

The directional product status for the standalone product is: **maintenance-only until a separate explicit retirement/migration product decision is taken**. No active feature development for the standalone product is committed to in this document. No auto-migration of credentials, artifacts, or configuration is committed to. Existing teams using the standalone Test Intelligence will continue to receive support for their current usage; teams adopting Keiko will use native Quality Intelligence instead.

---

## 2. Compatibility Matrix

| Standalone TI Surface                                                                                                            | Behavior Preserved?                                                                                                                    | Keiko-Side Action                                                                                                                                                           | Owner                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Package**: `@oscharko-dev/test-intelligence` npm install                                                                       | Yes, unchanged.                                                                                                                        | Zero Keiko imports of TI packages or any `@oscharko-dev/ti-*` namespace. Enforced by `arch:check` rule `direction-10a`.                                                     | Architecture (enforced by #287)                              |
| **CLI Binary**: `test-intelligence run`, `test-intelligence review`, `test-intelligence tms-push`, `test-intelligence calibrate` | Yes, unchanged as a standalone binary.                                                                                                 | Zero embed or repackage of TI's CLI binary. Keiko defines native `keiko quality-intelligence` subcommands alongside (not replacement) TI CLI.                               | Product (no deprecation until explicit issue #286 follow-up) |
| **Workbench UI**: Local Next.js app running `localhost:3001` (or configured port)                                                | Yes, unchanged as a separate Node process.                                                                                             | Zero embed or build TI's Workbench into Keiko's UI bundle. Keiko's Quality Intelligence UI lives in `keiko-ui` package only.                                                | Product + Engineering (UI isolation)                         |
| **Runtime state**: `.test-intelligence/` directory (run-state, storage-artifacts, gbe, jobs, local-runtime)                      | Keiko does not read, write, or move files under `.test-intelligence/` by default.                                                      | If user explicitly requests artifact import via a future `keiko migrate` command (deferred), Keiko will import via explicit permission only, never silently. See section 3. | Operations + Product (explicit user action required)         |
| **Workbench database**: `.test-intelligence/workbench.db` (BetterSQLite3)                                                        | Yes, unchanged and untouched by Keiko.                                                                                                 | Keiko uses its own `keiko-server` SQLite store for UI state. No shared database, no schema migration, no automatic backup.                                                  | Engineering (separate stores)                                |
| **Local runtime config**: `.test-intelligence/local-runtime/workbench-settings.json`                                             | Yes, unchanged and untouched by Keiko.                                                                                                 | Keiko uses environment-variable-only credential injection (see section 4). No plaintext credential files.                                                                   | Engineering (separate credential model)                      |
| **Model Gateway config**: TI's provider setup (OAuth tokens, API keys in `workbench-settings.json` or environment)               | Keiko uses distinct `KEIKO_*` environment variables, not TI's `TI_*` vars. No credential sharing.                                      | See section 4 below.                                                                                                                                                        | Engineering (disjoint environment vars)                      |
| **Evidence/Audit dossier**: TI's run evidence (stored in `.test-intelligence/storage-artifacts/` or Workbench DB)                | Keiko native evidence uses `keiko-evidence` package with distinct schema.                                                              | TI evidence and Keiko evidence are separate stores. If import is required, see section 3 (deferred to explicit migration tool).                                             | Product + Engineering (#274 evidence extension)              |
| **Judge calibration artifacts**: TI's judge training/calibration records in Workbench DB                                         | Keiko uses `keiko-quality-intelligence` judge seam with distinct calibration contract.                                                 | No shared judge state. Judge calibration is not auto-migrated.                                                                                                              | Engineering (#279 judge extension)                           |
| **TMS/Jira export adapters**: TI's connectors for test-push and traceability sync (in `packages/integrations/`)                  | Keiko exports are deferred to #283. When implemented, Keiko uses `keiko-server` connector routes (user-configured, env-var-only auth). | TI's export code is reference only; Keiko reimplements from scratch with dry-run preview required. Do NOT copy TI's export implementations.                                 | Product (#283 export gates)                                  |

---

## 3. Legacy Artifact Decision Record

For each class of artifacts found under `.test-intelligence/` and `packages/*/test-fixtures` in the standalone repo, the following decision applies:

| Artifact Class                                                             | Found At                                                     | Decision                                                                                                                                                                                                                                    | User Action Required                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Run state** (execution logs, progress checkpoints, cancellation markers) | `.test-intelligence/run-state/{runId}/`                      | `ignored` — Keiko does not read these on disk. Keiko uses its own harness-based run state.                                                                                                                                                  | None (Keiko independent).                                                                |
| **Generated test cases** (JSON/YAML exports from prior runs)               | `.test-intelligence/storage-artifacts/`                      | `migration-assisted-by-dedicated-tool-deferred` — A future explicit `keiko migrate test-cases` tool (deferred to a follow-up issue after #285 completes) will offer to import with format conversion and sanitization. Until then, ignored. | User must run `keiko migrate test-cases --source <path>` (tool deferred; see section 6). |
| **Workbench database** (BetterSQLite3)                                     | `.test-intelligence/workbench.db`                            | `ignored` — Keiko uses its own `keiko-server` SQLite store. No schema migration, no backup of TI DB.                                                                                                                                        | None (Keiko independent).                                                                |
| **Judge calibration records**                                              | `.test-intelligence/workbench.db` (Workbench DB table)       | `migration-assisted-by-dedicated-tool-deferred` — Judge calibration is QI-domain specific. A future tool (deferred) will assist conversion if needed. Until then, ignored.                                                                  | User must request migration via explicit product decision (deferred).                    |
| **Figma snapshots** (render captures, localized frames)                    | `.test-intelligence/gbe/` (Figma GBE cache)                  | `ignored` — Keiko re-discovers and caches Figma via its own connector and `keiko-local-knowledge` capsule store. TI's GBE snapshots are not imported.                                                                                       | None (Keiko independent; user re-authorizes Figma token if desired).                     |
| **Policy profiles** (team rules, constraint configs)                       | `.test-intelligence/local-runtime/policies.json` (if exists) | `migration-assisted-by-dedicated-tool-deferred` — A future tool (deferred) will help convert policy YAML/JSON to Keiko's policy registry. Until then, ignored.                                                                              | User must manually recreate policies in Keiko or request migration tool.                 |
| **Evidence manifest** (TI's attestation format)                            | `.test-intelligence/storage-artifacts/` + Workbench DB       | `ignored` — Keiko uses `keiko-evidence` schema (different structure, redaction contract, retention policy). No automatic conversion.                                                                                                        | None (independent evidence stores).                                                      |
| **Parity test fixtures** (TI's own unit/integration test data)             | `packages/ti-*/tests/fixtures/` in TI repo                   | `importable-via-explicit-keiko-command` — #277 and #285 will create synthetic Keiko-owned parity fixtures (test-case golden examples, judge inputs, multi-source reconciliation, export samples). NOT copied from TI.                       | #285 must implement its own parity fixtures without importing TI test data.              |

**Summary**: By default, Keiko **ignores** all `.test-intelligence/` artifacts. No silent writes, no background migrations, no implicit credential sharing. All migrations require explicit user action (via a deferred tool, not yet built). Keiko's own evidence, state, and configuration are entirely separate.

---

## 4. Standalone Independence Guarantee

The following invariants protect the standalone product and prevent accidental coupling:

1. **No auto-discovery or auto-write to `.test-intelligence/` paths**: Keiko does not scan, read, write, move, or delete any file under `.test-intelligence/` by default. If a user requests artifact import via a future migration tool (deferred), they explicitly provide a path and authorize the action.

2. **Disjoint environment variables**: Keiko uses `KEIKO_*` environment variables only (e.g., `KEIKO_OPENAI_API_KEY`, `KEIKO_DATA_DIR`). The standalone uses `TI_*` environment variables. No overlapping variable names. No credential sharing via environment.

3. **No shared local SQLite database file**: Keiko's `keiko-server` uses its own `keiko-state.db` (or configured path). The standalone uses `.test-intelligence/workbench.db`. These are separate files on separate paths. No migration, no schema unification.

4. **No shared credential store**: The standalone's plaintext credential storage in `.test-intelligence/local-runtime/workbench-settings.json` is a known defect (listed in `quality-intelligence-test-intelligence-inventory.md` §2.3 as `workbench-settings-plaintext-credentials` CRITICAL). Keiko does not inherit this defect. Keiko injects credentials via environment variables at runtime only. All credentials are masked before logging (via `keiko-security` redaction primitives).

5. **No credential or artifact auto-migration**: Users are not silently migrated from the standalone to Keiko. Credentials are never copied or moved without explicit authorization. The standalone product can continue to operate independently even after Keiko native QI ships.

---

## 5. Verification Hooks for #285

The parity matrix in #285 must verify that Keiko's native Quality Intelligence and the standalone Test Intelligence produce equivalent user-visible behavior **without requiring live credentials, customer data, or a running TI instance**. The following check IDs enable isolated, offline verification:

### Check 5.1: `parity:standalone-import-static`

**Purpose**: Assert that no Keiko source file imports `@oscharko-dev/test-intelligence` or any `@oscharko-dev/ti-*` package (directly or transitively).

**Command**:

```bash
cd /Users/oscharko-dev/Projects/Keiko && \
  npm run arch:check 2>&1 | grep -i direction-10a || true
# Expected: rule `direction-10a-quality-intelligence-only-contracts-security` passes (no violations)
```

**Assertion**: Exit code = 0. If any package (especially `keiko-quality-intelligence`) imports a forbidden namespace, `arch:check` must fail with a clear error.

**Owned by**: #287 (rule definition and enforcement).

---

### Check 5.2: `parity:legacy-state-isolation`

**Purpose**: Assert that Keiko does not read, write, or move files under any path matching `.test-intelligence/` on disk.

**Command** (static analysis):

```bash
cd /Users/oscharko-dev/Projects/Keiko && \
  grep -r '\.test-intelligence' src/ tests/ --include="*.ts" --include="*.tsx" || echo "No matches (expected)"
# Expected: No matches found
```

**Assertion**: Exit code = 0 and no output. If any string `.test-intelligence` appears in source, it must be in a comment explaining why it's safe (e.g., documentation, test fixture path that is explicitly guarded).

**Runtime check** (after `keiko` command runs): User's `.test-intelligence/` directory must be unchanged (same file count, same timestamps). Automated verification deferred to #286 follow-up issue.

**Owned by**: #286 (this issue).

---

### Check 5.3: `parity:behavior-fixture`

**Purpose**: List synthetic fixture pairs that #285 must implement to verify behavior parity without customer data or live credentials.

**Fixtures to implement in #285** (representative sample from `quality-intelligence-test-intelligence-inventory.md` §4):

| #   | Fixture Name                    | TI Reference                                                            | Keiko Synthetic Input                                                                                        | Expected Keiko Output                                                                                | Notes                                            |
| --- | ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **intent-derivation-basic**     | TI path: `packages/core-engine/src/baseline-fixtures.ts` / intent-cases | Synthetic user intent string (5–50 chars): `"Add login form validation"`                                     | Parsed intent: `{ domainModel: "form", intent: "validate", scope: "login" }`                         | Pure function; no LLM or customer data needed.   |
| 2   | **test-case-schema-validation** | TI path: `packages/core-engine/src/test-design-schema.ts`               | Synthetic test case JSON: `{ name: "login_field_required", polarity: "positive", ... }`                      | Valid parsed test case OR typed validation error                                                     | Zod schema; synthetic test data only.            |
| 3   | **coverage-relevance-ranking**  | TI path: `packages/quality/src/coverage-planner.ts`                     | Synthetic coverage goals (array): `[{ tier: "critical", area: "auth" }, ...]` + synthetic test cases (array) | Ranked list: `[{ testId: "t1", relevanceScore: 0.92, reason: "covers critical auth" }, ...]`         | Deterministic ranking; no ML needed.             |
| 4   | **judge-logic-basic**           | TI path: `packages/quality/src/judges/logic-judge.ts`                   | Synthetic source code snippet (30–100 lines) + synthetic test case assertion                                 | Judge result: `{ logicallySound: true, gaps: [...] }`                                                | Offline judge; can use `ScriptedModelPort` mock. |
| 5   | **multi-source-reconciliation** | TI path: `packages/multi-source/src/multi-source-fixtures.ts`           | Synthetic source set (2–3 sources with overlapping specs)                                                    | Reconciled output: merged deduplicated specs with confidence scores                                  | Pure merge logic; no LLM or credentials.         |
| 6   | **export-format-markdown**      | TI path: `packages/integrations/src/exporters/markdown.ts`              | Synthetic test case batch (5 cases)                                                                          | Markdown export: valid `.md` file with sections, links, metadata                                     | Format verification only; no external write.     |
| 7   | **audit-dossier-schema**        | TI path: `packages/evidence/src/audit-dossier.ts`                       | Synthetic QI run metadata (run ID, model tokens, tool count, redactions)                                     | Audit dossier: JSON schema matches `keiko-evidence` EvidenceManifest + qualityIntelligence extension | Schema parity; no live runs needed.              |

**Assertion**: #285 must implement at least fixtures 1, 2, 3, 5 (mandatory for coverage). Fixtures 4, 6, 7 are stretch goals depending on scope. All fixtures must be Keiko-owned (synthesized, not copied from TI).

**Owned by**: #285 (parity matrix).

---

## 6. Out of Scope Explicit Reaffirmation

The following are explicitly **NOT** committed to in this issue or the Quality Intelligence migration:

- **No auto-migration of customer credentials**: The standalone's plaintext credential files (`.test-intelligence/local-runtime/workbench-settings.json`) will not be auto-read, auto-copied, or auto-injected into Keiko. Users must re-authorize credentials in Keiko if they switch products.

- **No silent writes into standalone workspaces**: Keiko will not create, modify, or delete files under `.test-intelligence/` without explicit user authorization via a future migration tool (deferred).

- **No deprecation or unpublish action without explicit issue**: The standalone `@oscharko-dev/test-intelligence` package will not be deprecated, removed from npm, or unpublished as a side effect of Keiko's Quality Intelligence launch. A separate explicit product and release governance issue (e.g., #xxx "Deprecate and retire standalone Test Intelligence") is required to retire the product.

- **No one-way forced migration**: Existing standalone Test Intelligence users are not forced to adopt Keiko. Teams may continue using the standalone product in maintenance-only mode indefinitely. Teams adopting Keiko will use native Quality Intelligence instead.

- **No shared runtime processes**: Keiko does not spawn TI's HTTP server, CLI, harness loop, or Workbench as sub-processes. Both products are completely independent processes (if run on the same machine, they operate side-by-side with no IPC).

---

## 7. Cross-References

- **Epic #270**: Integrate Test Intelligence as native Keiko Quality Intelligence.
- **Issue #271 (ADR-0023)**: Quality Intelligence Migration Architecture. Records the hard constraints that forbid TI runtime embedding.
- **Issue #285**: Parity matrix and verification. Implements the parity fixtures and comparison gates.
- **Issue #287**: Package surface and supply-chain integrity gate. Enforces rule `direction-10a` to prevent TI package imports.
- **Issue #286** (this issue): Standalone compatibility decision. Defers explicit retirement decision to a later product governance issue.
- **Document**: `docs/migration/quality-intelligence-test-intelligence-inventory.md`. Catalogs TI capabilities, defects, and reuse targets.
- **Document**: `docs/migration/quality-intelligence-keiko-baseline.md`. Records the 17 Keiko packages available for Quality Intelligence reuse.

---

## 8. Deferred Product Decisions

The following decisions are explicitly deferred to later issues **after** the Keiko Quality Intelligence native implementation (#272–#284) is complete and parity is verified (#285):

- **Standalone retirement timing** (new issue): When (if ever) should the standalone Test Intelligence product be deprecated, unpublished, or retired? Options: (1) Never (indefinite maintenance), (2) After [N] months of Keiko QI availability, (3) When Keiko feature-complete equivalent ships, (4) On customer-driven deprecation schedule. Decision required before any breaking changes to the standalone product.

- **Migration assistance tool scope** (new issue): If a migration tool is built to help users convert `.test-intelligence/` artifacts into Keiko format, what should it do? (1) Convert test-case fixtures only? (2) Convert judge calibration? (3) Convert policies? (4) Convert evidence? Scope is out of #286 and must be a separate product decision.

- **Multi-tenant support** (new issue): Standalone TI has no multi-tenant support. Keiko's multi-tenant story (if any) is deferred beyond the current implementation wave. This decision is independent of standalone compatibility.

---

## 9. Verification Command Summary

After this document lands, the following commands must all exit 0:

```bash
cd /Users/oscharko-dev/Projects/Keiko

# Verify no TI imports at architecture level
npm run arch:check

# Verify no TI path references in source
grep -r '\.test-intelligence' src/ tests/ --include="*.ts" --include="*.tsx" || echo "No matches"

# Verify lint (docs changes should not affect linting)
npm run lint

# Verify typecheck
npm run typecheck

# Verify format (docs file only)
npx prettier --check docs/migration/quality-intelligence-test-intelligence-compatibility.md
```

---

**Document Status**: Accepted as part of Epic #270 Quality Intelligence migration (issue #286).

**Last Updated**: 2026-06-05

**Next Review**: After #285 (parity matrix) is complete.
