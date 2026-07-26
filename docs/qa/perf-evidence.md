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

The scheduled workflow `nightly-perf-evidence` asks that same deterministic question against `dev`
every night. It does not re-measure and does not open a bot pull request: only the reference
environment below can produce comparable numbers, so drift detection is automatic and repair is a
deliberate local run (ADR-0156 D6).

It files a tracking issue only for drift a re-measurement repairs for good — a moved measurement
toolchain, an unsound document, a broken pinned anchor, a missing stamp, a dirty subject tree, a
budget overrun (ADR-0162). It does **not** fail for the measured subject having moved on: that is
what every merge into `packages/keiko-editor/`, `packages/keiko-ui/`, `packages/keiko-contracts/`,
`packages/keiko-server/src/editor/`, `src/` or the root lockfile does, and the next such merge
undoes any repair. That finding is reported in the run's job summary instead, where it says how far
the committed numbers have travelled from the product without pretending anyone owes work for it.

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

**Reference environment.** These budgets are absolute numbers, calibrated on the pinned container as
run on a developer machine: `platform: linux`, `architecture: arm64`, >=14 logical cores. Every
committed editor evidence document records exactly that, and each one carries its own provenance so
the claim is checkable rather than folklore. A hosted GitHub runner is x86_64 with 4 logical cores;
the same stopped-projection scenario measures 250-257 ms there against a 200 ms budget. That gap is a
machine class, not a regression — across two weeks and eighteen documents, including the M11 merge,
the reference environment measured 122.8-142.2 ms. Nothing needs to assert the environment: a
document measured on an under-provisioned machine fails its own budget check, so the requirement is
self-enforcing. Changing the reference class is
[#2587](https://github.com/oscharko-dev/Keiko/issues/2587).

**Scheduled lane.** `nightly-perf-evidence` detects drift; it does not measure (ADR-0156 D6). It runs
the deterministic freshness contract — digests, plus every budget re-derived from the committed
samples — and files a tracking issue naming this command when the committed evidence stops holding
on `dev`. It used to run the full producer on a hosted runner, which failed 12 of 12 times and
published nothing. Repair is yours to run here.

To ask the same question locally, exactly as that lane asks it:

```bash
npm run check:perf-evidence:editor -- --enforce-source-freshness --report-subject-drift
```

Drop `--report-subject-drift` to get the regeneration wrapper's stricter reading, where the measured
subject having moved on is fatal too — which is what you want right after producing evidence, and
misleading anywhere else.

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
