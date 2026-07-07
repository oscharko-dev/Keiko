# Issue #1991 - Governed Assist Evidence

Design-system, accessibility, and governance evidence for the Coding Workbench Governed Assist mode.

## Surface Covered

- Governed Assist active run state with a proposed diff summary that remains review data only.
- Explicit absence of apply, approval, Git, PR, merge, and external-write authority.
- Blocked workspace-write, command-execution, and connector-write policy-denial state.
- Narrow viewport layout and serious/critical axe coverage.
- Redacted runtime timeline using content-free event labels and counters only.

## Design-System Mapping

- Register rows: `docs/design-system/governance.md` and `docs/design-system/state-matrix.md`.
- Family: existing Coding Workbench window shell, card, status, and feedback patterns.
- Component styles remain scoped to
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css`
  and consume existing semantic/component tokens.
- No global CSS, raw colors, Tier-1 primitive references, or `[data-theme="light"]` overrides are
  introduced by #1991.

## Verification Evidence

Rerunnable browser harness:

```bash
npm run test:e2e:coding-workbench-1991
```

Tracked evidence regeneration:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-1991
```

Receipt command for the user-facing child gate:

```bash
.keiko-scripts/ui-verify-receipt.sh 1991 -- npm run test:e2e:coding-workbench-1991
```

The Playwright harness writes these artifacts in this directory:

- `01-proposed-diff.png`
- `02-blocked-action.png`
- `03-blocked-narrow.png`
- `coding-workbench-governed-assist-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`

## Test Coverage Map

- Contract mode-policy helper and redaction-safe policy decisions:
  `packages/keiko-contracts/src/coding-workbench.test.ts`.
- Runtime denial handling for fake sidecar permission escalation attempts:
  `packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts`.
- Workbench proposed-diff and blocked-action states:
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx`.
- Browser flow, responsive viewport, and axe:
  `tests/e2e/coding-workbench-1991.spec.ts`.

## Evidence Boundary

The artifacts use deterministic redacted fixtures. They do not include customer repository files,
secrets, private paths, raw model prompts, model outputs, diffs, access tokens, refresh tokens, or
token-bearing logs.
