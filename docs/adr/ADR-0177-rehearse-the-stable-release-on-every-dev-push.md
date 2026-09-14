# ADR-0177: Rehearse the stable release on every dev push

## Status

Accepted (owner decision, 2026-09-14). D8 added by owner decision, 2026-09-14.

## Amends

- [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md) D8: the
  `assemble` job that generates the portable GitHub Attestations also runs as a rehearsal on `dev`,
  and every documented verifier of those attestations binds the stable tag.
- [ADR-0163](ADR-0163-self-contained-release-qualified-coding-runtime.md) D2: the Linux
  runtime-qualification receipt may also be signed under a rehearsal identity that production
  discovery never accepts.

## Context

`.github/workflows/portable-assets.yml` built the stable portable release set only on a stable `v*`
tag push. Its Linux production staging, fresh-runner requalification, and assembly jobs sit behind
`needs` edges that no pull request and no manual dispatch reaches, so they ran for the first time
inside the v1.0.0 release on 2026-09-13. Each attempt surfaced the next defect of a class no earlier
run could have shown: the fresh qualification job had no built `packages/*/dist`
(`ERR_MODULE_NOT_FOUND`), the zipped artifact upload dropped the native helper's file modes, the
upload excluded the hidden `.portable/` evidence ("missing runtime activation manifest"), and the
assembler refused the stable lanes it exists to combine. Every defect cost a tag, a four-platform
run, and a repair pull request.

A pull request cannot run this chain: it needs the stable build, the OIDC signing grant, and the
complete four-target set. The owner asked for the opposite property — every green `dev` state
releasable with one approval — and that holds only if the chain has already run on that state before
anyone tags it.

## Decision

### D1 — A releasable dev push runs the stable chain as a rehearsal

A push to `dev` runs the `stage`, `stage-linux-production`, `qualify-linux-production`, and
`assemble` jobs of a stable tag with the same steps: native staging with `--release`, the USearch,
launch/setup, and secure-read smokes, Linux qualification, OIDC signing, sealing, offline
re-verification on a fresh runner, the Windows setup companion build, assembly, and the GitHub
Attestations. The release tag the assembly binds is derived from the committed version,
`v<package.json version>`, never from the ref name.

Dev pushes share one concurrency group, and a newer push cancels the older rehearsal. Every tag run
and every manual dispatch gets a group of its own, because GitHub cancels a queued run in a shared
group when a third one arrives, even without `cancel-in-progress`.

### D2 — "Not releasable yet" is a named status, not a failure

The read-only `rehearsal-readiness` job (`scripts/portable-rehearsal-readiness.mjs`) reads only the
committed `package.json` and `release-impact.catalog.json`. A prerelease version, or a portable
target without exactly one reviewed, human-approved release-impact entry for `v<version>`, sets
`ready=false` and writes the reason to the job summary. The rehearsal jobs are then skipped rather
than failed, so the lane does not stand red between two releases. An unreadable package or catalog
fails the job, because that is a defect rather than a state.

### D3 — Only what needs a real tag is skipped

The rehearsal skips exactly the checks that cannot be answered without the tag: that the tag points
at the commit and names `v<version>`, and `scripts/verify-release-required-checks.mjs`, which reads
the required check runs of the tagged commit. It still validates the release workflow authority
(`check:release-required-workflows`) and the approved runtime inputs (`check:portable-approvals`).
`release.yml` is not rehearsed: Keiko release-trust signing, the npm publish behind the
`npm-publish` approval, and the GitHub Release upload stay with the tag.

### D4 — A rehearsal signs under its own identity

The Linux receipt's Sigstore certificate names the workflow ref that signed it, so a rehearsal signs
as `…/portable-assets.yml@refs/heads/dev`. `scripts/linux-portable-signing.mjs` verifies that
signature with `--lane rehearsal` against `LINUX_QUALIFICATION_REHEARSAL_SIGSTORE_POLICY` and does
not offer the artifact to production discovery. Production discovery keeps verifying against
`LINUX_QUALIFICATION_SIGSTORE_POLICY`, which accepts `…@refs/tags/v<major>.<minor>.<patch>` only. A
fence test fails when any package module other than the defining one, or any script other than the
Linux signing tool, references the rehearsal policy or its verifier.

### D5 — A rehearsal can never be released

The rehearsal bundle is uploaded as `portable-rehearsal-assets`. The release workflow's resolver
accepts only `portable-release-assets` from a successful stable-tag push of this workflow for the
exact tag, so it refuses a rehearsal run on its branch and on its artifact name independently. The
bundle carries no Keiko release-trust signature; only the protected publisher creates one. Its
GitHub Attestations name `refs/heads/dev`: the publisher verifies the setup companion's attestation
with `--signer-workflow`, `--source-digest`, and `--source-ref refs/tags/<tag>`, and the operator
guide binds the signer workflow and the stable tag the same way, so a rehearsal attestation never
verifies as a release.

### D6 — The rehearsal stays out of the signing environment

Every deployment protection rule must pass before a job that references an environment gets a
runner. A rehearsal entering `portable-release-signing` would stall once that environment receives a
stable-tag deployment policy or the approval the signing contract describes, and it would run next
to any credential provisioned there. The Linux production job therefore selects
`portable-release-rehearsal` on `dev` and `portable-release-signing` on a tag. GitHub creates the
rehearsal environment on its first reference, without protection rules or secrets. Independently of
the environment, a step may read a secret only behind a reviewed stable-tag condition.

### D7 — Every job works on the commit that triggered the run

`actions/checkout` with an explicit `ref` fetches that ref's tip when the job starts. On `dev` that
tip can already be a newer push, while every artifact is bound to `GITHUB_SHA`. No checkout in the
workflow passes a `ref`, so each binds the event commit, and the jobs that stage, sign, or requalify
compare `git rev-parse HEAD` with `GITHUB_SHA` before any step uses it.

`rehearsal-readiness` runs only on a `dev` push, so a tag push skips it. Every job downstream of it
states its own status function (`!cancelled()` or `always()`): without one, GitHub's implicit
`success()` counts the skipped readiness as an unsuccessful ancestor. The first v1.0.1 tag build
staged every target and then skipped the Linux qualification, the assembly and the publish request
that way while the run still concluded "success".

### D8 — A green dev head becomes the release candidate; the approval is the only manual step

The rehearsal itself cannot be released. The Linux runtime-qualification signature inside the shipped
zip names the Git ref of its build, and installed Keiko accepts only
`portable-assets.yml@refs/tags/vX.Y.Z` when it activates the runtime and when it verifies an update
(`linuxPortableSigstore.ts`), in the code of the version already installed. A `dev`-built bundle would
be refused by every existing install, so the release keeps building on the tag. What changes is who
starts it:

- `.github/workflows/release-candidate.yml` runs on every `dev` push. A read-only plan job decides from
  that commit's checkout: its version must pass the D1
  readiness, neither npm nor a GitHub release may carry it, and the commit must still be the live `dev`
  head. It creates `v<version>`, moves it from an older unpublished commit, keeps it, or skips. A
  published version's tag never moves, and neither does a tag with an open publish, including one
  that waits for its approval, so an approval always covers the commit it was requested for.
- For a create or move the tag job writes the ref at once, so the stable build runs beside the
  commit's CI instead of after it. No build step waits for the release-required checks any more — the
  first v1.0.0 build failed every target on that 30-minute wait while its CI was still queued. The
  write uses a token from a GitHub App whose
  only permission is repository contents; the App key lives in the `release-tagging` environment,
  which only `dev` deploys to, and the App is the second bypass actor of the "Owner-only tag changes"
  ruleset.
- The tag push runs the stable build. After `assemble`, its `request-publish` job waits for the six
  release-required checks on the tag commit, then dispatches `release.yml` with that run's id and
  attempt and cancels an older candidate's publish that still waits for approval. A commit whose
  checks fail is never requested; the next green candidate moves the tag. A `workflow_dispatch` is an event `GITHUB_TOKEN` may start, and it
  runs on the tag ref, so npm provenance names the tagged commit.
- The publish job keeps its `npm-publish` review (ADR-0170 D3), which is the only manual step. Every
  release.yml job checks out the commit it was started for and proves it, never the tag as it is when
  the job starts, and the publish re-verifies the required checks without waiting for CI. Should the
  tag move anyway, the publisher re-reads it right before it creates the GitHub Release and stops
  before any side effect.

## Consequences

- A release-only defect surfaces on the `dev` push that introduces it, not in a tagged release.
- Each releasable `dev` push costs one full four-platform chain; a newer push cancels the older one.
- Each rehearsal writes public Sigstore transparency-log entries for the Linux receipt and the GitHub
  Attestations. They name the repository, `refs/heads/dev`, and the commit, which the public
  repository already discloses, and they cannot be removed.
- `portable-release-signing` can take a `v*` deployment policy and a required approval without
  affecting `dev`.
- A green rehearsal proves the chain for `v<version>` at that commit. After a version is published,
  the next release still needs its version bump and its reviewed release-impact approval; readiness
  names that gap until the approval lands.
- Releasing a version is two actions that were already reviewed work: merge the version bump with its
  release-impact approval, then approve the `npm-publish` deployment once the stable build is ready.
- An owner-cut tag still releases as before; the candidate workflow keeps, moves, or leaves it by the
  same rules.
- Until the GitHub App, the `release-tagging` environment, and the ruleset bypass exist, the tag job of
  an eligible candidate fails and names the missing token; pushes that are not candidates are
  unaffected.

## Guards

`scripts/__tests__/release-portable-assets-workflow.test.mjs` pins the trigger and concurrency, the
readiness gating, the tag-only authority, the signing-lane mapping, the environment split, the
checkout binding, secret gating, the derived release tag, and the resolver's refusal of a rehearsal
run and bundle. `scripts/__tests__/linux-qualification-rehearsal-fence.test.mjs` pins the consumers
of the rehearsal policy. For D8, `release-candidate.test.mjs` and `release-publish-request.test.mjs`
prove every decision in-process, `release-candidate-workflow.test.mjs` pins triggers, grants, the one
secret and the step order, `check-release-required-workflow-names.test.mjs` holds the candidate to
`release.yml`'s authority, and `release-publish-pipeline.test.mjs` stops a publish whose tag moved.

## References

- [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md)
- [ADR-0163](ADR-0163-self-contained-release-qualified-coding-runtime.md)
- [Release publish workflow](../release/release-publish-workflow.md)
- [Optional Native Platform Signing Contract](../release/portable-production-signing-contract.md)
