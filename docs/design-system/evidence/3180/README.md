# Issue #3180 — German Prompt Enhancer intent evidence

This evidence pack proves the current-Dev Prompt Enhancer keeps a German knowledge-management
decision request separate from factual decision questions and genuine travel requests.

## Chrome Computer Use evidence

The captures were produced at source commit `c61908df56a54d073b59f347aae381bca4734490`
through the visible Keiko UI in Google Chrome. No product API was called directly and the
deterministic-only enhancement mode used no paid model.

- `01-km-decision-light.png`: the exact audited prompt resolves to `decision support` in Light mode.
- `02-km-decision-dark.png`: the same prompt and role remain visible in Dark mode.
- `03-factual-question-dark.png`: `Was war die Entscheidung über …?` resolves to factual QA and the
  careful, accurate assistant role.

The visible travel counterexample was also exercised with
`Plane eine Reise nach Japan; berücksichtige Alternativen und eine Entscheidungstabelle für das
Budget.` and rendered the expert travel-planner role. The rerunnable Playwright plan below pins
that outcome.

## Rerunnable browser proof

From the repository root with Node 24 and the Playwright Chromium dependency installed:

```bash
npx playwright test tests/e2e/prompt-enhancer-3180.spec.ts \
  --config tests/e2e/config/playwright.config.ts --project=chromium
```

Issue receipt command:

```bash
.keiko-scripts/ui-verify-receipt.sh 3180 -- \
  npx playwright test tests/e2e/prompt-enhancer-3180.spec.ts \
    --config tests/e2e/config/playwright.config.ts --project=chromium
```

The plan drives the running product UI and asserts all three intent boundaries. The change adds no
CSS, component tokens, layout, or interaction states; the screenshots therefore document the
existing governed Prompt Enhancer surface rather than introduce a new visual baseline.

## Evidence boundary

All inputs are deterministic synthetic audit fixtures. The captures and test contain no customer
data, credentials, provider output, private paths, or external network traffic.
