# Issue #2060 — workspace multi-selection accessibility and fidelity evidence

This evidence pack covers the selected-window state added for Epic #2055.

## Scope

- `WindowFrame` selected state is now part of the design-system Card / window state contract.
- Selected windows expose the state through the accessible window name.
- The workspace surface exposes the selected-window count through a polite live region.
- Window regions are keyboard-reachable and `Space` toggles selection without a drag gesture.
- Workspace-owned `Ctrl/Cmd+C` and `Ctrl/Cmd+V` duplicate only validated, content-free layout descriptors.

## Local proof

- `npm run test:e2e:workspace-selection-2060`
  boots the packaged CLI UI, seeds content-free Project / Plugins / Automations windows,
  selects them with the real workspace marquee gesture, and captures the seven governed modes.
- `packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.a11y.test.tsx`
  covers the default and selected window frame states with `jest-axe`.
- `packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.test.tsx`
  covers keyboard selection toggling and selected-state accessible naming.
- `packages/keiko-ui/src/app/components/desktop/Workspace.test.tsx`
  covers marquee selection, grouped drag routing, workspace clipboard command routing,
  and the live selected-window count.
- `packages/keiko-ui/src/app/components/desktop/hooks/workspaceClipboard.test.ts`
  covers schema validation, ID regeneration, safe offsets, secret rejection, malformed payload rejection,
  and selected-only duplication.
- `docs/design-system/state-matrix.md` and `docs/design-system/fidelity-matrix.md`
  document the new `Selected` state for Card / window.

## Visual note

The selected-window treatment uses component-scoped styles and existing semantic tokens:
`--focus-ring`, `--accent`, `--accent-line`, `--selection-surface`, and `--card-shadow-raised`.
No `packages/keiko-ui/**/globals.css` file was changed.

## Browser evidence

Regenerate tracked artifacts intentionally with:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:workspace-selection-2060
```

The harness writes:

- `01-dark.png`
- `02-light.png`
- `03-dark-hc.png`
- `04-light-hc.png`
- `05-prefers-contrast.png`
- `06-forced-colors.png`
- `07-reduced-motion.png`
- `workspace-selection-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`
