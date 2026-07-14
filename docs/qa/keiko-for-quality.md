# Keiko for Quality

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

No human approving review is required. Native auto-merge remains disabled during activation so a
current `CHANGES_REQUESTED` review and unresolved conversation stay blocking even when a bot's
processing check is green. Autonomous repair is allowed, but automatic merge is enabled only after
the independent aggregate below passes its negative and positive live probes.

## Independent aggregate gate

The final `Keiko for Quality` check must be produced by the dedicated open-source GitHub App
`Keiko for Quality`, not by repository Actions and not by code from a pull request. The App uses
the existing Keiko logo. Until it is deployed and validated, no check with this name is added to
branch protection and native auto-merge remains disabled.

The app is installed only on `oscharko-dev/Keiko` and receives the minimum permissions:

- Checks: read/write;
- Pull requests: read and write, because GitHub requires pull-request write access for the
  app-authored status comment on a pull request even when Issues write access is present;
- Issues and comments: read/write, limited to one redacted status comment per pull request;
- Metadata: read.

It receives no Contents write, Actions write, Administration, or repository-secret access. The
external runtime validates webhook HMAC signatures and rejects replayed events, unexpected
repositories/installations, and stale head SHAs. It stores metadata only: repository, PR number,
head SHA, check name, producer App ID, status, timestamps, and finding counts.

## PR dashboard comment

The App creates one top-level `Keiko for Quality` comment per pull request and updates it in place.
An invisible version marker binds ownership and prevents duplicate comments. Events produced by
the App's own check or comment are ignored to prevent self-triggered loops.

The comment presents a compact `Waiting`, `Blocked`, or `Ready for auto-merge` decision, the
12-character current-head prefix, successful/required check counts, an explicit SonarQube Cloud
native-gate result, Gitar and Socket evidence, Gitar Auto-Apply state, native auto-merge state, and
an expandable list of blocking or waiting evidence. The full repository-specific Sonar contract
remains enforced through the direct `ci` aggregate. The comment contains only allowlisted check
names, counts, states, and timestamps. It never includes logs, payload bodies, secrets, customer
data, private endpoints, or PII.

The open-source Worker implementation, least-privilege GitHub App manifest, and Cloudflare
deployment template live in [`../../infrastructure/keiko-for-quality/`](../../infrastructure/keiko-for-quality/).
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

Gitar and Socket comments must have been updated after their current-head checks started. When
Socket intentionally creates no pull-request comment because there are no dependency changes or
alerts, the current-head Pull Request Alerts check must instead contain explicit clean output and
zero annotations. A successful check without that exact evidence remains blocking. This prevents a
successful processing check on a new commit from reusing a clean comment from an older head.
Dismissing a Gitar review alone is therefore insufficient: current, parseable, zero-finding
evidence is still mandatory.

The operational Gitar configuration, large-pull-request acceptance criteria, safe interaction
commands, and Core/Pro plan boundaries are defined in
[`gitar-review-policy.md`](gitar-review-policy.md).

## Activation protocol

The dedicated app is made required only after its trusted implementation has been deployed from a
protected revision, emitted the expected check name and App ID, and completed all negative probes:
missing/red checks, wrong App ID, stale evidence, Sonar 84.9 percent/open issue, Gitar finding,
Socket warning, mutation score below 80 percent, and a new commit after previous success. The
positive probe must then allow GitHub native auto-merge without a human review or merge click,
while every deliberately red or absent technical gate remains unbypassable, including by
administrators. After activation, `Keiko for Quality` is added as an app-bound required check and
Gitar Auto-Approve/Auto-Merge may be enabled.
