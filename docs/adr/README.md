# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for Keiko.

Each ADR documents a single architectural decision: the context, what was decided, why alternatives were
rejected, and the consequences. ADRs are immutable once accepted. If a decision is reversed, a new ADR
supersedes the old one — the old one is not deleted.

## Index

| Number | Title | Status | Date |
|--------|-------|--------|------|
| [ADR-0001](ADR-0001-project-foundation-and-toolchain.md) | Project Foundation and Toolchain | Accepted | 2026-05-28 |
| [ADR-0002](ADR-0002-ci-and-supply-chain-security-baseline.md) | CI and Supply-Chain Security Baseline | Accepted | 2026-05-28 |
| [ADR-0003](ADR-0003-model-gateway-boundary.md) | Model Gateway Boundary, Capability Registry, and Cost/Timeout Controls | Accepted | 2026-05-28 |
| [ADR-0004](ADR-0004-agent-harness-boundary-and-state-machine.md) | Agent Harness Boundary, State Machine, and Hexagonal Ports | Accepted | 2026-05-28 |
| [ADR-0005](ADR-0005-repository-context-and-workspace-access.md) | Repository Context and Workspace Access Layer | Accepted | 2026-05-29 |
| [ADR-0006](ADR-0006-safe-tool-execution-and-sandbox-boundary.md) | Safe Tool Execution and Wave-1 Sandbox Boundary | Accepted | 2026-05-29 |

## Adding a new ADR

1. Copy the template from the architect agent definition.
2. Number sequentially (ADR-NNNN).
3. Use kebab-case filename: `ADR-NNNN-short-title.md`.
4. Add a row to this index.
5. Include at least 3 real alternatives with explicit "why rejected" reasoning.
6. Set status to `Proposed` until reviewed; change to `Accepted` on approval.
