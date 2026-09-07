# Performance evidence — producer runbook (ADR-0139)

The committed performance evidence documents live in `docs/release/`:

| Document                                 | Content                                                               | PR-time validation                           |
| ---------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `1209-perf-evidence.json`                | Immutable D12 baseline/candidate paired performance comparison        | `npm run check:perf-evidence:editor`         |
| `1209-bundle-evidence.json`              | Editor release bundle measurement (B1/B2/B3) of the production export | `npm run check:editor-release-evidence`      |
| `1580-workspace-perf-evidence.json`      | Workspace browser-performance measurement                             | `npm run check:perf-evidence:workspace`      |
| `2952-coding-runtime-calibration.json`   | Frozen native coding-runtime reference samples and provenance         | `npm run check:perf-evidence:coding-runtime` |
| `2952-coding-runtime-perf-evidence.json` | Native coding-runtime candidate measurements                          | `npm run check:perf-evidence:coding-runtime` |
| `3415-tool-catalog-calibration.json`     | Frozen tool-catalog reference samples and provenance                  | `npm run check:tool-catalog-performance`     |
| `3415-tool-catalog-perf-evidence.json`   | Tool-catalog candidate compiler and lookup measurements               | `npm run check:tool-catalog-performance`     |

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
re-measuring with it. The gate that judges the evidence (`scripts/perf-evidence-gate.mjs`, behind
`check:perf-evidence*`) is deliberately **not** a digest member: the ruler lives in
`check-perf-evidence.mjs`, the judge imports it, and editing the judge — a log sink, an exit code,
a usage string — costs no re-measurement. That separation exists because the opposite was measured:
three gate-only edits in one day each invalidated a 35-minute measurement they could not have
influenced. The regeneration wrapper validates its own output with the full
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

### Workspace browser-performance evidence

The workspace measurement has its own toolchain digest, defined by
`scripts/workspace-performance-measurement-toolchain.mjs`. A change to any listed member requires
a fresh workspace measurement; a mismatched digest is always rejected so an evidence document cannot
be re-stamped without running the producer.

**Its reference environment is Linux**, and that is evidenced rather than asserted: `ci.yml`
refreshes this document on every `push` to `dev` (`ubuntu-latest`) and only _validates_ its freshness
on a pull request. A pull request that moves the workspace ruler must therefore bring a
Linux-produced document with it; nothing else makes `check:perf-evidence:workspace` green.

Unlike the editor D12 document, this one records no per-machine provenance and its budgets carry
wide headroom — it is a browser-performance regression detector, not an absolute instrument
calibrated to one machine class. That is why `ubuntu-latest` and the pinned `arm64` container are
both acceptable producers, and why a macOS host is not: the harness serves the packaged CLI through
Chromium, which is what CI exercises.

One command, from any host with Docker. It provisions the self-contained clone, runs the pinned
container, and copies the document back:

```bash
npm run perf:evidence:regen:workspace
```

Equivalent when you are already on Linux with the dependencies installed:

```bash
rm -f docs/release/1580-workspace-perf-evidence.json
npm run test:e2e:workspace-perf
```

Deleting first is part of the contract, not tidiness: the gate rejects a stale extra project entry,
so a re-measurement must not be able to silently narrow the committed run set.

The committed document has an exact, intentionally Chromium-only run set: `chromium` and
`chromium-mixed-windows`. The first is the representative workspace journey and the second proves
the heavy-widget fixture. `webkit` remains a local cross-browser functional aid, but is deliberately
not committed as timing evidence: its headless renderer does not produce comparable frame-gap or
write-coalescing measurements, and CI installs and runs Chromium only. The gate rejects both a
missing required run and an additional stale project entry, so deleting the prior document before
the Chromium producer cannot silently narrow the evidence contract.

Commit the resulting document as the final change that moves the workspace measurement ruler.

## Tool-catalog compiler evidence (#3415)

This target measures the shipped tool-catalog producer through its built package. It covers the
legacy native profile and a 300-tool synthetic profile, the largest stable fixture below the
producer's 262,144-byte catalog bound. A separate 320-tool fixture must be rejected with
`input-bound`. Each case retains two warmups and then thirty samples. Lookup work is bounded by
6,000 comparisons per sample, so the normal pull-request gate proves complete work without using a
host-dependent timeout as a performance threshold.

The committed calibration and candidate use the same percentile and budget policy as the native
coding-runtime target: nearest-rank p95 with a ceiling of the calibration maximum plus its full
observed range. The evidence binds the tool-catalog source tree, lockfile, and the five scripts that
form its measurement ruler. `npm run check:tool-catalog-performance` runs a fresh deterministic
work check on every invocation, then evaluates the committed reference evidence. Fresh local or CI
wall-clock values are reported for diagnosis and are never compared with the reference threshold.

The reference environment is the pinned Linux arm64 Node image below with at least 14 logical cores.
Create a self-contained clone at the exact source revision first; do not mount this repository's
`node_modules` into the container. The image identity is supplied both to Docker and to the producer,
which records and validates it. The producer writes the calibration, derived budget, and candidate
before returning any performance verdict, so a slow run cannot destroy its evidence.

```bash
git clone --no-local . /tmp/keiko-3415-performance.noindex
docker run --rm --platform linux/arm64 --cpus=16 --memory=20g \
  -e KEIKO_TOOL_CATALOG_REFERENCE_IMAGE=node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 \
  -v /tmp/keiko-3415-performance.noindex:/repo -w /repo \
  node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 \
  bash -lc 'npm ci --no-audit --no-fund && npm run build:packages && node scripts/check-tool-catalog-performance.mjs --write-reference'
```

Copy these three canonical files back from the disposable clone and run the gate again in the
working checkout:

```bash
cp /tmp/keiko-3415-performance.noindex/docs/release/3415-tool-catalog-{calibration,perf-evidence}.json docs/release/
cp /tmp/keiko-3415-performance.noindex/scripts/tool-catalog-performance-budget.json scripts/
npm run check:tool-catalog-performance
```

This is functional compiler and lookup performance evidence. It does not qualify provider latency,
live-model behavior, or production customer workloads.

## How to regenerate (one command)

```bash
npm run perf:evidence:regen:container
```

Run it whenever you decide to — it starts immediately. It provisions the self-contained clone,
runs the pinned container against it, and copies both documents back for you to review and commit.
Give it a machine that is yours for the duration (see **Single occupancy** below); a busy host does
not produce a slower number, it produces a broken run.

On Linux you can also drive the producer directly, without the container:

```bash
npm run perf:evidence:regen
```

On Linux this provisions two clean checkouts (pinned baseline
`18750d079e2a61c7d7044f3f6ec977a104b9884f`, candidate = your HEAD), runs the official D12 producer
(warm-ups, six alternating Common runs, three cap runs, at full sample depth via
`KEIKO_D12_FULL_SAMPLE_DEPTH=1`), refreshes the bundle
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
  `git clone --no-local . <dest>` — and mount that alone. The wrapper fetches the exact pinned
  baseline commit when needed; it may be a squash-only foreign commit, so Git ancestry is not the
  trust anchor. Commit identity, clean checkouts, source-tree digests, lockfile digests, and the
  independent evidence checker are. Name the clone directory `*.noindex` so Spotlight does not
  index-storm the host during the run.
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

The editor invariants in this section retain their existing ruler. The coding-runtime target's
distinct native procedure follows below.

- Baseline and candidate each bind their own commit-exact `package-lock.json` digest; the producer
  provisions both checkouts with `npm ci --ignore-scripts` under a deterministic environment
  allowlist. A dependency change is therefore measured as part of the candidate instead of making
  evidence generation impossible or silently substituting dependency state.
- The pinned baseline is exact by commit and digest, not by being an ancestor of the candidate.
  This keeps the same reference usable after squash-only integrations while still refusing a dirty
  checkout or a document whose baseline digest no longer matches the pinned commit.
- Budgets are enforced in exactly one place: `scripts/perf-evidence-gate.mjs` (`npm run check:perf-evidence`), reading the committed
  document on every pull request (ADR-0156 D1/D5). Measurement lanes — this one and the scheduled
  workflow — measure and record; they never abort on a budget verdict, because the document that
  would report the regression must survive it. A failure that says the measurement cannot be
  trusted still aborts the producer, and a defect never rides along with a verdict.
- Never hand-edit the documents: schemas are exact-key closed, canonical-byte checked, and every
  aggregate is independently recomputed from the raw samples.

## Native coding-runtime evidence (#2952)

This target covers the coding-runtime portion of #2952. Atlassian sync and connector-window
performance require their own target and calibration; these numbers do not qualify that surface.

The producer reuses the existing canonical artifact bytes, nearest-rank percentile calculation,
byte-framed measurement digest, governed host-executable lookup and diff-owned freshness policy.
It discovers the approved OpenCode payload through the production dev lane, creates a real local
Git repository and managed task workspace for each sample, pairs through the real launcher
attestation, and exercises the mounted BFF. The only substituted execution is a deterministic model
response: 64 chunks of 32 ASCII characters, one gateway call, no tool requests. The exact 2,048
characters must arrive in the protected activity channel. No prompts, responses, paths, endpoints,
bearers, raw CPU model names or customer content are written to the evidence.

| Metric                | Start                       | End                                          | What it proves                                                                                        |
| --------------------- | --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `coldStartMs`         | Authenticated run POST      | Parsed running snapshot                      | Fresh sidecar process, production admission and native readiness handshake, initial turn accepted     |
| `readinessMs`         | Readiness GET               | Parsed available projection                  | Preflight route with its honest functional evidence class                                             |
| `sseFirstByteMs`      | Runtime event-stream GET    | First nonempty SSE data frame                | Mounted stream's time to first data, including initial state replay; not model-token latency          |
| `boundedThroughputMs` | First fixture gateway delta | Observed successful native terminal snapshot | Completion of a fixed 2,048-character streamed workload; exact delivered output is checked separately |

Terminal observation polls every 5 ms and therefore includes that bounded sampling quantization.
For interpretation, throughput in characters/second is `2048 * 1000 / boundedThroughputMs`; the
judge uses duration of the fixed workload so all four ceilings share the same direction. The
60-second operational deadline is a deadlock/invalid-measurement bound, not the performance budget.
Two warmups are discarded, followed by three contiguous groups of ten retained samples. Each has
fresh runtime state and a new sidecar; the BFF module process remains warm and OS caches are not
flushed. Neither retries nor outlier deletion are permitted.

The reference is native **macOS arm64**, with exact comparability to the committed calibration's
environment: kernel release, core count, memory, hashed CPU model, Node/npm/Git versions, approved
runtime version, executable digest and secure-read helper digest. There is no claim that this
developer machine is a named CI worker. Linux editor timings and hosted runner results are
incompatible and must not be substituted, even if they are faster. As with the D12 reference,
reserve the host for one measurement: stop other benchmark containers and wait for builds, tests,
coverage and analyzers to finish before starting. Keep that quiet window through both runs.

From a clean checkout on that reference:

```sh
npm ci
npm run build:packages
npm run dev:coding-runtime:stage
npm run perf:evidence:coding-runtime
npm run check:perf-evidence:coding-runtime -- --enforce-source-freshness
```

Use the pinned Node 24.18.0/npm 11.16.0 installation. Staging uses the existing approved-payload
downloader/verifier and builds the secure-read helper; production discovery checks their integrity
again for the measurement. The producer compiles the existing test-only production-composition
support before collecting samples. Source, ruler and environment stamps must remain equal before
and after sampling. Dirty measured files or ruler inputs refuse generation, including new untracked
production files; unrelated documentation changes do not invalidate the subject.

Initial calibration is a separate operation:

```sh
npm run perf:evidence:coding-runtime -- --calibrate
npm run perf:evidence:coding-runtime
npm run check:perf-evidence:coding-runtime -- --enforce-source-freshness
```

`--calibrate` refuses to overwrite an existing calibration or budget. It writes
`docs/release/2952-coding-runtime-calibration.json` and
`scripts/coding-runtime-performance-budget.json`. For each metric, the reviewed policy is
`maximumP95Ms = observed maximum + (observed maximum - observed minimum)` across the thirty samples.
This empirical regression allowance is derived before seeing candidate results. It is not an SLO
or a statistical confidence interval. The budget anchors the calibration's whole-document digest;
the judge independently re-derives both percentiles and ceilings. Calibration and candidate must
also carry the same ruler digest: a changed measurement definition requires an explicitly reviewed
calibration run, not just a candidate measured against incompatible old thresholds. Ordinary generation only writes
`docs/release/2952-coding-runtime-perf-evidence.json`. To change the reference class or the calibration,
review the reason explicitly and remove the old calibration/budget as part of that change; never
recalibrate simply to erase a regression.

The PR lane runs `check:perf-evidence:coding-runtime` and the hermetic ruler tests
(`test:perf:coding-runtime`). It checks integrity and budgets unconditionally. Set
`KEIKO_PERF_EVIDENCE_BASE_REF` to the PR/merge-group base for diff-owned toolchain freshness, as for
the editor target; an absent or unresolvable base checks the ruler rather than skipping. A change
only to unrelated package metadata does not move the bound producer command. The reference/release
lane adds `--enforce-source-freshness`. Scheduled hosted checks add
`--enforce-source-freshness --report-subject-drift`: source-tree and candidate-lockfile drift are
evaluated and reported as advisories under ADR-0162; ruler drift, dirty inputs, malformed evidence
and budget overruns still fail. The advisory flag is refused without full source evaluation.
Scheduled checks must not run the native producer or compare their clocks.

Trustworthy budget overruns are written, then rejected by the separate judge. Missing/invalid
samples, a changed source, incomplete output, a tampered calibration or a foreign environment are
measurement defects and do not produce candidate evidence. The emitted class is
`functional-performance-not-platform-qualified`: these controlled provider calls are neither an
approved live-model qualification nor platform-signature or release-closeout evidence.
