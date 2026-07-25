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
npm run gates:local          # lint, typecheck, format, arch, audits — the cheap majority
npm run gates:local:tests    # + unit and UI suites with coverage
npm run gates:local:e2e      # + release smoke E2E (downloads chromium on first run)
npm run gates:local:full     # + build, static export, package surface
npm run gates:local:shell    # interactive session in the same environment
```

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
shipped graph, unit and UI suites, coverage ratchets, the release smoke E2E, builds and the package
surface. These behave identically to CI because they depend on the source tree, not on the machine.

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
  `eslint-plugin-sonarjs` is the same engine SonarCloud runs, layered on this repository's own ESLint
  configuration and scoped to the files the branch changed, matching Sonar's new-code period.
- **Windows and macOS smoke.** A Linux container cannot answer them.
- **Build provenance attestations.** Require the workflow's OIDC identity.

`KEIKO_LOCAL_GATE_CONTAINER=1` is set inside the container so nothing downstream mistakes a local
run for authoritative measurement evidence.

## Relation to the required checks

This is a pre-flight, not a replacement. The required checks on the pull request remain the complete
arbiter — see [`AGENTS.md`](../../AGENTS.md) §3. The purpose is narrower and concrete: stop paying a
CI cycle to learn something a local run would have told us in minutes.
