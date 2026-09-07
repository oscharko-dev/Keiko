# Generic Workbench description draft browser evidence (#3401)

This directory holds visual and journey proof for a generated Workbench description that has no
pull-request target. The production UI displays the exact server-held artifact and keeps the newer
proposal visible when an older review response arrives after the run advances to a new head.

## Producer

The same serial browser spec captures sibling surfaces #3389, #3400, and #3401:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:git-change-chat
```

The Playwright config builds the packaged CLI and static UI, then runs Chromium with one worker.
The #3401 fixture supplies deterministic lower-boundary runtime and retained-artifact responses,
including a healthy task-workspace binding and its restore-time reconciliation. It supplies no PR
target. Ordinary runs write under the ignored `test-results/e2e-evidence/` directory; the environment
variable above intentionally refreshes these checked-in artifacts.

## Receipts

- `01-dark.png` through `08-compact.png` cover dark, light, both high-contrast themes, increased
  contrast, forced colors, reduced motion, and the 360 px compact viewport.
- `09-response-race-current.png` records the exact newer draft after the older response is released.
- `visual-proof.json` records screenshot hashes, source hashes, browser axe results, and overflow
  results for every mode.
- `journey-proof.json` records one old and one new draft read, the runtime status/stream evidence,
  the absence of a PR target, the exact current markdown observation, and rejection of the late old
  response.

The receipts classify this as `production-ui-deterministic-browser-fixture`; they explicitly set
`modelQualification` and `liveAuthenticationQualification` to `false`. The exact capture time is
their `checkedAt` value. Re-run the producer on the final head whenever any recorded source hash
changes. Screenshots contain synthetic fixture text only (`rawContentRecorded: false`).
