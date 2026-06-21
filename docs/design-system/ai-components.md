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

The streaming caret and the confidence signal are presentation-only additions over data the product
already produces (`sendStatus === "streaming"`, `hypothesis.confidence`); a non-level confidence string
keeps its plain key/value row (behaviour-preserving).

## Deferred — authority-bearing live wiring

`.ai-permit` (permission request), `.ai-danger` (sensitive-action confirm), and a chat-level
regenerate control ship as reviewable, token-backed primitives (rendered in the
[evidence](evidence/1296/README.md) in all 7 modes) but are **not** wired into live agent flows. Doing
so would change model-routing / permission / tool-authority surfaces, which the issue Stop Conditions
forbid without a separate issue. Keiko deliberately keeps apply/exec behind its existing gated
surfaces; these primitives are available for that future, authority-scoped work.

See also: [fidelity-matrix](fidelity-matrix.md), [token-component-reuse-map](token-component-reuse-map.md),
[light-mode-deviation-register](light-mode-deviation-register.md), [ADR-0049](../adr/ADR-0049-design-system-fidelity-gates.md).
