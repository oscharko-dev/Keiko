# Editor performance evidence — producer runbook (ADR-0139)

The two committed editor evidence documents live in `docs/release/`:

| Document                    | Content                                                               | PR-time validation                      |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `1209-perf-evidence.json`   | Immutable D12 baseline/candidate paired performance comparison        | `npm run check:perf-evidence:editor`    |
| `1209-bundle-evidence.json` | Editor release bundle measurement (B1/B2/B3) of the production export | `npm run check:editor-release-evidence` |

## When evidence must be regenerated

Evidence binds the **measured product surfaces** only (ADR-0139 D2): `packages/keiko-editor/`,
`packages/keiko-ui/`, `packages/keiko-server/src/editor/`, `packages/keiko-contracts/`, `src/`,
the root `package-lock.json`, and `tsconfig*` — excluding test-only files and `package.json`
script/metadata churn — plus the dedicated D12
measurement-toolchain digest. If your change touches none of those, committed evidence stays
valid; repository tooling, workflow, docs, and test-only changes never require regeneration.

The scheduled workflow `nightly-perf-evidence` re-measures `dev` every night and opens a bot
pull request when the committed documents drifted, so accumulation drift corrects itself without
agent involvement.

## How to regenerate (one command)

```bash
npm run perf:evidence:regen
```

On Linux this provisions two clean checkouts (pinned baseline `18750d07…`, candidate = your
HEAD), runs the official D12 producer (warm-ups, six alternating Common runs, three cap runs,
wall-clock budgets enforced via `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1`), refreshes the bundle
evidence from a fresh production build, validates everything with the independent checker, and
copies both documents back — review and commit them as your final commit (the documents are not
subject paths, so committing them does not invalidate what they bind).

On macOS/Windows the command fails closed and prints the pinned container invocation
(`node:24.18.0-bookworm`, `--privileged` for Bubblewrap, Playwright Chromium). A bind mount
installs Linux binaries into `node_modules`; re-run `npm install` on the host afterwards.

## Invariants

- Baseline and candidate each bind their own commit-exact `package-lock.json` digest; the producer
  provisions both checkouts with `npm ci --ignore-scripts` under a deterministic environment
  allowlist. A dependency change is therefore measured as part of the candidate instead of making
  evidence generation impossible or silently substituting dependency state.
- Wall-clock budgets are enforced only in this controlled context and in the scheduled workflow
  (ADR-0139 D1); required CI runners record but do not assert them. The committed comparison
  still enforces every budget deterministically at PR time.
- Never hand-edit the documents: schemas are exact-key closed, canonical-byte checked, and every
  aggregate is independently recomputed from the raw samples.
