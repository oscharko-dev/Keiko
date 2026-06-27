# Issue #1559 — Dialog-mode UX browser + accessibility evidence

Browser-rendered evidence for the chat dialog-mode switch and voice-profile selection UX
(Issue #1559, Epic #1556).

## How to reproduce

From the repository root, after `npm ci` and `npx playwright install chromium`:

```bash
node docs/design-system/evidence/1559/equivalence-harness.mjs
```

The harness launches headless Chromium, renders the dialog-mode surfaces against the real product
`packages/keiko-ui/src/app/globals.css` via `page.setContent` (no file server), in dark and light
themes, runs `axe-core` (WCAG 2.0/2.1/2.2 A + AA rules) on each rendered state, and writes a PNG per
state plus `dialog-mode-proof.json`. It exits non-zero on any serious/critical axe violation or a
missing render.

The rendered markup mirrors `VoiceDialogMode.tsx` and `voice-dialog-state.ts` exactly — the same
classes, roles, `aria-live` wiring, headline strings, and `data-dialog-state` attribute that the
keiko-ui unit tests pin against the shipped React components. `globals.css` is unchanged by #1559, so
the existing Issue #1300 visual-regression proof gate is unaffected.

## Result

`dialog-mode-proof.json`: **PASS** — 16 screenshots (8 states × dark/light), **0 serious/critical
axe violations** on the component DOM.

## States captured (maps to the issue's required visual-regression states)

| File prefix      | Dialog state                               | Issue-required state |
| ---------------- | ------------------------------------------ | -------------------- |
| `01-idle`        | switch on, ready                           | active               |
| `02-connecting`  | establishing the session                   | active               |
| `03-listening`   | capturing user speech                      | listening            |
| `04-thinking`    | assistant thinking                         | (thinking)           |
| `05-speaking`    | assistant speaking                         | speaking             |
| `06-muted`       | assistant speaking, playback muted         | muted                |
| `07-error`       | session error (role=alert)                 | error                |
| `08-unavailable` | no dialogue affordance, text composer only | unavailable          |

Each prefix has a `-dark.png` and `-light.png`. Every screenshot shows the always-available text
composer, demonstrating that dialog mode never blocks text chat (AC1). The `08-unavailable` state
shows only the composer — no switch, selector, or controls — demonstrating AC3.
