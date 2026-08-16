# Issue #3185 — Health Scan refresh truth evidence

This evidence pack proves the live MemoriaViva Health Scan does not retain a prior findings count when a refresh is rate-limited or otherwise fails.

## Covered journey

The browser scenario uses the real desktop shell, dynamic MemoriaViva window, Health Scan component, themes, and keyboard handling. Only `GET /api/memory/health-scan` is intercepted with contract-shaped deterministic responses:

1. A successful scan presents one finding and its `1 findings` count.
2. Returning to MemoriaViva and reopening Health Scan simulates a refresh that returns `429 HEALTH_SCAN_RATE_LIMITED`.
3. The error alert is visible, the prior count and finding are absent, and `Retry` receives `Enter` keyboard activation.
4. A later success replaces the alert with current findings.

The route fixture is phase-based rather than call-count based. React Strict Mode may issue duplicate initial reads, and every read during the initial phase receives the same success fixture until the test deliberately changes phase; the state-transition assertion remains strict.

## Design-system and accessibility coverage

The capture set records the success and changed error/retry state in Dark, Light, Dark High Contrast, forced-colors, and a compact responsive viewport. Browser axe scans the Health Scan error/retry region in each recorded mode and gates zero serious or critical WCAG 2.0/2.1/2.2 A/AA violations.

This covers the state-matrix Error state requirement: feedback has text, a recoverable action, and does not communicate truth through a stale count or colour alone. The `Retry` button uses the existing Button focus and keyboard contract.

## Reproduce

```bash
npx playwright test tests/e2e/health-scan-3185.spec.ts --config tests/e2e/config/playwright.config.ts --project=chromium
```

Generate the tracked artifact set intentionally:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npx playwright test tests/e2e/health-scan-3185.spec.ts --config tests/e2e/config/playwright.config.ts --project=chromium
```

Issue UI-receipt command:

```bash
.keiko-scripts/ui-verify-receipt.sh 3185 -- npx playwright test tests/e2e/health-scan-3185.spec.ts --config tests/e2e/config/playwright.config.ts --project=chromium
```

Artifacts:

- `01-dark-success.png`
- `02-light-rate-limited.png`
- `03-dark-high-contrast-rate-limited.png`
- `04-forced-colors-rate-limited.png`
- `05-responsive-rate-limited.png`
- `health-scan-refresh-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`
