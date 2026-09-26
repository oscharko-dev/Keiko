# Local gate environment

A committed container that reproduces the Linux gate environment, so the checks that most often
turn required CI red can be run before pushing instead of discovered a full CI cycle later.

Available to every contributor and every agent working in this repository — same image, same
versions, no local setup beyond Docker.

## Why this exists

Over the twelve most recent failing CI runs the causes were:

| Cause                    | Runs | Reproducible locally  |
| ------------------------ | ---: | --------------------- |
| SonarCloud findings      |    5 | partially (see below) |
| D12 performance evidence |    4 | yes — see below       |
| Dependency audits        |    4 | yes                   |
| Release smoke E2E        |    2 | yes                   |
| Coverage quality gates   |    2 | yes                   |
| UI typecheck             |    1 | yes                   |

A full required-CI cycle costs roughly 123 weighted runner-minutes. Finding a lint error, a
typecheck break or a smoke regression there rather than here wastes a cycle per attempt.

## Usage

```bash
npm run gates:local          # cheap deterministic gates + the local-only #3347 micro-benchmark
npm run gates:local:tests    # + unit and UI suites with coverage
npm run gates:local:e2e      # + release smoke E2E (downloads chromium on first run)
npm run gates:local:full     # + build, static export, package surface
npm run gates:local:shell    # interactive session in the same environment
```

The container runs as the image's non-root `node` user. If you used an earlier build, its named
volumes are root-owned and `npm ci` inside will fail with `Permission denied`; recreate them once
with `docker compose -f docker/gates/docker-compose.yml down -v`.

The first run builds the image and installs the workspaces into a named volume; later runs reuse
both. `node_modules` deliberately lives in that volume rather than a bind mount: a macOS host tree
and a Linux container cannot share one install without swapping platform-native binaries under each
other.

## Git worktrees

A linked worktree's `.git` is a file pointing at the parent checkout, which is outside the mount, so
git inside the container cannot resolve it. The suite detects this, says so, and skips only the
gates that read the git index; everything else runs normally. Run those few from a normal clone, or
add the parent checkout as a second mount.

## What is authoritative here — and what is not

**Reliable in this container.** Anything deterministic: type checking, linting, formatting,
architecture rules, ADR index, dependency hygiene, the waiver-scope gate, `npm audit` over the
shipped graph, unit and UI suites, the release smoke E2E, builds and the package surface. These
behave identically to CI because they depend on the source tree, not on the machine.

The **coverage ratchet** is deterministic too, but it is not in the list above, because it is
evaluated exactly once against all three suites' summaries at once (ADR-0158 D2) and this container
deliberately does not run the twenty-minute package suite. Run it where its inputs exist:
`npm run test:coverage:quality` measures all three suites and then judges them in one pass. What
each ruler answers is in [`coverage-truth-model.md`](coverage-truth-model.md).

**Not authoritative here.**

- **D12 wall-clock performance evidence — not because it cannot be produced here, but because it is
  produced somewhere else.** The declared reference environment for those budgets is the pinned
  `node:24.18.0-bookworm` container on a developer machine: linux/arm64, >=14 logical cores. Every
  committed evidence document was measured there, and no hosted runner matches it. Use
  `npm run perf:evidence:regen` (which refuses to run outside that container and prints the exact
  `docker run` line), not this suite, and not a `workflow_dispatch` of the scheduled lane — that lane
  detects drift and no longer measures. See [`perf-evidence.md`](perf-evidence.md).
- **SonarCloud's duplication and hotspot metrics.** Need `SONAR_TOKEN` and the hosted analysis.
  Its **rule engine** and its **new-code coverage condition** are not — `npm run check:coverage:new-code`
  computes the same metric here, from the same LCOV artefacts, against the same threshold pinned in
  `sonar-quality-gate-contract.mjs`, and names the exact uncovered lines. Run it before pushing:
  arriving at SonarCloud to learn that a diff is under the coverage bar is a wasted CI cycle, and
  the answer was always available locally. `npm run check:sonar-rules` does the same for the rules —
  `eslint-plugin-sonarjs` carries 279 of SonarCloud's rules, layered on this repository's own ESLint
  configuration and scoped to the files the branch changed, matching Sonar's new-code period. It is
  not the complete analyser — SonarCloud implements some rules server-side only (S7781 among them) —
  so a clean local run is a strong signal, not a guarantee. It does cover the classes that have
  actually blocked us: cognitive complexity (S3776), super-linear regexes (S8786), and executables
  resolved through `PATH` (S4036).
- **Windows and macOS smoke.** A Linux container cannot answer them.
- **Build provenance attestations.** Require the workflow's OIDC identity.

`KEIKO_LOCAL_GATE_CONTAINER=1` is set inside the container so nothing downstream mistakes a local
run for authoritative measurement evidence.

## Local-only workspace-pattern micro-benchmark

The relocated #3347 S8786 regression pin deliberately stays out of ordinary required Vitest runs:
those runs verify the adversarial blocked-slash shape behaviorally, while a shared runner must not
decide an authoritative wall-clock budget (ADR-0139 D1). The local gate container's `fast` suite
(and therefore its `tests`, `e2e`, and `full` supersets) runs the focused pin on purpose. This is the
version-pinned local Linux developer-machine pre-flight path; it standardizes Linux userland but
neither controls host CPU contention nor supplies reference-hardware evidence. It is not wired into
`npm test` or a hosted required workflow.

On an idle machine, run the container-owned check with `npm run gates:local`. To repeat only this
micro-benchmark from an already controlled environment, use:

```bash
npm run check:grounded-workspace-pattern-performance
```

The command builds the workspace packages, launches only
`grounded-orchestrator.workspace-pattern.test.ts`, and sets
`KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1` for that child process. It does not turn wall-clock assertions
on for the rest of the suite. Its scope is deliberately narrow: it enforces a consolidated,
strengthened 1000 ms ceiling for both workspace-pattern helpers on the 320k adversarial blocked-slash
input. It is not D12 evidence, not evidence about end-to-end grounded-retrieval latency, and not a
substitute for `npm run perf:evidence:regen` on the declared D12 reference architecture. The
container continues to
set `KEIKO_LOCAL_GATE_CONTAINER=1`, so no generated evidence can mistake this pre-flight for the
official performance producer.

## What a macOS host cannot answer — and where the suite will not tell you

The section above is about what this container cannot answer. The reverse gap is sharper, because it
is silent: a suite that skips on your platform reports as green.

**Governed debugging (DAP) has Linux-only coverage.** Two tests in
`packages/keiko-server/src/editor/dap/dapProductionService.test.ts` drive the real namespace sandbox
backend and are `skipIf(process.platform !== "linux")`. On macOS they do not execute — `18 passed |
2 skipped` — and #2643 is what that costs: a production launch failure (`INVALID_CAPSULE_PLAN` in
layer-2 validation, from a workspace-identity digest formula that drifted from its producer) that
both tests caught on Linux CI while every local run stayed green. Their titles now carry
`[linux-only: namespace sandbox]` so the skip names its own reason.

Run them where they run, in about two seconds once the image is warm:

```bash
git clone --no-local --no-hardlinks . /tmp/keiko-dap
docker run --rm -v /tmp/keiko-dap:/repo -w /repo node:24.18.0-bookworm bash -lc '
  git config --global --add safe.directory "*"
  apt-get update -qq && apt-get install -y -qq bubblewrap
  npm ci --no-audit --no-fund && npm run build:packages
  npx vitest run packages/keiko-server/src/editor/dap/dapProductionService.test.ts'
```

Clone fully rather than shallowly — a shallow clone loses the baseline the suite reads.

**No `--privileged`.** The recipe #2643 was diagnosed with carried it; the suite does not need it —
all 20 tests pass on Docker Desktop with no added capabilities at all, measured before this line was
written. It matters because this command runs `npm ci`, the package build and the suite **as root
over a working tree**: with `--privileged` a hostile checkout is one container escape from the
developer's host, and reviewing someone else's branch is exactly when you would reach for this. Run
it on a checkout you trust, or in a disposable VM.

On a host that restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns
= 1` on recent Ubuntu), bubblewrap cannot create its namespace and the two tests fail on setup
rather than on the behaviour under test. Grant the narrowest thing that fixes it —
`--cap-add SYS_ADMIN --security-opt seccomp=unconfined`, or relax the sysctl on the host — rather
than reaching for `--privileged`. Docker Desktop needs neither: its LinuxKit VM exposes no AppArmor.

**A platform-gated test is not the only proof available.** Where the underlying defect is ordinary
logic that merely _surfaced_ on one platform, pin it with a test that runs everywhere as well.
#2643's root cause was a digest derived by two different formulas, which is platform-independent;
`debugLaunchPlan.test.ts` accordingly asserts that the validator accepts the identity its production
producer emits, and that test runs on every platform. Prefer that pin: the sandbox tests tell you
the launch works, and this one tells you _why_ it stopped working, on the machine you are sitting
at.

## Relation to the required checks

This is a pre-flight, not a replacement. The required checks on the pull request remain the complete
arbiter — see [`AGENTS.md`](../../AGENTS.md) §3. The purpose is narrower and concrete: stop paying a
CI cycle to learn something a local run would have told us in minutes.
