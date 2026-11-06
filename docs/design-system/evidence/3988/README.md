# Window chunk recovery evidence (#3988 / CI4011-003)

The existing window fallback must expose its recovery controls even when both the lazy window script and stylesheet remain pending. React can defer the fallback update behind that stylesheet. The owner reveals only its already-mounted status and recovery region, then retains the eventual React state update. The human chooses Reload Keiko; no automatic reload or report occurs.

The existing smoke harness intercepts the two actual window resources, verifies script and stylesheet classes, retains the ten-second stall and thirty-second recovery bounds, and proves one keyboard-initiated document reload restores the composer. macOS WebKit uses the existing Safari
Option-Tab button-navigation recipe; Linux WebKit and other engines use ordinary Tab. Both directions
retain actual focused-control assertions, and Enter performs the same human reload. Before the stall both mounted controls are hidden. Afterwards Reload Keiko and Create error report are visible and keyboard reachable. The original single-resource recovery remains a separate positive control.

Tracked regeneration uses the existing evidence helpers:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm exec playwright -- test --config tests/e2e/config/playwright.config.ts --project=chromium tests/e2e/window-chunk-stall.smoke.spec.ts
```

Normal runs write ignored artifacts. The seven captures cover dark, light, dark and light high contrast, prefers contrast, forced colors, and reduced motion at 1280 by 900. Theme and high-contrast attributes are applied after application hydration; browser media settings use Playwright emulation. Each capture asserts the actual DOM and media settings. The JSON proofs bind source and global CSS hashes, screenshot hashes, viewport, focused reload control, and actual scoped axe findings. These are existing recovery states and inherited button styles, not acceptance of a new complete component family. The panel crop preserves the recovery layout; the owning window uses the existing resizable workspace layout.

Firefox can replace the browsing context when navigating to the application's COOP-protected response. The recovery fixture applies the same real Playwright media configuration before navigation and again on the current application context after navigation. Each mode still asserts the actual media preference; the fixture does not override `matchMedia` or change the application's isolation headers. The controlled Linux Firefox proof distinguishes the navigation reset from unsupported media emulation.

The controlled dual-resource regression failed before the repair. The first synchronous React-only attempt also failed; the mounted recovery mechanism is the successful second attempt. An initial evidence pass did not verify the high-contrast attribute after hydration. The strengthened assertion caught that setup error; those initial mode labels are not qualification evidence. The tracked proofs must report PASS with all seven actual modes before publication.

Activity Log qualification uses the existing stage producer and complete `check:activity-log` gate. A DOM capture alone does not prove support reconstruction. Browser fidelity, accessibility, unit coverage, source gates, and full affected browser smokes are separately reported with their executed source identities in the PR repair receipt.
