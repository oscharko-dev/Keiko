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
| D12 performance evidence |    4 | no — measurement lane |
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

## What is authoritative here — and what is not

**Reliable in this container.** Anything deterministic: type checking, linting, formatting,
architecture rules, ADR index, dependency hygiene, the waiver-scope gate, `npm audit` over the
shipped graph, unit and UI suites, coverage ratchets, the release smoke E2E, builds and the package
surface. These behave identically to CI because they depend on the source tree, not on the machine.

**Not authoritative here.**

- **D12 wall-clock performance evidence.** Timing is comparable only on the reference architecture.
  On Apple Silicon this image is arm64 while CI is x86_64; forcing `--platform linux/amd64` runs
  under emulation and produces numbers that mean nothing. Evidence is produced by the nightly Linux
  lane or a `workflow_dispatch` of `nightly-perf-evidence.yml` on your branch — see
  [`perf-evidence.md`](perf-evidence.md).
- **SonarCloud.** Needs `SONAR_TOKEN` and the hosted analysis. Locally you can only pre-empt the
  common rule classes by reading the diff; the verdict is CI's.
- **Windows and macOS smoke.** A Linux container cannot answer them.
- **Build provenance attestations.** Require the workflow's OIDC identity.

`KEIKO_LOCAL_GATE_CONTAINER=1` is set inside the container so nothing downstream mistakes a local
run for authoritative measurement evidence.

## Relation to the required checks

This is a pre-flight, not a replacement. The required checks on the pull request remain the complete
arbiter — see [`AGENTS.md`](../../AGENTS.md) §3. The purpose is narrower and concrete: stop paying a
CI cycle to learn something a local run would have told us in minutes.
