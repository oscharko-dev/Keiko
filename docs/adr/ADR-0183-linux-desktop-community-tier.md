# ADR-0183: Linux desktop as a community tier without a parity commitment

## Status

Accepted (2026-11-12, owner decision recorded in PR #4375).

Amends:

- [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md): the
  `linux-x64` archive stays in the release matrix as a community-tier asset.
- [ADR-0163](ADR-0163-self-contained-release-qualified-coding-runtime.md) D1: the release matrix is
  unchanged, but only `windows-x64`, `macos-arm64` and `macos-x64` carry a parity commitment for new
  operating-system features.
- [ADR-0043](ADR-0043-enforced-execution-isolation.md): its Context sentence that the product must
  run on macOS, Linux and Windows is narrowed for new work by D3 below.

## Context

Keiko ships four release targets: `linux-x64`, `windows-x64`, `macos-arm64` and `macos-x64`. The
customers Keiko is built for work on macOS and Windows. Linux desktop users are a small group, and
no customer deployment depends on them.

Every feature that reaches into the operating system has needed a Linux implementation and Linux
qualification alongside the other two. Examples are process supervision, egress confinement, the
secure read helper, the credential store, native file dialogs, owner-private files, launcher and
update handoff. Each of those had to be designed, written, tested and qualified three times. The
Linux part was the one that no customer used.

The Linux archive itself is cheap to keep. Its stage-and-qualify job in `portable-assets.yml` runs
in parallel with the macOS and Windows jobs and adds about five minutes of runner time, not
wall-clock time.

Linux is also something other than a desktop target. It is the development and CI platform:
required CI runs on Linux runners, the gates container (`npm run gates:local`) is Linux, and
evidence such as the Editor release bundle is generated only on Linux. None of that changes.

## Decision

### D1 — Linux desktop is frozen as a community tier

The Linux desktop target keeps what it has today, with no parity commitment for what comes next:

- Existing Linux capabilities stay. Their existing tests and CI jobs stay required, and a red Linux
  job is fixed like any other red gate. Never ignore it, skip it or delete it to get green.
- Nothing promises that a new feature reaches Linux at the same time as macOS and Windows, or at
  all.
- A defect that occurs only on the Linux desktop is accepted as a community report and ranked below
  macOS and Windows work. A security defect keeps its normal severity on every platform.

### D2 — The `linux-x64` archive keeps being built and published

`keiko-linux-x64.zip` stays in the release matrix. It keeps its existing staging, qualification,
attestation and fresh-runner smoke in `portable-assets.yml`, and every gate that guards it today
keeps guarding it. Release notes and the README mark it as a community-tier package. Retiring the
archive would be a separate owner decision.

### D3 — New operating-system features are qualified on macOS and Windows only

A new or changed capability that depends on the operating system is designed, implemented and
qualified for macOS and Windows. Examples are process supervision, sandboxing and egress
confinement, credential and keychain storage, file ownership and permissions, native dialogs,
launcher, installer and update handoff, and platform runtime activation.

For Linux, such a capability takes one of two forms:

- it reuses an existing Linux implementation, so it costs no new Linux work; or
- it reports itself unavailable on Linux through the capability's existing closed disposition, and
  fails closed.

A Linux implementation the community contributes is welcome. It is reviewed under the same trust,
redaction and gate rules as any other change, but its qualification never blocks a macOS or Windows
delivery.

Platform-neutral work is not touched by this decision. That covers Chat, the Model Gateway,
connectors, Knowledge Pods, Memory and the UI, which keep running wherever the server runs, Linux
included.

### D4 — Linux stays authoritative as the development and CI platform

This ADR is about the Linux desktop product only. Required CI, the gates container,
Linux-generated evidence and Linux runners for platform-neutral tests keep their roles as defined in
[AGENTS.md](../../AGENTS.md) §3 and §9.

## Consequences

- New OS-level work needs two qualifications, not three. The saving comes in design and
  qualification time, not in CI minutes.
- The Linux desktop can fall behind macOS and Windows. The README and release notes say so in
  plain words.
- Existing Linux code paths stay under their current tests, so a regression in what Linux already
  does is still caught.

## Alternatives rejected

- **Drop the Linux archive.** It would save about five minutes of parallel runner time, but strand
  the existing Linux users with no upgrade path.
- **Keep full three-platform parity.** Every OS-level feature would still pay for a third platform
  that no customer uses.
- **Remove the Linux CI jobs.** That would turn the freeze into silent decay of capabilities Keiko
  already ships, and it would cut into the development platform as well.
