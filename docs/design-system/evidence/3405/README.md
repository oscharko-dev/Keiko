# Updater reliability evidence — #3405 / #3403

The browser evidence proves that the startup notice yields only while a visible, foreground
**ready** Update window owns the same critical context and actions. The notice returns when that
window is backgrounded or minimized and remains available while the foreground updater is loading
or contains only a load error. Keyboard modality is established with a real Tab press before moving
focus; programmatic focus after a pointer click must not steal the foreground.

This set was regenerated on 2026-10-10 from PR #3913 signed source head
`a37fd7d245193022bc505e6c005b091c84af1c30` in an isolated macOS arm64 checkout using Node 24.21.0,
npm 11.19.0, Next.js 16.3.8, and Playwright 1.63.0. The unchanged eight-test Chromium suite passed
in 56.4 seconds, including the real-BFF outage journey. The unchanged evidence freshness gate and
its three focused contract controls also passed. All eight UI source hashes and four harness
hashes match that inspected source head.

The original producer recreated all 17 tracked artifacts: 14 screenshots and three JSON records.
`10-responsive-manual-path.png`, `11-progress-state.png`, and `13-reconnecting-state-mocked.png`
changed PNG bytes relative to the previous committed set; the other 11 screenshots remained
byte-identical. All three JSON records now bind the actual inspected
sources. This is macOS browser and fixture qualification; it does not claim Linux execution,
production update success, native N−1→N replacement, or final integrated-head acceptance.

The current suite includes the real-BFF outage journey. Both the main server and the outage
harness use isolated copies of the fake-key gateway fixture, preserving the tracked source
through normal CLI credential migration and subsequent restarts.

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
