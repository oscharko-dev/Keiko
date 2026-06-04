# ADR-0019: Modular Package Architecture

Status: Accepted

Date: 2026-06-03

Version: 1.0

## Decision

Keiko will move from a single TypeScript source package with folder-level boundaries to a modular monorepo package architecture.

This is a package and governance architecture, not a distributed runtime microservice architecture. Keiko must remain simple for enterprise users to install and operate:

- one public npm product package: `@oscharko-dev/keiko`;
- one local CLI entrypoint: `keiko`;
- one local UI/BFF runtime process unless a later ADR explicitly changes the runtime model;
- no Kubernetes, service mesh, background cloud service, or multi-process runtime requirement for the default product path.

Internally, Keiko will be split into workspace packages with explicit dependency direction, package-local tests, package-local type checking, and enforceable architecture rules. The published root package may bundle internal workspace packages so customers still install one product artifact.

## Context

Keiko is becoming a long-lived enterprise product for regulated banking and insurance engineering workflows. The current codebase already has meaningful architectural modules under `src/`, including gateway, harness, workspace, tools, UI, workflows, audit, verification, and evaluations. Those modules are valuable, but their boundaries are currently enforced mostly by convention.

That is no longer strong enough for the planned product direction:

- Conversation Center work will add richer model selection, multimodal guardrails, attachment handling, context budgeting, markdown rendering, workflow handoff, and privacy controls.
- Model gateway work must stay isolated from UI, workflows, direct provider access, and customer credentials.
- Workspace and tool boundaries must remain auditable and fail-closed.
- Evidence must remain tamper-resistant and must not become a dumping ground for UI or workflow implementation details.
- Agent-coded development benefits from smaller, independently reviewable modules with clear write ownership.
- Enterprise governance benefits from a visible dependency graph, deterministic verification, package surface checks, and dependency-cruiser rules.

The architecture must scale without making the customer's installation flow more complex.

## Architecture Thesis

Keiko should be modular like a well-designed service system, but deployed like a local product.

The package boundaries represent trust boundaries and development ownership boundaries. They do not imply separate runtime services. This gives the team most of the benefits of microservice-style separation without the operational cost and fragility of distributed services.

## Target Package Topology

The first architecture sprint should converge on the following package map. Names may be refined during implementation, but any material change must amend this ADR or create a follow-up ADR.

| Package | Responsibility | Must Not Own |
| --- | --- | --- |
| `@oscharko-dev/keiko-contracts` | Shared public contracts, branded IDs, event envelopes, model capability schema, BFF wire types, workflow descriptors. | Runtime IO, provider calls, UI components, persistence. |
| `@oscharko-dev/keiko-security` | Redaction, secret handling, safe error shaping, content hashing, trust-boundary helpers. | Product workflows, provider routing, UI state. |
| `@oscharko-dev/keiko-model-gateway` | Provider abstraction, OpenAI-compatible calls, discovery, capability probing, routing, resilience, TLS handling. | UI components, workspace file reads, tool execution, direct persistence of customer UI state. |
| `@oscharko-dev/keiko-workspace` | Workspace discovery, path containment, safe file reads, context packs, retrieval seams. | Provider calls, browser UI, patch application. |
| `@oscharko-dev/keiko-tools` | Controlled tool execution, terminal/browser adapters, patch parsing, patch writing boundaries. | Model selection, workflow policy decisions, credential storage. |
| `@oscharko-dev/keiko-harness` | Agent runtime loop, task execution state machine, cancellation, event emission, limits, workflow orchestration seams. | Direct provider SDK calls, raw filesystem reads outside workspace ports, UI rendering. |
| `@oscharko-dev/keiko-workflows` | Reviewable developer-assist workflows such as explain plan, unit-test generation, bug investigation, and verification integration. | Runtime server, UI components, direct credentials. |
| `@oscharko-dev/keiko-evidence` | Evidence manifests, audit reports, retention, tamper-resistant local artifacts, evidence indexing. | Provider access, UI composition, workflow business logic. |
| `@oscharko-dev/keiko-server` | Local loopback BFF, route dispatch, static UI serving, CSRF/CSP/host checks, runtime dependency wiring. | Product workflow internals, provider SDK calls outside gateway, long-term domain contracts. |
| `@oscharko-dev/keiko-cli` | CLI commands, `keiko init`, `keiko start`, `keiko stop`, local lifecycle, release-facing entrypoints. | Domain logic that belongs in gateway, workspace, harness, workflows, or evidence. |
| `@oscharko-dev/keiko-ui` | Next.js-based local UI application and browser-facing components. | Provider endpoints, API tokens, direct filesystem IO, direct model calls. |
| `@oscharko-dev/keiko` | Public product package and installable meta-artifact. | New domain logic except product-surface composition and export wiring. |

## Required Dependency Direction

The package graph must be a directed acyclic graph. The intended direction is:

1. `contracts` is the leaf package. It must not import from other Keiko packages.
2. `security` may depend on `contracts`.
3. `model-gateway`, `workspace`, `tools`, and `evidence` may depend on `contracts` and `security` where needed.
4. `harness` may depend on `contracts`, `security`, `model-gateway`, `workspace`, `tools`, and `evidence` only through public package surfaces.
5. `workflows` may depend on `contracts`, `security`, `model-gateway`, `workspace`, `tools`, `harness`, and `evidence` only through public package surfaces.
6. `server` wires runtime dependencies and may depend on domain packages, but domain packages must not depend on `server`.
7. `cli` may depend on `server` and domain packages for launch and command surfaces, but domain packages must not depend on `cli`.
8. `ui` consumes browser-safe wire contracts and same-origin BFF APIs; it must not import Node-only domain packages directly unless the import is type-only and explicitly allowed by the architecture gate.
9. The root product package may compose and bundle internal packages, but should not become a second implementation layer.

Any dependency against this direction is an architecture violation unless a later ADR explicitly permits it.

## Trust-Boundary Rules

The architecture sprint must add automated rules for these invariants:

- Direct LLM provider SDK imports are allowed only inside `keiko-model-gateway`.
- Browser-visible packages must not import credential-bearing provider config.
- UI and server errors must pass through safe error/redaction paths.
- Workspace file access must go through `keiko-workspace`.
- File mutation and patch application must go through `keiko-tools`.
- Evidence-producing modules must not be imported as mutable internals from unrelated packages.
- CLI and server may wire dependencies; they must not bypass package ports.
- Package-local tests may use narrowly documented exceptions for integration coverage, but production source must follow the dependency graph.

The rules should be enforced by TypeScript project references, package `exports`, dependency-cruiser, lint configuration, and package-surface verification.

## Build And Packaging Model

Keiko should use a workspace manager for internal development. The architecture sprint should evaluate npm workspaces versus pnpm workspaces and choose the option that best supports reproducible installs, workspace package references, release checks, and enterprise supply-chain governance.

Regardless of workspace manager, the published customer path remains:

```text
npm install @oscharko-dev/keiko
npx keiko init
npm run keiko:start
```

The root package must keep the public install flow stable while internal package boundaries become stricter.

The published package may bundle internal workspace packages into `dist` to avoid publishing many customer-facing packages prematurely. Publishing separate internal packages is a later decision, not part of this ADR.

## Migration Strategy

The migration should be phased. Avoid a single high-risk rewrite.

1. Establish workspace tooling, package build conventions, and dependency graph rules.
2. Extract leaf packages first: `contracts` and `security`.
3. Extract infrastructure packages: `model-gateway`, `workspace`, `tools`, and `evidence`.
4. Extract orchestration packages: `harness` and `workflows`.
5. Extract runtime composition packages: `server`, `cli`, and `ui`.
6. Update the root `@oscharko-dev/keiko` package to be a clean product facade and installable artifact.
7. Run a final release-gate verification from the packed npm artifact before resuming feature development.

Each step must preserve behavior, public CLI commands, first-run gateway setup, local UI startup on the configured default port, and the existing security posture.

## Issue And Agent Guidance

Architecture-sprint issues must reference this ADR and must state which package owns the changed code. Parallel agents may work only when their package ownership does not overlap.

Implementation PRs must not mix unrelated package extractions. A PR should either:

- create or harden workspace infrastructure;
- extract one package boundary;
- update tests/build/release gates for already extracted packages;
- or perform final product packaging verification.

Feature work that adds Conversation Center, PWA, plugin, search, or workflow behavior should wait until the architecture sprint has either finished or explicitly carved out a safe exception.

## Consequences

Positive consequences:

- Stronger architecture boundaries for regulated enterprise delivery.
- Better agent-coding parallelism through clear package ownership.
- Smaller and more focused PRs.
- Easier package-local tests and faster targeted verification.
- Clearer supply-chain, SBOM, and package-surface governance.
- Lower risk that UI, server, workflows, tools, and gateway logic bypass each other.

Costs and risks:

- Initial migration cost is meaningful and should happen before major feature expansion.
- Build scripts, CI, lint, package-surface checks, and release tooling become more complex.
- Poorly chosen package boundaries could create churn; therefore boundaries should be extracted in phases and reviewed after each phase.
- Internal workspace package dependencies can hide publish-time failures if package-surface checks are weak; release gates must test the packed artifact.

## Non-Goals

This ADR does not:

- convert Keiko into distributed runtime microservices;
- require customers to install multiple Keiko packages;
- introduce cloud services, telemetry, or remote control planes;
- publish all internal packages independently;
- change model provider credentials or customer gateway setup semantics;
- implement Conversation Center features directly.

## Revision Policy

This ADR is the anchor for the architecture sprint. If a package boundary, dependency rule, or packaging model changes materially, update the version section below and record the reason in this document.

## Version History

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 2026-06-03 | Accepted modular package architecture as Keiko's next foundation before major feature expansion. |
