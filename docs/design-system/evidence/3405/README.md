# Updater reliability evidence — #3405 / #3403

The current repair evidence was regenerated on 2026-10-07 from PR #3876 head
`1fbaf9a83890375150faf9137a9d5b80c2711a43` after two localization keys for the Coding Workbench's
gateway-retry activity labels (`activity.event.modelGatewayRetrying`, `activity.event.modelGatewayRecovered`)
changed `i18n-messages.de.ts` and `i18n-messages.en.ts`, two of the eight bound sources. No updater
behavior changed. All eight Chromium checks passed on the macOS arm64 checkout on Node 24.21.0,
including the real-BFF outage journey, and the evidence freshness gate passed. The previous
regeneration (2026-10-05, PR #3687 head `8b8f92e7dabcb3ae5b62f52cce6d2aa6149ef798`) followed shared UI API and
localization changes that made the earlier source hashes stale. No updater behavior changed. All eight Chromium checks passed in an
isolated Linux/amd64 checkout on Node 24.18.0, including the real-BFF outage journey. The unchanged
producer refreshed all 17 tracked artifacts, and the evidence freshness gate passed. The eight
source and four harness hashes match the current checkout. The tests prove the startup notice yields only while a visible, foreground **ready**
Update window owns the same critical context and actions; the notice returns when that window is
backgrounded or minimized, and remains available while the foreground updater is loading or
contains only a load error. The background-window check establishes keyboard modality with a real
Tab press before moving focus; programmatic focus after a pointer click must not steal the foreground.

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
