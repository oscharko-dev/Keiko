# AI & agent components — usage, states, and accessibility

Issue #1296 · Epic #1290 · Design System 0.4.0.

Reference: `design-system/ai-components.html`, `design-system/keiko-ai.css`, and the `--ai-*` tokens in
`design-system/keiko-semantic-tokens.css`. Browser evidence (7 modes + computed-value proof):
[`docs/design-system/evidence/1296/`](evidence/1296/README.md). Drift / a11y gates:
`packages/keiko-ui/src/app/globals.css.test.ts` (Issue #1296 block) and the per-component jest-axe
suites.

Keiko is agentic, so these are core product infrastructure, not optional patterns. The canonical
primitives live in `packages/keiko-ui/src/app/globals.css` (`.ai-*`, ported verbatim from
`keiko-ai.css` so they resolve byte-identically to the reference). Product surfaces reuse the same
`--ai-*` component tokens instead of one-off colours.

## Component tokens (`--ai-*`)

All defined in `globals.css :root` as pure aliases over existing primitives — so consuming them is
value-preserving (proved by the 0-diff harness):

| Token                                                | Aliases                                 | Used for                          |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------- |
| `--ai-response-surface` / `--ai-response-border`     | `--surface` / `--line-soft`             | response bubble                   |
| `--ai-thinking-indicator`                            | `--accent-text`                         | thinking dots                     |
| `--ai-streaming-cursor`                              | `--accent`                              | streaming caret / live indicators |
| `--ai-source-surface` / `--ai-source-border`         | `--accent-dim` / `--accent-line`        | citation chip + source list       |
| `--ai-tool-surface` / `--ai-tool-border`             | `--inset` / `--line`                    | tool-call / result cards          |
| `--ai-confidence-high` / `-medium` / `-low`          | `--ok` / `--warn` / `--danger`          | confidence track segments         |
| `--ai-permission-surface` / `--ai-permission-border` | `--feedback-warning-surface` / warn-mix | permission request                |

## Editor-agent tokens (`--ed-agent-*`)

Editor-context agent surfaces reuse the existing editor and AI palette rather than adding a parallel
namespace. `globals.css` exposes the editor-agent aliases from `design-system/editor-agent.html`:

| Token                  | Aliases / source       | Used for                               |
| ---------------------- | ---------------------- | -------------------------------------- |
| `--ed-agent-line`      | accent mix             | inline agent suggestion line highlight |
| `--ed-agent-gutter`    | `--accent-text`        | editor gutter agent marker             |
| `--ed-agent-ghost`     | `--ed-ghost`           | Monaco/editor ghost text               |
| `--ed-agent-accept`    | `--ed-diff-ins-gutter` | accepted suggestion / positive marker  |
| `--ed-agent-reject`    | `--danger`             | rejected or unsafe suggestion marker   |
| `--ed-agent-chip-bg`   | `--accent-dim`         | editor-agent review chip surface       |
| `--ed-agent-chip-line` | `--accent-line`        | editor-agent review chip border        |

`packages/keiko-editor/src/monaco/theme.ts` maps Monaco `editorGhostText.foreground` through
`--ed-agent-ghost`, which aliases `--ed-ghost` so the rendered ghost text does not drift. The
editor-agent evidence harness captures Dark, Light, and High Contrast screenshots under
[`docs/design-system/evidence/1296/editor/`](evidence/1296/editor/).

## Components, states, and accessibility

| Component                | Class                       | States                  | Non-colour encoding                                                    | Reduced motion             |
| ------------------------ | --------------------------- | ----------------------- | ---------------------------------------------------------------------- | -------------------------- |
| Response surface         | `.ai-response`              | default / empty / error | text content carries meaning                                           | static                     |
| Thinking                 | `.ai-thinking`              | running                 | the word "Thinking" + pulsing dots                                     | dots freeze at 0.7 opacity |
| Streaming cursor         | `.ai-stream-cursor`         | streaming               | caret position/shape at the live edge                                  | caret stops blinking       |
| Tool-call card           | `.ai-tool`                  | idle / running / done   | uppercase RUNNING / DONE word + ring-vs-filled-dot glyph               | spinner ring freezes       |
| Source citation          | `.ai-cite` / `.ai-source`   | default                 | numbered superscript marker + source row                               | static                     |
| Confidence               | `.ai-conf[data-level]`      | high / medium / low     | filled-segment count + uppercase word (e.g. "Low — verify")            | static                     |
| Stop / regenerate        | `.ai-stop` / `.ai-controls` | default                 | danger outline + square glyph + word                                   | static                     |
| Permission request       | `.ai-permit`                | default                 | titled card + ✓/✗ scope rows + weighted action pair                    | static                     |
| Sensitive-action confirm | `.ai-danger`                | default                 | danger card + plain-language consequence + weighted danger/cancel pair | static                     |

Accessibility expectations for any surface using these primitives:

- **Live regions / busy state.** Streaming and run lifecycle are announced through a polite
  `role="status"` region; the visual caret/dots/spinner are decorative (`aria-hidden` or a labelled
  `role="img"`) and must not be the only announcement.
- **Non-colour status.** Status, risk, permission, and confidence must always read by text/icon/shape
  in addition to colour (the table above is the contract; the `globals.css.test.ts` Issue #1296 block
  pins the confidence/word treatment, and the browser screenshots verify it in Light/Dark/HC).
- **Keyboard + focus.** Interactive controls (`.ai-stop`, permission/sensitive-action actions) are
  real `<button>`s and inherit the global `:focus-visible` ring; never encode state on a non-focusable
  element.
- **Reduced motion.** Every animation (`ai-blink`, `ai-caret`, `ai-spin`) is `animation: none` at
  rest and runs only inside `@media (prefers-reduced-motion: no-preference)` (WCAG 2.3.3 — motion off
  by default).

## Product surface mapping

| Product surface                       | File                                              | Consumes                                     |
| ------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| Grounded citation chip                | `GroundedAnswer.tsx` (`.grounded-citation`)       | `--ai-source-surface` / `--ai-source-border` |
| Chat thinking dots                    | `ChatWindow.tsx` (`.chat-typing`)                 | `--ai-thinking-indicator`                    |
| Streaming caret                       | `ChatWindow.tsx` (`.ai-stream-cursor`)            | `--ai-streaming-cursor`                      |
| Agent-run tool / result / input cards | `AgentRunWidget.tsx` (`.arun-*`)                  | `--ai-tool-surface`                          |
| Agent-run live spinner / dot          | `AgentRunWidget.tsx` (`.arun-spin`, `.arun .dot`) | `--ai-streaming-cursor`                      |
| Agent hypothesis confidence           | `AgentRunWidget.tsx` (`.ai-conf`)                 | `--ai-confidence-*`                          |
| Editor ghost text                     | `theme.ts` (`editorGhostText.foreground`)         | `--ed-agent-ghost`                           |
| Editor agent primitives               | `editor-agent-1296.spec.ts` evidence scene        | `--ed-agent-*` + `.ai-permit` / `.ai-danger` |

The streaming caret and the confidence signal are presentation-only additions over data the product
already produces (`sendStatus === "streaming"`, `hypothesis.confidence`); a non-level confidence string
keeps its plain key/value row (behaviour-preserving).

## Issue #1405 live authority wiring

Issue #1405 wires the previously token-backed authority primitives into bounded product surfaces
without widening BFF authority. Browser evidence and the acceptance ledger live under
[`docs/design-system/evidence/1405/`](evidence/1405/README.md).

| Surface                         | Live behaviour                                                                    | Authority boundary                                                                       | Evidence                                                               |
| ------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent permission request        | `AgentGateCard` renders `.ai-permit` scope rows and approve/reject buttons.       | The card only resumes an already queued action; it does not mint new BFF routes.         | `AgentGateCard.test.tsx`; `human-loop-1405.spec.ts`                    |
| Sensitive memory forget action  | Chat memory forget uses `.ai-danger` and requires typing `FORGET` before send.    | The existing memory-forget API still requires `userAcknowledgedDestructive: true`.       | `ChatWindow.test.tsx`; `memory-handlers.ts`; `human-loop-1405.spec.ts` |
| Chat regenerate latest response | Latest ungrounded assistant turn exposes `.ai-controls`; in-flight state cancels. | The BFF replays through Model Gateway, preserves message id, and rejects grounded chats. | `desktop-chat-handlers.test.ts`; `api.test.ts`; `ChatWindow.test.tsx`  |

Regeneration is intentionally limited to the latest ungrounded assistant turn. Grounded answers keep
their citations and evidence immutable; callers receive `NOT_APPLIABLE` instead of silently dropping
grounding context. Sensitive/destructive operations remain explicit human actions and continue to use
the existing server-side acknowledgement boundaries.

See also: [fidelity-matrix](fidelity-matrix.md), [token-component-reuse-map](token-component-reuse-map.md),
[light-mode-deviation-register](light-mode-deviation-register.md), [ADR-0049](../adr/ADR-0049-design-system-fidelity-gates.md).
