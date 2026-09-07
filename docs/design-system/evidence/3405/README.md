# Updater reliability evidence — #3405 / #3403

The current 320px repair evidence was regenerated on 2026-09-07. The Chromium visual-evidence
test passed **1/1** and refreshed all tracked artifacts. It proves the startup notice yields only
while a visible, foreground Update window owns the same critical context and actions; the notice
returns when that window is backgrounded or minimized.

The separately replayed real-BFF outage test passed **1/1 in 59.8 seconds**. A preceding combined
six-test run was interrupted after its first three tests while the fourth test had completed its
browser operations but did not tear down; it is not represented as a complete suite result.

## Reproduce

Use the supported Node 24 runtime and the checkout's own dependencies:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:update-ui-1696
```

The retained command name now captures this directory, not historical #1696. Run only one owner
against the suite's configured port/build tree. The required CI subset is:

```bash
npm run test:e2e:update-ui-1696 -- --grep @real-bff-outage
```

## Evidence and limits

- [Manifest](manifest.json): 14 screenshots, the proof documents, and eight current UI source hashes.
- [Fidelity proof](update-experience-fidelity-proof.json): seven canonical modes, responsive/manual,
  progress, critical notice, portable eligibility, reconnect and remediation captures.
- [Accessibility proof](a11y-proof.json): axe-core 4.12.1 reported no violations in its 12 recorded
  captures; the suite also asserts English/German control, focus and polite-live-region parity.
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
