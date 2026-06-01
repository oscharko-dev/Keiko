# Architecture Decisions

This file is the compact decision log for Keiko 0.1.0-beta.0. It replaces the earlier long-form ADR set with a release-focused index: enough rationale to review the architecture, without carrying issue-by-issue design history in the repository docs.

## Invariants

- Keiko is a local-first, TypeScript/npm-delivered coding agent with CLI, SDK, and local UI surfaces.
- Workflows are bounded and reviewable. Dry-run is the default; applying a patch is explicit and followed by verification.
- Keiko never commits, pushes, opens pull requests, or merges.
- Credentials come from environment variables or config files, never flags, and are redacted before logs, events, or evidence.
- Runtime dependencies stay minimal. The root package currently uses `ws` for the browser CDP transport; UI framework dependencies remain build-time-only in `ui/`.
- Evidence is redacted at construction, versioned, written atomically inside a contained evidence root, and rotated by retention policy.

## Decision Index

| ID | Decision | Status |
| --- | --- | --- |
| <a id="adr-0001"></a>ADR-0001 | Use an ESM-only TypeScript package with strict TypeScript, Vitest, ESLint, Prettier, npm locks, and an explicit package surface. | Accepted |
| <a id="adr-0002"></a>ADR-0002 | Require CI, dependency review, CodeQL, pinned GitHub Actions, SBOM generation, audit checks, and package-surface verification before release. | Accepted |
| <a id="adr-0003"></a>ADR-0003 | Isolate model access behind a gateway with a static capability registry, config/env secret resolution, HTTPS-by-default provider URLs, redaction, timeouts, retry limits, and circuit-breaking. | Accepted |
| <a id="adr-0004"></a>ADR-0004 | Run agent work through a deterministic harness state machine with injected model/tool ports, event sinks, run IDs, cancellation, and dry-run behavior. | Accepted |
| <a id="adr-0005"></a>ADR-0005 | Build workspace context through bounded discovery, deny lists, `.gitignore` handling, byte budgets, and lexical plus realpath containment. | Accepted |
| <a id="adr-0006"></a>ADR-0006 | Execute tools through a deny-by-default command boundary: no shell, trusted executable resolution, ephemeral HOME, environment allowlist, output caps, timeouts, and workspace-contained cwd. | Accepted |
| <a id="adr-0007"></a>ADR-0007 | Run verification as an orchestrated plan of project gates with per-command limits, targeted-test detection, abort handling, and a redacted summary. | Accepted |
| <a id="adr-0008"></a>ADR-0008 | Implement unit-test generation as a bounded workflow that proposes test-only patches, rejects production-code edits, and verifies after apply. | Accepted |
| <a id="adr-0009"></a>ADR-0009 | Implement bug investigation as a bounded workflow that separates verified findings from model hypothesis, permits scoped source fixes, rejects sensitive paths, and verifies after apply. | Accepted |
| <a id="adr-0010"></a>ADR-0010 | Persist redacted evidence manifests with schema versioning, atomic contained writes, retention, and read APIs for CLI/UI review. | Accepted |
| <a id="adr-0011"></a>ADR-0011 | Ship a static-export local UI served by a hand-written Node BFF, with loopback bind, strict CSP, DNS-rebinding defense, and package-surface checks. | Accepted |
| <a id="adr-0012"></a>ADR-0012 | Provide an offline deterministic evaluation harness and optional live evaluation scorecard for pilot Go/No-Go review. | Accepted |
| <a id="adr-0013"></a>ADR-0013 | Store UI-local project/chat state in Node's built-in `node:sqlite`, outside target repositories, with forward-only migrations and no provider secrets. | Accepted |
| <a id="adr-0014"></a>ADR-0014 | Use a workspace-shell UI model: project list, chat composer, workflow launch, tool panels, evidence/config surfaces, and responsive local operation. | Accepted |
| <a id="adr-0015"></a>ADR-0015 | Treat chat as a thin view over runs and evidence, not as a separate agent execution system. | Accepted |
| <a id="adr-0016"></a>ADR-0016 | Expose files through project-bound BFF routes that preserve workspace deny-list, ignore, containment, size, and redaction semantics. | Accepted |
| <a id="adr-0017"></a>ADR-0017 | Provide the browser tool through user-provided Chrome over CDP with a narrow command permit list and `ws` transport. | Accepted |
| <a id="adr-0018"></a>ADR-0018 | Provide the UI terminal as bounded permitted-command execution over HTTP, not as a general PTY shell. | Accepted |

## Superseded Detail

The previous per-ADR markdown files were useful during build-out, but they duplicated implementation detail now covered by code, tests, and the focused operational docs. For release review, use this index plus:

- [README](../../README.md) for package usage and the public surface.
- [Security and audit boundaries](../security-and-audit-boundaries.md) for enforced controls and known limits.
- [Pilot runbook](../pilot/runbook.md) and [Go/No-Go criteria](../pilot/go-no-go.md) for release/pilot evidence.
