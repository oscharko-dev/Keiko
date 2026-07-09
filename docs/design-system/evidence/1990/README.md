# Issue #1990 - Coding Workbench Evidence

Design-system, accessibility, and operator-control evidence for the first Coding Workbench window
introduced for epic #1982.

## Surface Covered

- Left rail entry point for the Coding Workbench.
- Empty pre-run state with governed autonomy selection.
- Sidecar gateway and ChatGPT/Codex subscription profile cards.
- Running, approval-required, blocked, failed, and completed workbench states.
- Stop and take-over controls for active or blocked runs.
- Redacted approval prompt preview with no raw diff, access token, or refresh token content.
- Dark, Light, and High-Contrast empty-state appearances.
- Narrow viewport layout and serious/critical axe coverage.

## Design-System Mapping

- Register rows: `docs/design-system/governance.md` and `docs/design-system/state-matrix.md`.
- Family: window shell plus card/status/feedback patterns from `docs/design-system/state-matrix.md`.
- Component styles live in
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css`
  and consume existing semantic/component tokens.
- No global CSS, raw colors, Tier-1 primitive references, or `[data-theme="light"]` overrides are
  introduced by #1990.

## Verification Evidence

Rerunnable browser harness:

```bash
npm run test:e2e:coding-workbench-1990
```

Tracked evidence regeneration:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-1990
```

Receipt command for the user-facing child gate:

```bash
.keiko-scripts/ui-verify-receipt.sh 1990 -- npm run test:e2e:coding-workbench-1990
```

The Playwright harness writes these artifacts in this directory:

- `01-empty-desktop.png`
- `02-approval-required.png`
- `03-running-narrow.png`
- `04-empty-light.png`
- `05-empty-high-contrast.png`
- `coding-workbench-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`

## Test Coverage Map

- API helper profile validation:
  `packages/keiko-ui/src/lib/api.ts` and
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx`.
- Window rendering, state coverage, redaction, controls, and jest-axe smoke:
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx`.
- Rail entry point and singleton opening:
  `packages/keiko-ui/src/app/components/desktop/LeftRail.test.tsx`.
- Registry and descriptor metadata:
  `packages/keiko-ui/src/app/components/desktop/widgets/index.test.tsx` and
  `packages/keiko-ui/src/app/components/desktop/windows/descriptor-meta.test.ts`.
- Browser flow, responsive viewport, and axe:
  `tests/e2e/coding-workbench-1990.spec.ts`.

## Evidence Boundary

The artifacts use deterministic redacted fixtures. They do not include customer repository files,
secrets, private paths, raw model prompts, model outputs, diffs, access tokens, refresh tokens, or
token-bearing logs.
