# Issue intake browser evidence (#3385)

This receipt exercises the built UI against mounted production preview, task-workspace and coding
runtime routes. The fixture creates a real temporary Git repository and managed worktree. GitHub
responses, the OpenCode supervisor and model responses are deterministic test fixtures. The initial
model request must contain the accepted issue context and its untrusted-data boundary before the
scripted model may produce its edit. Gateway observations retain only booleans.

This is **production-composed deterministic evidence**, not an approved live-model run, signed
runtime qualification, release delivery proof or real GitHub publication. Both JSON receipts record
`modelQualification: false`. Screenshots contain only synthetic fixture text and temporary test
repository paths; customer issue content is not used.

## Reproduce

```sh
npm run test:e2e:coding-issue-intake
```

The command builds the workspace packages and static UI, starts the isolated BFF fixture, pairs the
browser through the existing launcher attestation route, and runs Chromium. By default generated
receipts go to gitignored `test-results/e2e-evidence/`. Refresh these tracked files deliberately:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-issue-intake
```

The lane is scheduled by `e2e-extended.yml`. It has no live provider or GitHub dependency. Its
configured fixture port must be available (override with `KEIKO_E2E_UI_PORT` for concurrent runs).

## Receipts

- `manifest.json` records screenshot hashes, UI source hashes and real-browser axe results for
  dark, light, both application high-contrast modes, `prefers-contrast`, forced colors, reduced
  motion and a 360-pixel compact window. It also checks horizontal overflow and overlapping status
  labels. The seven canonical captures show the ready preview; they do not claim later run states.
- `09-accepted.png` shows the accepted issue in the existing composer area. The browser asserts
  that the chip stays compact and clicks the actual Start control.
- `10-reloaded.png` shows the running task after a browser reload with its persisted issue binding.
- `journey-proof.json` is emitted only after all behavior assertions pass, including stopping the
  run and preserving its terminal binding. It covers refused authentication, repository mismatch,
  malicious input, stale preview, grant revocation before Start, the managed Git edit, the initial
  model-context dependency, reload, and body-free correlated activity-log records.

The header `gitHead` identifies the capture checkout's commit. `sourceHashes` identify the exact UI
bytes measured, including uncommitted implementation changes during development. A subsequent
verification checkpoint must regenerate evidence when those UI bytes change.

The axe observer is installed through Playwright's initialization hook. Product CSP remains enabled;
issue markup is rendered as text, and no inline issue script executes. The test waits for the actual
preview reveal animation to finish before measuring colors.
