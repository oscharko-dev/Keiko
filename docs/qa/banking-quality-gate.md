# Keiko Banking Quality Gate

## Current enforcement

Pull requests targeting `dev` are fail-closed behind app-bound GitHub required checks. The direct
checks cover build and test quality, action security, CodeQL, container/SBOM scanning, dependency
review, UI quality, OSV, mutation testing, SonarCloud, Socket, and Gitar. Each new commit invalidates
the previous head's evidence because GitHub evaluates required checks on the current PR head.

GitHub's separate preview Code Quality setup is disabled. It duplicated the repository CodeQL
workflow and attempted a context-free C# analysis. Keiko does contain one productive C# signing
source and two productive C sources; ADR-0134 excludes them from Linux Sonar analysis and requires
build-aware compiler, analyzer, and behavior evidence on Windows/macOS. The required, SHA-pinned
CodeQL workflow remains authoritative for `actions` and `javascript-typescript`.

During the quality-gate recovery, the maintainer/contributor approval bypass is disabled. A current
`CHANGES_REQUESTED` review therefore remains blocking even when a bot's processing check is green.
This temporary safe mode stays active until the independent aggregate gate below has passed the
negative and positive live probes.

## Independent aggregate gate

The final `Banking Quality Gate` must be produced by the dedicated open-source GitHub App
`Keiko Banking Quality Gate`, not by repository Actions and not by code from a pull request. Until
that app is deployed and validated, no check with this name is added to branch protection and no
approval bypass is re-enabled.

The app is installed only on `oscharko-dev/Keiko` and receives the minimum permissions:

- Checks: read/write;
- Pull requests: read;
- Issues and comments: read;
- Metadata: read.

It receives no Contents write, Actions write, Administration, or repository-secret access. The
external runtime validates webhook HMAC signatures and rejects replayed events, unexpected
repositories/installations, and stale head SHAs. It stores metadata only: repository, PR number,
head SHA, check name, producer App ID, status, timestamps, and finding counts.

The open-source Worker implementation, least-privilege GitHub App manifest, and Cloudflare
deployment template live in [`../../infrastructure/banking-quality-gate/`](../../infrastructure/banking-quality-gate/).
Runtime credentials exist only in the external runtime's secret store.

## Fail-closed evidence rules

For a PR against `dev`, the app's check remains pending or failed unless every current required
check is successful and was emitted by its allowlisted App ID. Missing, stale, skipped, neutral,
cancelled, timed-out, or differently produced evidence is blocking.

Processing success alone is insufficient for review products:

- Gitar requires no current `CHANGES_REQUESTED` review and no unresolved finding for the head;
- Socket requires no warning or error alert for the head; an accepted risk is valid only when it
  matches an exact owner command, the external deployment allowlist, and the package/version and
  lockfile integrity policy in
  [`supply-chain-risk-acceptances.json`](supply-chain-risk-acceptances.json);
- SonarCloud requires native gate `OK`, exact current head, zero unresolved issues and new
  violations, at least 85 percent new-code coverage, at most 3 percent new duplication, and all new
  and overall security hotspots reviewed. Missing rates require an explicit zero applicability
  count; the dormant custom-gate definition must match the repository contract;
- mutation testing requires at least 80 percent with no survivor/no-coverage mutant for changed
  critical code; complete scheduled scans additionally fail on any regression or new fingerprint
  against the documented 61.66-percent historical baseline until that debt reaches 80 percent.

Unknown or changed Gitar/Socket evidence formats are parser failures, never success. A short,
bounded stability window follows the final Gitar and Socket events before the aggregate check may
turn green.

Gitar comments must have been updated after their current-head checks started. Socket comments are
required on the same current-head boundary whenever the pull request changes a Keiko dependency
manifest. Source-only pull requests instead require both successful current-head Socket checks,
because Socket intentionally does not create a pull-request comment without a dependency diff or
alert. Missing or malformed changed-file evidence falls back to requiring the Socket comment. This
prevents a successful processing check on a new commit from reusing a clean comment from an older
head. Dismissing a Gitar review alone is therefore insufficient: current, parseable, zero-finding
evidence is still mandatory.

## Activation protocol

The dedicated app is made required only after its trusted implementation has been deployed from a
protected revision, emitted the expected check name and App ID, and completed all negative probes:
missing/red checks, wrong App ID, stale evidence, Sonar 84.9 percent/open issue, Gitar finding,
Socket warning, mutation score below 80 percent, and a new commit after previous success. The
positive probe must then permit `oscharko` and `Niko4417` to merge without a second approval while
every deliberately red or absent technical gate remains unbypassable, including by administrators.
