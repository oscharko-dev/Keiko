# Keiko Documentation Router for Coding Agents

This file is the first-read document for agents working in Keiko. It compresses the
large `docs/` tree into the durable decisions, package boundaries, and verification
rules that matter for implementation. Do not recursively load `docs/` by default:
open only the domain documents cited below after you know the change scope.

## How to use these docs

1. Read this file first.
2. Identify the domain you are touching.
3. Open only the primary documents for that domain.
4. Treat `evidence/`, `*-closure*`, `*-verification*`, screenshots, JSON proofs, and
   historical migration notes as audit material. Read them only when a task is about
   verification, regression proof, release evidence, or a disputed design decision.
5. Prefer current code and tests over old planning prose when they conflict.
6. If a change creates a durable architecture rule, update or add an ADR. If it only
   closes an issue, update the relevant domain summary instead of adding another
   standalone closeout document.

Current scale: `docs/` contains more than 500k words of Markdown plus many screenshot
and JSON evidence artifacts. Most of that is source/audit material, not first-pass
agent context.

## Product invariants

- Keiko is a local-first, governed agentic workspace for regulated engineering and
  knowledge-work workflows.
- Default customer path remains one npm product package, one `keiko` CLI, one local
  loopback UI/BFF runtime. Do not introduce cloud control planes, telemetry, service
  meshes, or distributed runtime requirements without a new ADR.
- Users stay in control. Selecting the task, autonomy mode, Authority Envelope, and deployment
  ceiling grants bounded local authority. Actions that the shared policy marks `allowed` do not
  require another prompt; delivery actions and authority widening remain separately
  human-approved. See [ADR-0125](adr/ADR-0125-governed-agent-docking-and-editor-changesets.md).
- The three user-facing modes are **Ask for approval**, **Supervised workspace**, and
  **Full access**. Their machine values, resource/risk matrix, and mode-independent hard denials
  come only from the shared Coding Workbench contract and
  [ADR-0138](adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md);
  do not reconstruct them in a feature-local policy.
- Evidence and audit surfaces are redacted, bounded, and content-minimized. Persist
  ids, hashes, counts, enums, timestamps, branch names, and safe summaries rather
  than raw source text, secrets, unbounded logs, provider payloads, or customer data.
- Productive model calls route through `@oscharko-dev/keiko-model-gateway`.
- Workspace filesystem access routes through `@oscharko-dev/keiko-workspace`.
- File mutation, terminal execution, browser automation, patch application, and git
  process execution route through `@oscharko-dev/keiko-tools` or the domain gateway
  explicitly documented for that operation.
- Browser-tier packages must not value-import Node-domain packages.
- `@oscharko-dev/keiko-contracts` stays a pure dependency leaf: no IO, no clock, no
  crypto, no randomness, no imports from other Keiko packages.
- Runtime requirements are Node.js >=24.18.0 <25 and npm 11.16.0 for repository development. See
  [Runtime toolchain](runtime-toolchain.md) for migration and rollback guidance.
- UI and editor hosts use React 19.2.8. See
  [React 19 UI and editor migration](react19-ui-editor-migration.md) for compatibility, verification,
  and rollback guidance.

## Repository and package map

Primary documents:

- [ADR-0019](adr/ADR-0019-modular-package-architecture.md) - modular package
  architecture and dependency direction.
- [ADR-0025](adr/ADR-0025-forward-only-0-2-0-modular-baseline.md) - current modular
  baseline.
- [PUBLIC_API_SURFACE.md](PUBLIC_API_SURFACE.md) - packaged public surface.
- Root [README.md](../README.md) - install, dev, and operator quickstart.

Current package responsibilities:

| Package                      | Owns                                                                                    | Must not own                                       |
| ---------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `keiko-contracts`            | Shared contracts, validators, branded ids, wire types                                   | IO, provider calls, persistence, UI                |
| `keiko-security`             | Redaction, safe errors, secrets, hashing, trust-boundary helpers                        | Product workflow logic, UI state                   |
| `keiko-model-gateway`        | Provider abstraction, OpenAI-compatible calls, capability routing, TLS/resilience       | UI, workspace file reads, tool execution           |
| `keiko-workspace`            | Repository discovery, path containment, safe reads, context packs, retrieval seams      | Provider calls, UI, patch application              |
| `keiko-tools`                | Controlled execution, patch writing, terminal/browser adapters, git mutation primitives | Model routing, workflow policy, credentials        |
| `keiko-harness`              | Agent runtime loop, cancellation, limits, orchestration seams                           | Direct provider SDK calls, raw FS reads            |
| `keiko-workflows`            | Reviewable developer-assist workflows and reports                                       | Runtime server, UI components, credentials         |
| `keiko-evaluations`          | Deterministic evaluation harness, scored dimensions, offline/live provider selector     | UI, direct provider network egress                 |
| `keiko-evidence`             | Evidence manifests, retention, local artifact indexing                                  | Provider access, UI composition                    |
| `keiko-verification`         | Deterministic verification planning and summaries                                       | UI, model/provider access                          |
| `keiko-quality-intelligence` | Pure Quality Intelligence domain logic                                                  | Server routes, UI, provider calls                  |
| `keiko-local-knowledge`      | Local Knowledge capsule store and extraction lifecycle                                  | Browser UI, direct ungoverned egress               |
| `keiko-connectors`           | Governed Atlassian (Confluence/Jira) connector domain and bounded verification probe    | Direct network or filesystem; UI; composition root |
| `keiko-memory-*`             | MemoriaViva capture, vault, retrieval, governance, consolidation                        | Unscoped memory use, plaintext secret storage      |
| `keiko-editor`               | Browser-tier Monaco editor/diff UI and host port contracts                              | Retrieval, model routing, patching, server routes  |
| `keiko-git`                  | Shared Git core primitives: hardened runner, path containment, porcelain parsers        | Direct model/provider calls; UI                    |
| `keiko-sandbox`              | Reusable OS/container egress-isolation strategy and backend selection                   | Spawning (that stays in `keiko-tools`); UI         |
| `keiko-sdk`                  | Internal SDK surface re-exported by the root product facade                             | Server routes, provider SDKs, UI                   |
| `keiko-server`               | Loopback BFF, routes, CSP/host/CSRF gates, runtime wiring                               | Long-term domain contracts                         |
| `keiko-cli`                  | CLI lifecycle and command surface                                                       | Domain logic that belongs in packages              |
| `keiko-ui`                   | Next.js local UI, browser components, static export                                     | Filesystem IO, provider tokens, direct model calls |
| root `@oscharko-dev/keiko`   | Public product facade and bundled artifact                                              | New domain implementation                          |

Per-package `README.md` files are not the repository convention. Scope, boundaries, and
ownership for every workspace package are centralized in the table above; a package does not
need its own `README.md` to be documented — see [adr/README.md](adr/README.md) for the full
decision catalog. `keiko-editor/README.md` and `keiko-workspace/README.md` are exceptions, not
a pattern to replicate in new or existing packages: the former is the editor package's
embedding/API document, link-checked by `npm run check:editor-doc-links` and deep-linked from
`docs/keiko-editor/runbook.md`; the latter is referenced by ADR-0165 as the consumer-facing
statement of the two read lanes. Neither should be deleted or treated as inert.

## Architecture decision clusters

Use [adr/README.md](adr/README.md) only when you need the full decision catalog. For
implementation, start with these clusters:

- Package and release baseline: ADR-0019, ADR-0020, ADR-0021, ADR-0025, ADR-0112,
  ADR-0115, ADR-0130.
- Workspace shell and task workspaces: ADR-0026 through ADR-0030, ADR-0088 through
  ADR-0093, ADR-0097. Workspace Trust and multi-root binding: ADR-0147, ADR-0155,
  ADR-0160.
- Multi-window and duplication: ADR-0123.
- Relationship engine: ADR-0031 through ADR-0033.
- Context, grounding, compaction, retrieval substrate: ADR-0034, ADR-0036, ADR-0052
  through ADR-0057, ADR-0144, ADR-0152, ADR-0153, ADR-0164, ADR-0172.
- Chat sessions: ADR-0114.
- Security, egress, credentials, evidence confidentiality: ADR-0035, ADR-0038,
  ADR-0043, ADR-0046 through ADR-0048, ADR-0070, ADR-0113.
- Design system: ADR-0039 through ADR-0041, ADR-0049 through ADR-0051.
- Editor and verification surface: ADR-0042, ADR-0045, ADR-0058 through ADR-0069
  editor-specific records, ADR-0097, ADR-0119, ADR-0126, ADR-0127, ADR-0132,
  ADR-0133, ADR-0136, ADR-0165.
- Prompt Enhancer: ADR-0044.
- Git delivery and Git client: ADR-0080 through ADR-0087, ADR-0098.
- Voice and dialogue mode: voice-specific ADR-0100 through ADR-0111, ADR-0094
  through ADR-0096. Realtime voice live memory recall and Twin Voice: ADR-0116,
  ADR-0154.
- Memory (MemoriaViva): ADR-0117, ADR-0120, ADR-0146.
- Portable install, native dialogs, and update authority: ADR-0118, ADR-0121,
  ADR-0122.
- Atlassian connector: ADR-0128.
- Product-wide authority, gateway readiness, and coding autonomy: ADR-0129,
  ADR-0138, ADR-0171.
- Coding Workbench autonomy, sidecar runtime, and packaged qualification: ADR-0124,
  ADR-0125, ADR-0137, ADR-0140, ADR-0141, ADR-0163.
- Deterministic `dev` delivery, quality gates, and reviewer settlement: ADR-0135,
  ADR-0139, ADR-0145, ADR-0156, ADR-0157, ADR-0158, ADR-0159, ADR-0161, ADR-0162,
  ADR-0170.
- SonarCloud analysis and quality-signal governance: ADR-0131, ADR-0134, ADR-0142,
  ADR-0143, ADR-0166, ADR-0167, ADR-0168, ADR-0169.

ADR statuses matter. Proposed ADRs are design intent; Accepted ADRs are constraints
unless superseded by later code or ADRs.

## Domain quick routes

### Local UI and design system

Primary docs:

- [design-system/README.md](design-system/README.md)
- [design-system/governance.md](design-system/governance.md)
- [design-system/state-matrix.md](design-system/state-matrix.md)
- [design-system/visual-regression.md](design-system/visual-regression.md)
- [ui-runbook.md](ui-runbook.md)

Rules:

- The UI is a single-route governed desktop (`KeikoDesktop -> AppShell`) with tool
  windows on a workspace canvas.
- `packages/keiko-ui/src/app/globals.css` is the single live token/style source.
  Do not introduce Tailwind, CSS Modules, styled-components, a second theme engine,
  or a duplicate token namespace.
- Design-system reference files remain visual-regression ground truth; they are not
  a second shipped stylesheet.
- Use semantic/component tokens rather than one-off light-mode overrides.
- Preserve dark, light, high-contrast, forced-colors, reduced-motion, desktop,
  tablet, and mobile expectations when touching shared UI surfaces.

### Keiko Editor

Primary docs:

- [keiko-editor/runbook.md](keiko-editor/runbook.md)
- [editor-language-service.md](editor-language-service.md)
- [editor-inline-completion.md](editor-inline-completion.md)
- [editor-agent-contracts.md](editor-agent-contracts.md)
- [editor-agent-governance.md](editor-agent-governance.md)
- [editor-vscode-ux.md](editor-vscode-ux.md)

Rules:

- `keiko-editor` is browser-tier UI and provider wiring only.
- Server-side editor routes own deterministic language service, completion,
  retrieval/context assembly, test generation gates, and model access.
- Browser editor code must not compute diagnostics/completions from Node packages
  or call models/filesystem directly.
- Monaco is loaded without CDN. CSP and browser-tier dependency rules are part of
  the acceptance surface.
- Patches stay reviewable and governed; direct uncontrolled apply is not allowed.

### Governed Git Delivery and Git client

Primary docs:

- [git-delivery/README.md](git-delivery/README.md)
- [git-delivery/governed-git-contracts.md](git-delivery/governed-git-contracts.md)
- [git-delivery/governed-git-execution-kernel.md](git-delivery/governed-git-execution-kernel.md)
- [git-delivery/operator-runbook.md](git-delivery/operator-runbook.md)
- [git-delivery/git-client-repository-api.md](git-delivery/git-client-repository-api.md)

Rules:

- Governed mutation actions are closed and policy-mediated. Do not widen
  `GitDeliveryActionKind` casually.
- Commit, push, PR, and merge flows use the governed gateway, approval/preview
  surfaces, hardened execution, and evidence ledger.
- Git client history/remotes/summary reads are sibling BFF reads.
- Fetch and fast-forward-only pull intentionally use the non-governing sync executor
  with sibling evidence, not the governed mutation kernel.
- All git evidence remains content-free/redacted and bounded.

### Workspace and task workspaces

Primary docs:

- [workspace/518-product-boundaries.md](workspace/518-product-boundaries.md)
- [workspace/518-architecture-blueprint.md](workspace/518-architecture-blueprint.md)
- [workspace/443-operator-runbook.md](workspace/443-operator-runbook.md)
- [keiko-editor/2523-workspace-trust-security-review.md](keiko-editor/2523-workspace-trust-security-review.md) — Workspace Trust security review.
- ADR-0088 through ADR-0093, ADR-0147, ADR-0155, ADR-0160.

Rules:

- Workspace surfaces are governed UI/workflow surfaces, not OS sandboxes.
- Task workspaces are isolated, lifecycle-tracked worktrees with explicit health,
  drift, lock, recovery, binding, and audit contracts.
- Content-free auditability is mandatory for task-workspace state and events.
- Path containment belongs to `keiko-workspace`; do not reimplement it in leaf
  contracts or UI code.

### Relationship engine

Primary docs:

- [relationship-engine/architecture.md](relationship-engine/architecture.md)
- [relationship-engine/api-contract.md](relationship-engine/api-contract.md)
- [relationship-engine/audit.md](relationship-engine/audit.md)
- [relationship-engine/lifecycle.md](relationship-engine/lifecycle.md)
- [relationship-engine/storage.md](relationship-engine/storage.md)
- [relationship-engine/retention-and-privacy.md](relationship-engine/retention-and-privacy.md)
- ADR-0031 through ADR-0033.

Rules:

- Relationship storage/audit/UI decisions live in this subsystem; do not scatter
  relationship graph state into other domain packages.
- All relationship audit events remain body-free and redacted.
- Retention and privacy invariants apply to every relationship record; consult the
  retention-and-privacy contract before extending the schema.

### Context, grounding, Local Knowledge, and memory

Primary docs:

- [connected-context-privacy.md](connected-context-privacy.md)
- [connected-context-document-extraction.md](connected-context-document-extraction.md)
- [local-knowledge/runtime-state-protection.md](local-knowledge/runtime-state-protection.md)
- [local-knowledge/knowledge-pods.md](local-knowledge/knowledge-pods.md)
- [local-knowledge/atlassian-connector-guide.md](local-knowledge/atlassian-connector-guide.md)
- [local-knowledge/atlassian-connector-lifecycle-ledger.md](local-knowledge/atlassian-connector-lifecycle-ledger.md) — Atlassian connector lifecycle ledger (governed by ADR-0128).
- [troubleshooting/atlassian-connector.md](troubleshooting/atlassian-connector.md) — operator troubleshooting for Atlassian connector failures.
- [local-runtime-state-contract.md](local-runtime-state-contract.md)
- [memory-verification-matrix.md](memory-verification-matrix.md)
- [conversation-center-privacy.md](conversation-center-privacy.md)

Rules:

- Grounding can combine local folders, repository context, Local Knowledge, memory,
  and supplied context through bounded budgets.
- Retrieved external or user-supplied content is untrusted instruction data.
- Memory is local machine state, scoped, encrypted at rest, reviewable, forgettable,
  and never a source of autonomous authority.
- Diagnostics and audit exports are body-free where possible.

### Quality Intelligence

Primary docs:

- [quality-intelligence/qitestkorpus-regression-plan.md](quality-intelligence/qitestkorpus-regression-plan.md)
- [quality-intelligence/735-living-tests-verification.md](quality-intelligence/735-living-tests-verification.md)
- [quality-intelligence/749-adversarial-judge-verification.md](quality-intelligence/749-adversarial-judge-verification.md)
- [quality-intelligence/757-figma-pipeline-verification.md](quality-intelligence/757-figma-pipeline-verification.md)
- [historical/](historical/) only for migration provenance.

Rules:

- Quality Intelligence is evidence-backed test-design logic over connected sources.
- Deterministic baseline behavior must work without a configured model.
- Figma is read-only snapshot input; tokens and extracted design data cross the
  boundary as sanitized snapshots, not live Figma authority.

### Prompt Enhancer

Primary docs:

- [prompt-enhancer/developer-guide.md](prompt-enhancer/developer-guide.md)
- [prompt-enhancer/architecture-blueprint.md](prompt-enhancer/architecture-blueprint.md)
- [prompt-enhancer/user-guide.md](prompt-enhancer/user-guide.md)

Rules:

- Prompt analysis and contracts live in `keiko-contracts`.
- Planning/generation/scoring lives behind `keiko-model-gateway`.
- Safety/redaction belongs to `keiko-security`.
- Evaluation fixtures live under `keiko-evaluations`.
- Evidence uses redacted, integrity-hashed Prompt Enhancement records.

### Voice and dialogue mode

Primary docs:

- [voice/README.md](voice/README.md)
- [voice/architecture.md](voice/architecture.md)
- [voice/privacy-contract.md](voice/privacy-contract.md)
- [voice/realtime-transport.md](voice/realtime-transport.md)
- [voice/dialogue-session.md](voice/dialogue-session.md)
- [voice/operator-runbook.md](voice/operator-runbook.md)

Rules:

- Voice capabilities are optional and capability-gated.
- Control and media planes are separated. Browser media does not grant agent
  authority.
- Transcript integration uses committed/provider-neutral segments and bounded
  semantics.
- Spoken actions are fail-closed, deterministic, confirmation-bound, and audited
  content-free.
- Session recap/memory capture is user-triggered and goes through existing memory
  governance.

### Security, runtime, and troubleshooting

Primary docs:

- [security-and-audit-boundaries.md](security-and-audit-boundaries.md)
- [command-runner/security-notes.md](command-runner/security-notes.md)
- [container-runtime/security-notes.md](container-runtime/security-notes.md)
- [troubleshooting/README.md](troubleshooting/README.md)
- [pwa-installability-contract.md](pwa-installability-contract.md)
- [pwa-verification-runbook.md](pwa-verification-runbook.md)

Rules:

- Keiko is not an OS sandbox. Treat command execution, filesystem access, browser
  automation, connectors, and network egress as governed local effects.
- The command runner uses fixed argv, no-shell execution, env isolation, timeout and
  byte caps, and redaction.
- Container execution is a governed pilot surface. Availability or isolation must be
  detected and attested rather than assumed.
- Troubleshooting examples must never include API keys, customer data, private logs,
  internal endpoints, or raw evidence payloads.

### Coding Workbench

Primary docs:

- [coding-runtime/dev-lane.md](coding-runtime/dev-lane.md)
- [coding-runtime/milestone-1-real-binary-validation.md](coding-runtime/milestone-1-real-binary-validation.md)
- [coding-runtime/research-content-threat-model.md](coding-runtime/research-content-threat-model.md)
- [coding-workbench-codex-subscription-profiles.md](coding-workbench-codex-subscription-profiles.md)
- [qa/coding-workbench-operator-runbook.md](qa/coding-workbench-operator-runbook.md)
- [qa/coding-workbench-autonomy-qa-matrix.md](qa/coding-workbench-autonomy-qa-matrix.md)

Rules:

- The three product modes and their fail-closed effective-mode ceiling come from the shared
  Coding Workbench contract and ADR-0124, ADR-0125, and ADR-0138; do not reconstruct them locally.
- The macOS development lane is explicitly opted in and confined to repositories that carry the
  checkout marker. It never substitutes for packaged qualification (ADR-0140).
- Packaged installs are release-qualified only for the fixed `windows-x64`, `macos-arm64`, and
  `macos-x64` ZIP targets; unsupported targets fail closed (ADR-0163).

### Historical records, planning baselines, and delivery evidence

These directories were previously reachable only through individual ADRs or not indexed at all
(housekeeping 2026-08-10). The first two are frozen records — for them the ADRs and gates stay
authoritative; the context-engineering decision log is a living coordinator record by its own
contract; the remaining entries are living surfaces that simply lacked an index entry.

- [historical/](historical/) - frozen Epic #270 Test-Intelligence → Quality-Intelligence
  snapshots (baseline, parity matrix with post-closure delivery notes, compat contract,
  inventory).
- [planning/](planning/) - historical editor architecture and multi-language planning baselines
  (superseded by the editor ADR cluster).
- [context-engineering/decision-log.md](context-engineering/decision-log.md) - coordinator
  decision log for the context-engineering milestone (ADR-0052..0057 context).
- [acceptance/](acceptance/) - code-task acceptance contribution contract and the
  `code-task-2387.json` acceptance descriptor (generator:
  `scripts/generate-code-task-acceptance.mjs`; the downstream consumer is not yet scheduled).
- [pilot/](pilot/) - pilot go/no-go evaluation and pilot runbook (content pinned by
  `tests/pilot/`).
- [relationship-engine/](relationship-engine/) - relationship storage/audit/UI specifications and
  closure evidence (ADR-0031..0033).
- [release/](release/) - live release engineering: readiness audits, portable launch and signing
  operator contracts, dependency decision matrices, and release closeouts (wired into the
  release workflows and required gates).

## Verification commands

Use the narrowest relevant gate first, then broader gates when risk justifies it.

```bash
npm run build
npm test
npm run lint
npm run typecheck
npm run arch:check
npm run arch:check:negative
```

Package-local commands generally follow:

```bash
npm --workspace @oscharko-dev/<package> run build
npm --workspace @oscharko-dev/<package> run test
npm --workspace @oscharko-dev/<package> run typecheck
```

Check `package.json` before assuming a script exists. For browser/UI work, include
the relevant Vitest, Playwright, accessibility, and visual-regression gates documented
by the domain docs.

## Documentation maintenance protocol

All repository documentation is written in professional English.

When adding or updating docs, optimize for future coding agents:

- Add an agent digest at the top: status, owner package/surface, decision, invariant,
  code paths, verification command, and source ADRs.
- Keep durable domain docs short. Target less than 150 lines unless the document is an
  ADR, API contract, operator runbook, or formal verification matrix.
- Append new facts to the existing domain document before creating a new issue-specific
  Markdown file.
- Put raw closure notes, screenshots, generated JSON, browser captures, and large
  proof bundles under a clearly named `evidence/` directory.
- Do not create session logs, exploratory transcripts, or "I searched X" notes.
- Do not duplicate architecture rules across many files. Link to the owning ADR or
  this router instead.
- If a document becomes historical, add that status at the top and point to the
  current replacement.
- When a new durable domain appears, add it to this router in the same change.

This protocol is intentionally stricter than human-facing documentation style. The
goal is to keep context windows small and preserve the constraints agents actually
need while leaving deep audit material available on demand.
