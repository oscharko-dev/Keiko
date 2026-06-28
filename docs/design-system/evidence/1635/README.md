# Issue #1635 - Citation Entry Point Evidence

Design-system and accessibility evidence for the Local Knowledge PDF citation entry points added in
issue #1635.

## Surface Covered

- Inline citation markers rendered by `SafeMarkdown`.
- Local Knowledge citation chips rendered by `GroundedAnswer`.
- Passive states: normal, available, recoverable, blocked, not-applicable, and passive request failure.
- Active states: verified open, recoverable open, duplicate-click coalescing, and same-document viewer reuse.

## Design-System Mapping

- Default/non-PDF/not-applicable citations remain the existing `.grounded-citation` or plain markdown text.
- Available inline markers use `.citation-inline-marker` with visible text, `aria-label`, hover, and
  `:focus-visible` states.
- Recoverable inline markers and chips use dashed styling plus explicit "Recover PDF" or "Open PDF recovery"
  copy; the state is not conveyed by color alone.
- Blocked inline markers and chips use dotted/dashed styling plus explicit "PDF preview unavailable" or
  "PDF unavailable" copy and are non-activatable.
- Focus states use `--focus-ring`; recovery and blocked labels use `--feedback-info` and `--feedback-danger`.
- The implementation reuses the existing `data-tip` tooltip pattern and grounded citation chip structure
  instead of introducing a parallel styling layer.

## Verification Evidence

Focused issue #1635 verification: `PASS`.

- `npm run typecheck` with Node 24.14.0: PASS.
- Targeted eslint on changed contract/server/UI surface: PASS. The Next pages-directory plugin emitted its
  existing environment warning, with zero lint findings after cleanup.
- `packages/keiko-server/src/local-knowledge-preview-handlers.test.ts`: PASS, 8 tests.
- UI focused Vitest slice: PASS, 7 files / 118 tests.
- `tests/scripts/dev-runner-readiness.test.ts`: PASS; the PDF viewer now defers `pdfjs-dist` runtime
  loading until a browser-only verified preview session exists, so Next SSR no longer evaluates pdf.js
  before `DOMMatrix` is available.
- `docs/design-system/evidence/1635/a11y-proof.json`: PASS.
- `docs/design-system/evidence/1635/citation-entrypoints-fidelity-proof.json`: PASS.

Full `.keiko-scripts/verify.sh` was rerun on 2026-06-28: PASS, 849 test files, 14,550 tests passed,
and 2 skipped.

## Test Coverage Map

- Passive status batch and failure fallback:
  `packages/keiko-ui/src/app/components/desktop/hooks/usePdfCitationPreview.test.tsx`.
- Inline marker open, marker mismatch, and blocked marker:
  `packages/keiko-ui/src/app/components/desktop/SafeMarkdown.test.tsx`.
- Citation chip open, recoverable chip, and blocked chip:
  `packages/keiko-ui/src/app/components/desktop/GroundedAnswer.test.tsx`.
- Same-document viewer reuse and recovery shell:
  `packages/keiko-ui/src/app/components/desktop/widgets/cards/pdf-citation-preview-session.test.ts`.
- Server per-citation passive status and active authorization/audit behavior:
  `packages/keiko-server/src/local-knowledge-preview-handlers.test.ts`.

No core feature stubs were used for final acceptance. Unit-level mocks isolate API and viewer seams; the final
tests execute against the real #1632 contract types, #1633 authorization/session API shape, and #1634 viewer
window/session registry on the epic branch.
