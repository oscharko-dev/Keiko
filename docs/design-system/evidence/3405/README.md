# Updater reliability evidence — #3405 / #3403

The browser evidence proves that the startup notice yields only while a visible, foreground
**ready** Update window owns the same critical context and actions. The notice returns when that
window is backgrounded or minimized and remains available while the foreground updater is loading
or contains only a load error. Keyboard modality is established with a real Tab press before moving
focus; programmatic focus after a pointer click must not steal the foreground.

This set was regenerated on 2026-10-12 (UTC) from PR #3913 signed source head
`2eb5752bc9f5192b19a79117df4a5964d9707c57` in the main macOS arm64 checkout using Node 24.18.0,
npm 11.16.0, Next.js 16.3.8, and Playwright 1.63.0. The unchanged eight-test Chromium suite passed
in 41.6 seconds, including the real-BFF outage journey. The unchanged evidence freshness gate and
its three focused contract controls also passed. All eight UI source hashes and four harness
hashes match that inspected source head.

The original producer recreated all 17 tracked artifacts: 14 screenshots and three JSON records.
`11-progress-state.png` and `13-reconnecting-state-mocked.png` changed PNG bytes relative to the
previous committed set; the other 12 screenshots remained
byte-identical. All three JSON records now bind the actual inspected
sources. This is macOS browser and fixture qualification; it does not claim Linux execution,
production update success, native N−1→N replacement, or final integrated-head acceptance.

The current suite includes the real-BFF outage journey. Both the main server and the outage
harness use isolated copies of the fake-key gateway fixture, preserving the tracked source
through normal CLI credential migration and subsequent restarts.

The source-label cleanup in PR #4039 regenerated this evidence again on 2026-10-16 using the
same Node 24.18.0 runtime. All eight unchanged tests passed; only `11-progress-state.png` changed
PNG bytes, and the three JSON records now bind the updated English/German message sources.
The evidence freshness check passed. This remains updater fixture evidence, not Chat scope proof.

The source-intent repair for #4040 regenerated the original producer again on 2026-10-18
using Node 24.18.0. All eight unchanged Chromium cases passed in 46.7 seconds, including
the real-BFF outage case. Two PNGs changed bytes (`10-responsive-manual-path.png` and
`11-progress-state.png`); the three JSON records now bind the current message catalogs.
The evidence freshness gate passed. This remains updater evidence, not Chat acceptance.

## Reproduce

Use the supported Node 24 runtime and the checkout's own dependencies:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:update-ui-1696
npm run check:update-ui-evidence
```

The retained command name now captures this directory, not historical #1696. Run only one owner
against the suite's configured port/build tree. Container runs need an init process, for example
`docker run --init`, so detached BFF processes are reaped after the real stop/restart journey.
The required CI subset is:

```bash
npm run test:e2e:update-ui-1696 -- --grep @real-bff-outage
```

## Evidence and limits

- [Manifest](manifest.json): 14 screenshots, the proof documents, eight current UI source hashes,
  and four harness provenance hashes.
- [Fidelity proof](update-experience-fidelity-proof.json): seven canonical modes, responsive/manual,
  progress, critical notice, portable eligibility, reconnect and remediation captures.
- [Accessibility proof](a11y-proof.json): axe-core 4.12.1 reported no violations in its 12 recorded
  captures; the suite also asserts English/German control, focus and polite-live-region parity.
- The ready-marker selector lives in `UpdateWindow.module.css` because it bridges the existing
  desktop-window and startup-notice contracts in compact viewports (≤720px), with 320px browser
  proof. Its scoped `:global()` references are registered in the Design System exception inventory;
  no shared stylesheet rule was added.
- `13-reconnecting-state-mocked.png` deliberately uses a deterministic transport-failure fixture.
  All screenshots use mocked update API responses and prove rendered UI behavior only.
- The separate real-BFF test passed actual HTTP start acceptance, process stop/restart, retained
  progress, reconnect and durable recovery-required projection. Its release metadata and
  non-mutating execution remain fixtures; it does not prove a native N−1→N replacement.

The manifest records all 17 artifacts and their current source hashes. This set is not final
accessibility acceptance. Final integrated-head verification remains required.
Subjective visual and assistive-technology judgment belongs to the final human review.
Production-signed release qualification is tracked separately in the
[repair ledger](../../../qa/built-in-updater-repair-3405.md).

Historical #1696 screenshots and JSON remain in [their original directory](../1696/README.md).

## Customer updater presentation — #4047

The startup notice uses availability-specific headings and distinguishes a required portable setup
from a confirmed newer version. Its notice-only translations follow the already-lazy widget into
the existing optional catalog. The original freshness producer now binds eleven UI sources,
including both optional catalogs and their translation owner; four harness inputs remain separate.
Three failure-first controls demonstrate that changing any newly bound translation source was
previously missed. The original eight-case browser producer plus the new setup-only reload/details regression
regenerated all 17 original artifacts on macOS arm64 with pinned Node 24.18.0. The nine
Chromium cases passed in 54.6 seconds, including real-BFF outage and the normal/critical
setup-only reload/details checks. All three records bind 11 UI sources and 4 harness inputs;
`10-responsive-manual-path.png`, `11-progress-state.png`, and
`13-reconnecting-state-mocked.png` changed PNG bytes. The unchanged numerical freshness and
Editor isolation gates pass. This remains UI/fixture evidence; actual signed package replacement,
restart and SSD qualification are separate #4047 obligations.

The subsequent #4047 repair preserves the unchanged startup import-boundary control: the thin
preflight/dismissal controller loads its optional-catalog view only when a visible notice is
admitted. A current or suppressed report does not load that view. The original control reproduced
locally as 1 failure/3 healthy controls before the repair and all four pass afterwards. Two existing
UI lint suppressions were removed. The final nine-case producer passed in 47.3 seconds and binds
12 UI sources, including the deferred presentation, plus the same four harness inputs. All 17
artifacts were regenerated through the original producer with tracked evidence enabled; only
`10-responsive-manual-path.png`, `11-progress-state.png`, and
`13-reconnecting-state-mocked.png` changed screenshot bytes in this increment. This still qualifies UI and the declared BFF recovery fixture, not native replacement.

A rejected optional notice-view import is contained locally. The failure-first control uses the
installed Next.js App Router loader and the real shell boundary, rather than the different Pages
loader that plain test resolution selects. It reproduces one desktop-loss failure with one healthy
suppressed-current control before repair. The repaired path records body-free failure evidence,
keeps the workspace mounted, and offers the existing Updates entry and dismissal using core
translations. The final three owning suites pass 77 cases, complete UI coverage passes 10,694 cases
(one existing skip), and the original nine-case browser producer passes again in 1.3 minutes.
