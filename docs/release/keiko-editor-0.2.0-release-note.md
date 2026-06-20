# Keiko Editor — release note (draft)

Date: 2026-06-20
Epic: [#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Documentation issue:
[#1208](https://github.com/oscharko-dev/Keiko/issues/1208) · Architecture:
[ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md)

Status: **Draft for maintainer review.** This note documents the Keiko Editor as delivered on the
`feat/keiko-editor` integration branch and describes implemented behaviour only; capabilities deferred
to a later wave are listed explicitly and are not framed as shipped. The final release-line label and
publication wording are set when the editor epic merges to a release branch.

## Summary

Keiko now embeds a VS Code-grade, Monaco-based code editor inside the Workspace card, replacing the
plain text area. The editor is deterministic-first and fully governed: deterministic TypeScript/
JavaScript language intelligence runs locally on the server with no model call, while AI-assisted
completion routes only through the Model Gateway and never from the browser. A reviewable diff surface
renders Keiko-generated changes without mutating files. The editor is delivered as a reusable,
browser-tier workspace package (`@oscharko-dev/keiko-editor`) that a host can embed without `keiko-ui`.

## What's new

- **Embedded code editor** in the Workspace card: open a workspace file in a Monaco editor with the
  Keiko theme, save with optimistic-concurrency protection, and a unified status bar.
- **Deterministic language intelligence** for TypeScript/JavaScript — diagnostics, hover/quick info,
  document symbols/outline, and explicit "Format Document" — computed model-free on the server.
- **Governed completion**: an always-available deterministic completion tier, plus AI-assisted
  completion and inline ghost text when a capable, in-budget model is configured.
- **Reviewable diffs**: a read-only side-by-side diff editor with changed-file and hunk navigation and
  a content-free change summary, for inspecting generated patches.
- **VS Code-feeling UX**: command palette (F1), keyboard shortcuts, status bar, and accessibility
  (WCAG-conscious live regions and keyboard navigation).

## Capabilities

| Capability                                               | State                          |
| -------------------------------------------------------- | ------------------------------ |
| Monaco editor + diff editor in the Workspace card        | shipped                        |
| Deterministic TS/JS diagnostics, hover, symbols, format  | shipped                        |
| Two-tier completion (deterministic + governed model)     | shipped                        |
| Inline completion / AI ghost text (model-only, gated)    | shipped                        |
| Governed coding-context retrieval for completion prompts | shipped                        |
| No-CDN, same-origin Monaco runtime and workers           | shipped                        |
| Large-file degraded mode and oversize rejection          | shipped                        |
| Per-root request-rate and token-budget cost ceilings     | shipped                        |
| Deterministic intelligence for non-TS/JS languages       | deferred (#1213)               |
| Editor-driven test generation / execution                | gated off (#1202, ADR-0042 D7) |

## Boundaries and guarantees

- **The browser computes nothing and calls no model.** The editor registers Monaco providers that
  bridge to host-injected resolvers; the host calls a `keiko-server` BFF route. Every model call routes
  through the Model Gateway, server-side only.
- **The server language service is the single source of truth** for deterministic intelligence; the
  in-browser Monaco TypeScript worker is disabled for governed features.
- **Content-free provenance and audit.** The browser receives opened buffers and sends live editor text
  plus request context to same-origin BFF routes. Prompts, retrieved excerpts, workspace roots, secrets,
  telemetry, and persisted evidence do not expose those raw payloads back to the browser or evidence
  artifacts; responses expose only reviewable insert text plus provenance labels, hashes, and counts.
- **No CDN and no direct browser provider egress.** Monaco core and workers are served same-origin; the
  server Content-Security-Policy is not widened for the editor.
- **Aligned models only** for AI completion (no raw base-model fill-in-the-middle), with server-owned
  request-rate and token-budget ceilings (denial-of-wallet control).
- **Reusable outside `keiko-ui`** — the package owns editor UI only and reaches all backend capability
  through host-injected ports.

## Not in this release

- **Editor-driven test generation and execution** (#1202) ship switched off behind two default-off
  gates. Executing model-generated tests is untrusted-code execution, and Keiko does not yet OS-enforce
  network egress, so it is deferred until an enforced, deny-by-default egress boundary exists and is
  proven by an automated test (ADR-0042 D7). No release flow executes model-generated code.
- **Governed language intelligence for languages other than TypeScript/JavaScript** (#1213). Other
  languages get Monaco editing only; completion, inline completion, diagnostics, hover, symbols, and
  formatting require a registered provider.

## Operational notes and limitations

- AI ghost text requires a fast, aligned, suffix-aware (FIM) model. Without one, the editor uses
  deterministic and manual-invoke completion only — there is no silent ungoverned fallback. Inline
  completion is on by default and can be disabled per deployment with `KEIKO_EDITOR_INLINE_COMPLETION`.
- Files larger than 500 KB or 10,000 lines open in read-only/degraded mode; files larger than
  1,000,000 bytes are rejected and never instantiate Monaco.
- Browser-measured performance evidence (first-card-open latency, per-keystroke INP, memory under
  multi-card load, and production bundle sizes) is recorded as release evidence by
  [#1209](https://github.com/oscharko-dev/Keiko/issues/1209).

## Verification

The editor's boundaries are verified by deterministic, offline gates split between required `ci` and the
protected-branch release/smoke checks.

Required `ci` covers:

```bash
npm --workspace @oscharko-dev/keiko-editor run build
npm --workspace @oscharko-dev/keiko-editor run typecheck
npm --workspace @oscharko-dev/keiko-editor test
npm run arch:check && npm run arch:check:negative
npm run check:qi-supply-chain
npm run check:editor-bundle-size -- --require-static-export
npm run check:package-surface
KEIKO_SMOKE_PACK_IGNORE_SCRIPTS=1 npm run smoke:install
npm run test:coverage:quality
```

Protected-branch release/smoke gates keep the security and supply-chain bar at least as strict by also
running the high-severity dependency audit, SBOM generation, workspace supply-chain check, static-export
dist scan, and release smoke commands before publishing release evidence.

## Documentation

- [`@oscharko-dev/keiko-editor` README](../../packages/keiko-editor/README.md) — package API and
  standalone embedding recipe.
- [Keiko Editor architecture and operations runbook](../keiko-editor/runbook.md) — architecture, host
  integration, completion architecture, security/privacy.
- [Keiko Editor troubleshooting](../keiko-editor/troubleshooting.md) — Monaco workers, CSP, unsupported
  files, completion, and verification failures.
- Feature deep-dives: [deterministic language service](../editor-language-service.md),
  [inline completion](../editor-inline-completion.md),
  [completion model capability](../editor-completion-model-capability.md), and
  [VS Code-feeling UX](../editor-vscode-ux.md).
