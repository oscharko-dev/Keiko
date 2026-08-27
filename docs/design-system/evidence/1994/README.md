# Issue #1994 - Autonomous Delivery Closeout Evidence

Design-system, accessibility, and redaction-safe verification evidence for the Coding Workbench
Autonomous Delivery closeout states.

## Surface Covered

- Confirmed Autonomous Delivery Authority Envelope with delivery-runner status.
- Completed governed PR gateway handoff state.
- Policy hold when authority expires or connector scope is missing.
- Verification failure before PR handoff.
- Narrow viewport layout with serious/critical axe coverage.

## Design-System Mapping

- Register rows: `docs/design-system/governance.md` and `docs/design-system/state-matrix.md`.
- Family: existing Coding Workbench window shell, mode selector, status cards, governance holds,
  timeline, and delivery status patterns.
- Component styles remain scoped to
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css`
  and consume existing semantic/component tokens.
- No global CSS, raw colors, Tier-1 primitive references, or one-off light-mode overrides are
  introduced by #1994.

## Verification Evidence

> **Historical / not reproducible by a lane.** The stop/recovery/retry @smoke spec
> `tests/e2e/coding-workbench-1994.spec.ts` was retained but its evidence-writing body was
> removed in earlier housekeeping, so `KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run
> test:e2e:coding-workbench-1994` no longer regenerates the artifacts below. The tracked captures
> record the verification as it stood when produced and are frozen at that state — the committed
> `manifest.json` carries `status: "historical"` and `verified: false` to make this explicit for a
> future shape audit. Live coverage for the workbench-closeout surface: the extended e2e matrix
> suite `tests/e2e/coding-workbench-2253.spec.ts` and the stop/recovery/retry + narrow-viewport-
> no-overflow @smoke checks retained in this same spec file, which continue to gate the closeout
> lifecycle directly.

Historical (non-regenerating) invocation, kept for shape context only:

```bash
npm run test:e2e:coding-workbench-1994   # @smoke checks only; regenerates no evidence in this directory
```

The Playwright harness writes these artifacts in this directory:

- `01-autonomous-confirmed.png`
- `02-autonomous-completed.png`
- `03-autonomous-policy-hold.png`
- `04-autonomous-verification-failed.png`
- `05-autonomous-narrow.png`
- `coding-workbench-autonomous-delivery-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`

## Test Coverage Map

- Autonomous Delivery closeout projections:
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/codingWorkbenchAutonomousDeliveryProjection.ts`.
- Window-level redaction and closeout rendering:
  `packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx`.
- Browser flow, responsive viewport, tracked screenshots, and axe:
  `tests/e2e/coding-workbench-1994.spec.ts`.

## Evidence Boundary

The artifacts use deterministic redacted fixtures. They do not include customer repository files,
secrets, private paths, raw stdout, raw stderr, raw diffs, raw model prompts, raw model outputs, or
token-bearing material.
