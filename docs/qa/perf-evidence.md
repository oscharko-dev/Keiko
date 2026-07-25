# Editor performance evidence — producer runbook (ADR-0139)

The two committed editor evidence documents live in `docs/release/`:

| Document                    | Content                                                               | PR-time validation                      |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `1209-perf-evidence.json`   | Immutable D12 baseline/candidate paired performance comparison        | `npm run check:perf-evidence:editor`    |
| `1209-bundle-evidence.json` | Editor release bundle measurement (B1/B2/B3) of the production export | `npm run check:editor-release-evidence` |

## When evidence must be regenerated

Almost never on a pull request (ADR-0139 D10). The pull-request gate
(`check:perf-evidence:editor`) validates evidence **integrity** —
canonical structure, budgets, stamps, the pinned-baseline anchor, and the D12
measurement-toolchain digest — and deliberately does **not** require the recorded source tree,
lockfile, or working tree to match HEAD. Per-PR performance protection comes from the
deterministic bundle gates (`check:editor-release-evidence`, `check:editor-bundle-size`), which
rebuild the shipped editor on every pull request.

You must regenerate in-flight only when your change edits the **measurement toolchain itself**
(the scripts listed in `scripts/d12-measurement-toolchain.mjs`) — changing the ruler requires
re-measuring with it. The regeneration wrapper validates its own output with the full
source-freshness contract (`--enforce-source-freshness`), which additionally requires exact
source-tree equality, the current lockfile, and a clean subject working tree.

The scheduled workflow `nightly-perf-evidence` re-measures `dev` every night and opens a bot
pull request when the committed documents drifted, so timing evidence lags `dev` by at most one
nightly cycle and corrects itself without agent involvement.

## How to regenerate (one command)

```bash
npm run perf:evidence:regen
```

On Linux this provisions two clean checkouts (pinned baseline `18750d079e2a61c7d7044f3f6ec977a104b9884f`, candidate = your
HEAD), runs the official D12 producer (warm-ups, six alternating Common runs, three cap runs, at full
sample depth via `KEIKO_D12_FULL_SAMPLE_DEPTH=1`), refreshes the bundle
evidence from a fresh production build, validates everything with the independent checker, and
copies both documents back — review and commit them as your final commit (the documents are not
subject paths, so committing them does not invalidate what they bind).

On macOS/Windows the command fails closed and prints the pinned container invocation
(`node:24.18.0-bookworm`, `--privileged` for Bubblewrap, Playwright Chromium). A bind mount
installs Linux binaries into the mounted repo's `node_modules` — irrelevant with the recommended
throwaway clone below; only after mounting your working checkout directly re-run `npm install`.

**Container prerequisites (hard-won, all real):**

- **Full, non-worktree checkout.** In a git worktree, `$PWD/.git` is a file pointing at the main
  repository and the container cannot resolve it. Make a self-contained clone first —
  `git clone --no-local . <dest>` — and mount that alone; the pinned baseline commit must be
  present (`git merge-base --is-ancestor 18750d079e2a61c7d7044f3f6ec977a104b9884f HEAD`). Name the clone directory `*.noindex`
  so Spotlight does not index-storm the host during the run.
- **Single occupancy.** Measurement is exclusive: before starting, check
  `docker ps` for any other `node:24*` measurement container (other agents measure too) and do
  not run builds/tests/gates on the host for the duration. A budget verdict measured on a loaded
  host is an environment verdict, not a product regression — fix the load, not the code. Since
  ADR-0156 D5 the run still completes and writes its document, so you can read the numbers and
  decide; before that, an overrun destroyed the evidence that would have shown it.
- **VM sizing (macOS Docker Desktop).** The default VM allocation (~8 GiB) is marginal for the
  cap budgets; the dev machine's VM is configured at 48 GiB / 14 CPUs
  (`~/Library/Group Containers/group.com.docker/settings-store.json`: `MemoryMiB`, `Cpus`).

**Known lane status:** free hosted runners have measured the stopped-projection cap above its
200 ms budget (250.4 ms, later 256.9 ms). Until ADR-0156 that overrun aborted the producer, so the
lane published nothing and every pull request touching a measurement-toolchain file was stranded on
evidence that could not be refreshed. The lane now measures, writes its document, names the verdict,
and lets the gate reject it on the resulting pull request — a single named regression instead of a
dead lane. Whether the reference environment itself needs a decision is
[#2587](https://github.com/oscharko-dev/Keiko/issues/2587); the current overrun is tracked as
[#2695](https://github.com/oscharko-dev/Keiko/issues/2695). The PR lane is unaffected either way.

## Invariants

- Baseline and candidate each bind their own commit-exact `package-lock.json` digest; the producer
  provisions both checkouts with `npm ci --ignore-scripts` under a deterministic environment
  allowlist. A dependency change is therefore measured as part of the candidate instead of making
  evidence generation impossible or silently substituting dependency state.
- Budgets are enforced in exactly one place: `check-perf-evidence.mjs`, reading the committed
  document on every pull request (ADR-0156 D1/D5). Measurement lanes — this one and the scheduled
  workflow — measure and record; they never abort on a budget verdict, because the document that
  would report the regression must survive it. A failure that says the measurement cannot be
  trusted still aborts the producer, and a defect never rides along with a verdict.
- Never hand-edit the documents: schemas are exact-key closed, canonical-byte checked, and every
  aggregate is independently recomputed from the raw samples.
