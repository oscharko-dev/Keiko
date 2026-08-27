# Issue #1559 — Dialog-mode UX browser + accessibility evidence

Browser-rendered evidence for the chat dialog-mode switch and voice-profile selection UX
(Issue #1559, Epic #1556).

## How to reproduce

From the repository root, after `npm ci` and `npx playwright install chromium`:

```bash
node docs/design-system/evidence/1559/equivalence-harness.mjs
```

The harness launches headless Chromium, renders the dialog-mode surfaces against the real product
`packages/keiko-ui/src/app/globals.css` via `page.setContent` (no file server), across the seven
canonical theme/contrast/motion modes from [`state-matrix.md`](../../state-matrix.md) — `dark`,
`light`, `dark-hc`, `light-hc`, `prefers-contrast`, `forced-colors`, `reduced-motion` — runs
`axe-core` (WCAG 2.0/2.1/2.2 A + AA rules) on each rendered state, and writes a PNG per (state,
mode) pair plus `dialog-mode-proof.json`. It exits non-zero on any serious/critical axe violation
or a missing render.

The rendered markup mirrors `VoiceDialogMode.tsx` and `voice-dialog-state.ts` exactly — the same
classes, roles, `aria-live` wiring, headline strings, and `data-dialog-state` attribute that the
keiko-ui unit tests pin against the shipped React components. `globals.css` is unchanged by #1559, so
the existing Issue #1300 visual-regression proof gate is unaffected.

## Result

**Tracked receipt (previous run):** `dialog-mode-proof.json` reflects the earlier
two-mode run — 16 screenshots (8 states × `dark`/`light`), **0 serious/critical axe violations** on
the component DOM.

**Expected coverage (current harness code):** the `THEMES` array in
[`equivalence-harness.mjs`](equivalence-harness.mjs) now enumerates the seven canonical
theme/contrast/motion modes from [`state-matrix.md`](../../state-matrix.md) — `dark` (01),
`light` (02), `dark-hc` (03), `light-hc` (04), `prefers-contrast` (05), `forced-colors` (06),
`reduced-motion` (07) — so a fresh run captures 8 × 7 = 56 screenshots. The tracked PNGs and the
`dialog-mode-proof.json` in this directory have NOT yet been regenerated to match; the harness
change extends coverage and the maintainer will regenerate the receipt in a follow-up (a new
receipt takes precedence over the tracked-run line above). Re-run
`node docs/design-system/evidence/1559/equivalence-harness.mjs` to regenerate PNGs and the receipt
before treating this evidence as covering the seven-mode surface, and after any product change
that affects the dialog-mode surfaces or the seven canonical modes.

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

Each prefix has one screenshot per canonical mode with the mode id as suffix: `-dark.png`,
`-light.png`, `-dark-hc.png`, `-light-hc.png`, `-prefers-contrast.png`, `-forced-colors.png`,
`-reduced-motion.png` (8 states × 7 modes = 56 screenshots on a fresh run — see the Result section
above for the currently tracked receipt vs the expected coverage). Every screenshot shows the
always-available text composer, demonstrating that dialog mode never blocks text chat (AC1). The
`08-unavailable` state shows only the composer — no switch, selector, or controls — demonstrating
AC3.
