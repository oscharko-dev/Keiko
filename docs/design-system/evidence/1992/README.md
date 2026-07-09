# Issue #1992 - Supervised Coding Evidence

Design-system, accessibility, and redaction-safe verification evidence for the Coding Workbench
Supervised Coding delivery approval flow.

## Surface Covered

- Supervised Coding approval-required state with redacted delivery metadata only.
- Distinct approved, denied, stopped, and failed closeout states for the same scoped action.
- Visible approval metadata: action kind `push`, risk `high`, policy reason
  `approval-required`, and scope label `workspace-scope`.
- Operator stop control remaining enabled while the approval prompt is visible, with a
  content-free `Stop requested` status after the click.
- Narrow viewport layout and serious/critical axe coverage.

## Design-System Mapping

- Register rows: `docs/design-system/governance.md` and `docs/design-system/state-matrix.md`.
- Family: existing Coding Workbench window shell, status, permission prompt, and feedback patterns.
- Component styles remain scoped to
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css`
  and consume existing semantic/component tokens.
- No global CSS, raw colors, Tier-1 primitive references, or one-off light-mode overrides are
  introduced by #1992.

## Verification Evidence

Rerunnable browser harness:

```bash
npm run test:e2e:coding-workbench-1992
```

Tracked evidence regeneration:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-1992
```

Receipt command for the user-facing child gate:

```bash
.keiko-scripts/ui-verify-receipt.sh 1992 -- npm run test:e2e:coding-workbench-1992
```

The Playwright harness writes these artifacts in this directory:

- `01-approval-required.png`
- `02-approved.png`
- `03-denied.png`
- `04-stopped.png`
- `05-failed.png`
- `06-approval-required-narrow.png`
- `coding-workbench-supervised-coding-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`

## Test Coverage Map

- Projection copy and approval metadata:
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/codingWorkbenchProjection.ts`.
- Window-level supervised approval lifecycle rendering:
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx`.
- Browser flow, responsive viewport, tracked screenshots, and axe:
  `tests/e2e/coding-workbench-1992.spec.ts`.

## Evidence Boundary

The artifacts use deterministic redacted fixtures. They do not include customer repository files,
secrets, private paths, raw stdout, raw stderr, raw diffs, raw model prompts, raw model outputs, or
token-bearing material.
