# Issue #2257 — Live Coding Workbench evidence

> Housekeeping 2026-08-10: the per-issue suite `coding-workbench-2257` and its config were
> retired after months without a running lane; `coding-workbench-2253` in the extended e2e matrix
> and the code-task authority journey carry the live-workbench coverage today. The command below
> is preserved as the historical record of how this evidence was produced.

This directory records Design System and accessibility acceptance evidence for the live Coding
Workbench. Production rendering consumes the server-owned runtime hook; fixture projections are not
reachable from the registered window.

## Implemented proof surface

- One labelled task field, three native mode radios, and two native source radios.
- Independent authentication, source, workspace, runtime, run-snapshot, and event-stream states.
- Server-bound start, approve, deny, stop, takeover, recovery acknowledgement, and fresh retry.
- A concise atomic polite lifecycle announcement and a separate alert channel.
- A content-free timeline retaining at most 500 facts and rendering at most 96 rows when more than
  100 facts exist.
- Container-driven reflow at 820, 768, 560, 390, and 320 CSS pixels, including 200% zoom behavior.
- Token-only Dark, Light, High Contrast, forced-colors, and reduced-motion presentation.

## Evidence status

Verified on 13 July 2026 against the running Keiko app shell with the validated, content-free BFF
contract fixture. The retained set contains 11 screenshots, computed semantic tokens, primary-action
bounds, focus evidence, overflow measurements, axe results, and the 1,000-event interaction profile.
Every capture has zero serious or critical axe findings and zero document or Workbench horizontal
overflow. The evidence is UI/contract proof; real managed-runtime attestation remains owned by
follow-on child #2258 and is not inferred from this fixture.

## Captured matrix

1. Dark, Light, Dark High Contrast, Light High Contrast, forced-colors, and reduced-motion.
2. Widths 820, 768, 560, 390, and 320 CSS pixels. The 320 CSS px capture is the 200% reflow
   equivalent of a 640 CSS px viewport.
3. Ready, approval conflict, recovery conflict, selected, disabled, and focus-visible states are
   captured. Loading, unavailable, error, empty, reconnecting, and syncing remain deterministically
   covered by the component/hook and dedicated browser suites listed in the fidelity proof.
4. Axe: 11/11 captures with zero serious or critical findings.
5. 1,000 events: at most 500 retained, 96 rendered rows, 14.4 ms interaction p95, and 0 ms maximum
   observed long task for the measured Workbench-open/event-burst window.

## Verification commands

```bash
npm run typecheck --workspace @oscharko-dev/keiko-ui
npm run lint --workspace @oscharko-dev/keiko-ui
npm test --workspace @oscharko-dev/keiko-ui -- --run CodingWorkbenchWindow
KEIKO_WRITE_TRACKED_EVIDENCE=1 npx playwright test \
  --config tests/e2e/config/playwright.issue-2257-coding-workbench.config.ts \
  --project=chromium
```
