# Issue #1296 — AI / agent component set · browser evidence

Design System 0.4.0 reference: `design-system/ai-components.html` + `design-system/keiko-ai.css`
(`--ai-*` tokens in `design-system/keiko-semantic-tokens.css`).

## What this proves

`equivalence-harness.mjs` renders the **real product `globals.css`** (PRE = `origin/release/0.2.0`,
POST = working tree) in a headless Chromium across all 7 theme / contrast / motion modes via
`page.setContent` (no file server — CodeQL-safe), and probes computed values with `getComputedStyle`.

### Group A — value-preserving migrations (0-diff gate)

The bespoke product AI surfaces were routed onto the `--ai-*` component tokens. Each token aliases
the exact primitive the surface already used, so the resolved value is identical PRE vs POST in every
mode:

| Surface                                                               | Declaration         | Token (alias of)                                                                |
| --------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `.grounded-citation`                                                  | border + background | `--ai-source-border` (`--accent-line`) / `--ai-source-surface` (`--accent-dim`) |
| `.grounded-citation-doc-badge`                                        | background          | `--ai-source-border`                                                            |
| `.arun-meter` / `.arun-summary` / `.arun-result-card` / `.arun-input` | background          | `--ai-tool-surface` (`--inset`)                                                 |
| `.arun-spin` / `.arun .dot[data-live]`                                | colour / background | `--ai-streaming-cursor` (`--accent`)                                            |
| `.arun-perm[data-on]` / `.arun-applied`                               | border + background | `--ai-source-border` / `--ai-source-surface`                                    |

**Result: 98 computed-value probes × 7 modes = 0 differences** (`computed-value-proof.json`,
`diffCount: 0`). The agent-run block was additionally migrated onto the semantic/feedback tokens
value-preservingly (proven by `globals.css.test.ts` Issue #1296 block).

### Group D — deliberate DS 0.4.0 alignment (recorded, not gated to 0)

The chat thinking dots (`.chat-typing i`) adopt `--ai-thinking-indicator` (= `--accent-text`) in
place of `--text-faint`. The computed value is **expected** to differ:

| Mode  | PRE (`--text-faint`)    | POST (`--ai-thinking-indicator`) |
| ----- | ----------------------- | -------------------------------- |
| dark  | `oklch(0.64 0.004 160)` | `rgb(78, 186, 135)`              |
| light | `oklch(0.52 0.01 160)`  | `oklch(0.48 0.13 160)`           |

The dots are decorative (`role="img" aria-label="Keiko is responding"` / the polite `role="status"`
region carry the meaning), so WCAG text-contrast does not apply; the accent thinking colour is the
DS-canonical value used by the rest of the AI vocabulary.

## Screenshots (POST, full page)

`01-dark.png` · `02-light.png` · `03-dark-hc.png` · `04-light-hc.png` · `05-prefers-contrast.png` ·
`06-forced-colors.png` · `07-reduced-motion.png`.

Each captures the **canonical `.ai-*` primitives** (response, thinking, streaming cursor, tool-call
RUNNING/DONE, citations + source list, confidence HIGH/MEDIUM/LOW, stop/regenerate, permission
request, sensitive-action confirm) and the **migrated product surfaces** (grounded citation chip,
chat thinking dots, agent-run widget with the `.ai-conf` confidence signal). They confirm the surfaces
are calm, precise, and production-ready — not merely token-compliant — and that status / risk /
confidence are encoded by **word + shape, never colour alone** (HIGH/MEDIUM/LOW, RUNNING/DONE, the
ring vs filled-dot tool glyphs). `07-reduced-motion.png` confirms the thinking/streaming/spinner
animations freeze under `prefers-reduced-motion`.

## Accessibility

- Structural a11y is gated by jest-axe in CI: `GroundedAnswer.a11y.test.tsx` (Dark **and** Light
  passes), `AgentRunWidget.test.tsx` (the `.ai-conf` confidence signal is axe-clean), plus the
  existing `WorkspaceShell.a11y` / `WorkflowHandoff.a11y` / `QiRunCard.a11y` suites.
- Non-colour status/confidence encoding is verified visually in every screenshot above.
- Reduced-motion is honoured by the `@media (prefers-reduced-motion: reduce)` blocks for
  `.ai-thinking .dots i`, `.ai-stream-cursor`, and `.ai-tool-head .st.run::before`.

## Deferred (issue Stop Conditions)

`.ai-permit` (permission request), `.ai-danger` (sensitive-action confirm), and the regenerate control
ship as **reviewable, token-backed primitives** (rendered above in all 7 modes) but are **not** wired
into live authority flows: doing so would change model-routing / permission / tool-authority surfaces,
which the issue Stop Conditions forbid without a separate issue. They are reviewable here as system
primitives.

## Reproduce

```sh
npm ci && npx playwright install chromium
BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1296/equivalence-harness.mjs
```

Exits non-zero if any Group-A computed value differs or any Group-D assertion regresses.
