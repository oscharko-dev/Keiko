# Issue #3186 — Quality Intelligence degraded terminal truth

This evidence set proves that persisted model-stage failures are presented consistently as a
degraded terminal outcome in the Quality Intelligence run list, run detail, and live launcher.

Regenerate on Node 24 with:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npx playwright test \
  tests/e2e/quality-intelligence-3186.spec.ts \
  --config tests/e2e/config/playwright.config.ts \
  --project=chromium
```

The browser journey captures dark and light screenshots and runs axe-core over the complete seeded
workspace. The JSON proofs bind the captures to the contracts, server projection, and UI source
files by SHA-256; `manifest.json` records the exact journey and assertions. Fixtures contain only
synthetic ids, counts, and redaction-safe reason codes.
