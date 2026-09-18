# ADR-0177: Coordinate one stable release build from every dev push

## Status

Accepted (owner decision, 2026-09-14). D8 added by owner decision, 2026-09-14.
Amended by owner decision, 2026-09-18, to assign one portable build owner and retain explicit
human publish authorization (#3548). D9 added by owner decision, 2026-09-18: the human
authorization moves to the start, as one release button, and the publish starts by itself.

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

### D1 — Every dev push assigns one portable build owner

The release-candidate planner is the single decision owner for both tag creation and dev rehearsal.
It emits one of three portable build owners for the exact pushed SHA:

- `stable-tag` when the version is approved and not yet published. The dev workflow does not stage
  it; the exact tag push performs the one authoritative four-target build.
- `dev-rehearsal` when the version is already published. This preserves full-chain regression
  coverage for ordinary post-release development without duplicating a release candidate build.
- `none` when the version is unapproved, the SHA is stale, or another publish owns the tag.

A `dev-rehearsal` runs the `stage`, `stage-linux-production`, `qualify-linux-production`, and
`assemble` jobs with the stable steps: native staging with `--release`, the USearch, launch/setup,
and secure-read smokes, Linux qualification, OIDC signing, sealing, offline re-verification on a
fresh runner, the Windows setup companion build, assembly, and GitHub Attestations. The release tag
the assembly binds is derived from the committed version, `v<package.json version>`, never from the
ref name.

Dev pushes share one concurrency group, and a newer push cancels the older rehearsal. Every tag run
and every manual dispatch gets a group of its own, because GitHub cancels a queued run in a shared
group when a third one arrives, even without `cancel-in-progress`.

### D2 — Build ownership is a named status, not an independent guess

The read-only `rehearsal-readiness` job invokes `scripts/release-candidate.mjs --plan`, the same
planner used by `release-candidate.yml`. Local readiness still comes from the committed
`package.json` and `release-impact.catalog.json`; live reads establish the current `dev` head, tag,
GitHub Release, npm version, and open publish state. The job outputs the portable build owner and
stages only for `dev-rehearsal`. A normal `stable-tag` or `none` result skips the expensive jobs
without failing. An unreadable or ambiguous input fails closed.

### D3 — Only what needs a real tag is skipped

The rehearsal skips exactly the checks that cannot be answered without the tag: that the tag points
at the commit and names `v<version>`, and `scripts/verify-release-required-checks.mjs`, which reads
the required check runs of the tagged commit. It still validates the release workflow authority
(`check:release-required-workflows`) and the approved runtime inputs (`check:portable-approvals`).
`release.yml` is not rehearsed: Keiko release-trust signing, npm publish, and the GitHub Release
upload stay with an explicit human dispatch on the tag.

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
staged every target and then skipped the Linux qualification, the assembly and the publish handoff
that way while the run still concluded "success".

### D8 — A green dev head becomes the release candidate; authorization stays human

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
- The tag push runs the stable build, which ends with `assemble`. Who starts the publish, and when,
  is D9. (Until D9 a read-only `publish-handoff` job polled for the release-required checks for up to
  90 minutes and printed a `gh workflow run release.yml` command with the run id, attempt and
  artifact name for the owner to copy and run.)
- Every `release.yml` job checks out the commit it was started for and proves it, never the tag as it
  is when the job starts, and the publish re-verifies the required checks without waiting for CI.
  Should the tag move anyway, the publisher re-reads it right before it creates the GitHub Release
  and stops before any side effect.

### D9 — One release button; the publish starts by itself

D8 placed the human authorization at the end of the chain: after the roughly 50-minute tag build the
owner had to come back, copy a generated command with five parameters, and dispatch the publish. The
owner's requirement is the opposite: when `dev` is green, press one button and let the release run
to the end unattended. Nothing technical forced the old order. A workflow-token dispatch is
attributed to `github-actions[bot]`, but the human decision does not have to be made by the run that
publishes; it only has to be verifiable by it.

- **The button.** An allowlisted owner runs `release.yml` on `dev` (`npm run release`, or "Run
  workflow" in the Actions tab) and supplies nothing else. The `request` job runs only for a non-bot
  triggering actor in `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`. It points `v<version>` at exactly the
  commit the button was pressed on (`scripts/release-candidate.mjs --request`, through the release tag
  App) and fails, naming the reason, when that commit cannot be released: the version is not
  approved, or a publish of the tag is still open. A successful request run is therefore the owner's
  authorization for exactly its head commit. GitHub records the dispatching account as the run's
  triggering actor, and no token can choose it.
- **Preparing the next version.** When the current version is already published there is nothing to
  request yet, and `release-impact.catalog.json` entries are already written ahead of time, during
  the normal review of the change that needs them (KEIKO-0118) — so the next release needs no new
  human judgment, only a mechanical version move. The request job moves the checkout to the lowest
  stable version the catalog already carries a reviewed, non-correction entry for
  (`scripts/lib/release-version-bump.mjs: nextReviewedVersion`), opens a `release/bump-<version>` pull
  request to `dev` as the release App, and arms native auto-merge, instead of failing. Direct pushes to
  `dev` stay forbidden, so the owner's authorization has to cross this one merge: a version-bump PR can
  only have been opened by the release App's own identity — reachable only from this owner-gated job —
  it targets `dev` from the reserved branch prefix, and it carries exactly the one mechanical commit
  `set-version.mjs` produces (`readVersionBumpAuthorization`, `isVersionBumpAuthorizationPr`). Losing
  any one of those checks is a safe failure: the bump does not auto-release, never a release it should
  not have made. The candidate tag holds at that merge exactly like a direct button press
  (`release-candidate.mjs`'s `releaseHeld`), and the advance evaluation recognizes it as a request
  equivalent to a live owner dispatch (`release-automation.mjs`'s `versionBumpRequest`), tried first and
  falling back to the classic dispatch-run request — including on any read failure — unchanged.
- **The held tag.** A later `dev` push never moves a tag that a successful or still-running request
  holds; that push belongs to the next release, and the planner assigns it no build. Only a newer
  press moves the tag. A held tag can at most stop a tag move, never start a publish, so the planner
  needs no allowlist: a request run of any other account skips every job and concludes `skipped`.
- **The event-driven start.** `release-advance.yml` runs on `workflow_run` completion of `Release`,
  `Portable assets`, `CI`, `CodeQL` and `Workflow hygiene`, skipping every pull-request run. Each run
  reads every fact fresh: the newest successful owner request, whether its version is published,
  whether the tag still points at the requested commit, the newest stable tag build of that commit,
  and the release-required checks on it. Once the build succeeded and every check is green it
  dispatches `release.yml` on the tag. Every evaluation runs after its own prerequisite completed, so
  the evaluation after the last one sees them all complete: nothing polls, and no decision depends
  on a clock. A running evaluation is never cancelled, and GitHub keeps only the newest pending one.
- **Exactly once.** A request whose tag already has a publish run started after it is left alone,
  whatever that run's outcome; a failed publish needs a new press, never an automatic retry. A failed
  build or check only stops the release; re-running that workflow continues it.
- **The authorization.** The dispatched run's `authorize` job decides who may publish in one tested
  place (`scripts/lib/release-automation.mjs`): an allowlisted owner who dispatched the tag directly,
  or `github-actions[bot]` for a commit an owner requested with the button. Every other actor, a
  moved tag, or a missing or unsuccessful stable build fails it before the `npm-publish` job, which
  holds the signing key and the npm Trusted Publisher identity, can start. `authorize` also names the
  exact build run and attempt for the publish job, so `release.yml` has no inputs. The job condition
  compares no actor with a bot login, which zizmor's `bot-conditions` audit reports as spoofable.
- **Why the publish stays a tag dispatch.** `workflow_run` executes on the default branch with its
  head as `GITHUB_SHA`, so npm provenance would name `dev`'s newest commit rather than the released
  one; the Linux qualification receipt must name `portable-assets.yml@refs/tags/vX.Y.Z` (D8). The
  event-driven run therefore only decides and dispatches; the publish runs on the tag and binds its
  commit as before.
- **The trust boundary.** A token with `actions: write` alone can dispatch `release.yml`, but it can
  only publish a commit an allowlisted owner requested, on a tag only the owner and the release tag
  App may write. `release-advance.yml` checks out `github.sha`, the default-branch commit its own
  definition came from, runs only committed code, reads
  no value of the triggering run and holds no secret; its only write grant is `actions: write`.

## Consequences

- A release-only defect surfaces on the `dev` push that introduces it, not in a tagged release.
- Each releasable SHA costs one full four-platform tag build. It no longer also consumes a complete
  dev rehearsal. Already-published versions retain one cancellable dev rehearsal per latest SHA.
- Each rehearsal writes public Sigstore transparency-log entries for the Linux receipt and the GitHub
  Attestations. They name the repository, `refs/heads/dev`, and the commit, which the public
  repository already discloses, and they cannot be removed.
- `portable-release-signing` can take a `v*` deployment policy and a required approval without
  affecting `dev`.
- A green rehearsal proves the chain for `v<version>` at that commit. After a version is published,
  the next release still needs its reviewed release-impact approval on `dev` — written ahead of time
  during normal feature review, never as a release-time step — before a press of the button can move
  the version to it; readiness names that gap until the approval lands.
- Releasing a version is one press of the release button, on a `dev` that already carries a reviewed
  release-impact entry for whatever version comes next. No second human step, command, run id or
  re-run is part of a release that succeeds, and no separate version-bump step is either: the button
  prepares it.
- Merges after the press are held back from the release they would otherwise have silently joined,
  and each requested commit is published at most once per press.
- An owner-cut tag still releases as before; the candidate workflow keeps, moves, or leaves it by the
  same rules.
- Until the GitHub App, the `release-tagging` environment, and the ruleset bypass exist, the tag job of
  an eligible candidate fails and names the missing token; pushes that are not candidates are
  unaffected.

## Guards

`scripts/__tests__/release-portable-assets-workflow.test.mjs` pins the trigger and concurrency, the
single-owner gating, the tag-only authority, the signing-lane mapping, the environment split, the
checkout binding, secret gating, the derived release tag, and the resolver's refusal of a rehearsal
run and bundle. `scripts/__tests__/linux-qualification-rehearsal-fence.test.mjs` pins the consumers
of the rehearsal policy. For D8 and D9, `release-candidate.test.mjs` proves every tag decision
in-process, including the request and the held tag, and `release-automation.test.mjs` proves every
start and authorization decision; `release-candidate-workflow.test.mjs` pins triggers, grants, the
secrets and the step order of the candidate, the button and the event-driven start;
`release-publish-dispatch-guard.test.mjs` pins the button's owner guard and the single authorization
place; `check-release-required-workflow-names.test.mjs` holds `release-advance.yml` to `release.yml`'s
authority; `release-orchestration-integration.test.mjs` proves both build-owner scenarios, the held
tag and the complete chain from the press to the authorized publish; and
`release-publish-pipeline.test.mjs` stops a publish whose tag moved. `release-version-bump.test.mjs`
proves the reviewed-version lookup, the authorization PR's identity check, and the branch/commit/PR/
auto-merge sequence in-process; `release-candidate.test.mjs` and `release-automation.test.mjs` also
cover the merged-PR hold and request paths, including every way a PR can fail to be one
(`releaseHeld`, `versionBumpRequest`).

## References

- [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md)
- [ADR-0163](ADR-0163-self-contained-release-qualified-coding-runtime.md)
- [Release publish workflow](../release/release-publish-workflow.md)
- [Optional Native Platform Signing Contract](../release/portable-production-signing-contract.md)
