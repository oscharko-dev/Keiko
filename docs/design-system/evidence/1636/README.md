# Issue #1636 - Citation Context And Back-To-Chat Evidence

Design-system and accessibility evidence for the answer-local citation context and
Back to chat affordance added to the verified Local Knowledge PDF viewer in issue
#1636.

## Surface Covered

- Answer-local citation context panel in `PdfCitationPreviewWindow`.
- Same-document sibling citation rail for the originating assistant answer.
- Honest anchor-quality copy for page-only, approximate, and unavailable anchors.
- Back to chat restore/focus/scroll/highlight flow, including disabled fallback
  states when the source chat or rendered assistant message is unavailable.
- Transient highlight styling on grounded citation chips and inline citation
  markers after returning to chat.

## Design-System Mapping

- The new context panel reuses the governed PDF viewer shell introduced in #1634
  and the grounded citation chip language introduced in #1635 instead of creating
  a parallel viewer style system.
- All new styling lives in `globals.css` and consumes semantic/component tokens:
  `--surface-primary`, `--surface-inset`, `--surface-accent-subtle`,
  `--border-subtle`, `--border-accent`, `--text-primary`, `--text-secondary`,
  `--accent-bright`, and `--focus-ring`.
- The active sibling citation is differentiated through tokenized border/background
  treatment plus explicit context placement, not color alone.
- Disabled Back to chat stays discoverable via visible explanatory copy instead of
  disappearing.
- Highlight return states reuse the existing citation affordances and add a
  temporary focus-ring pulse, preserving the established citation entry-point
  visual language from #1635.

## Verification Evidence

Focused issue #1636 verification: `PASS`.

- Targeted eslint on the changed citation-viewer/chat files: PASS, with only the
  existing Next.js pages-directory warning and the expected ignored `globals.css`
  warning for direct CLI invocation.
- Focused Vitest slice: PASS, 3 files / 15 tests.
- `docs/design-system/evidence/1636/a11y-proof.json`: PASS.
- `docs/design-system/evidence/1636/citation-context-back-to-chat-fidelity-proof.json`:
  PASS.

The broader viewer window chrome, responsive shell, and theme screenshots remain
covered by `docs/design-system/evidence/1634/`. Issue #1636 changes the governed
viewer's contextual content and return-navigation states, so this issue records a
lightweight JSON proof rather than duplicating the full screenshot harness.

## Test Coverage Map

- Answer-local same-document context assembly and origin metadata:
  `packages/keiko-ui/src/app/components/desktop/hooks/usePdfCitationPreview.test.tsx`.
- Session reuse, sibling activation without reauthorization, cross-answer context
  replacement, Back to chat fallback/highlight, disabled availability, and
  highlight cleanup:
  `packages/keiko-ui/src/app/components/desktop/widgets/cards/pdf-citation-preview-session.test.ts`.
- Viewer copy, honest anchor messaging, sibling navigation, restore/focus wiring,
  and disabled Back to chat UI:
  `packages/keiko-ui/src/app/components/desktop/widgets/cards/PdfCitationPreviewWindow.test.tsx`.

No raw paths, session handles, source excerpts, PDF bytes, internal identifiers,
or token values are surfaced in the viewer DOM or in these evidence artifacts.
