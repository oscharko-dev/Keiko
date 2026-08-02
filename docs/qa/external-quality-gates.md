# External quality gates

This runbook separates merge-critical evidence from supplemental hosted review. A free hosted
entitlement is not an open-source or availability guarantee. Required checks must provide exact-head,
App-bound, reproducible evidence; a missing, neutral, stale, quota-paced, or skipped result never
satisfies a required check.

## Current topology

The stable protected set contains ten checks:

1. `ci`
2. `workflow hygiene`
3. `Analyze (actions)`
4. `Analyze (javascript-typescript)`
5. `Build, scan, SBOM, smoke`
6. `Review dependency diff (dev/main)`
7. `ui`
8. `SonarCloud Code Analysis`
9. `Socket Security: Project Report`
10. `Socket Security: Pull Request Alerts`

SonarCloud and Socket are independently required. CodeRabbit is supplemental: its provider status
is not required because quota can omit current-head review. When it emits an inline finding, the
defect must be repaired and GitHub's required conversation-resolution rule blocks merge until the
thread is resolved. Ignore, pause, bulk-resolution, dismissal, threshold relaxation, and admin
bypass are not repair paths.

Keiko for Quality is an external, SHA-pinned reviewer adopted by
[ADR-0170](../adr/ADR-0170-keiko-for-quality-as-an-external-reviewer.md). Its product code lives in
[oscharko-dev/Keiko-for-Quality](https://github.com/oscharko-dev/Keiko-for-Quality); this repository
owns only the consumer workflow, the review profile, and the credentials. Like CodeRabbit it
publishes **no required status** — its findings block solely through conversation resolution — so it
does not appear in the protected set above and adding it there requires its own decision.

It stays inert until the repository variable `KEIKO_QUALITY_ENABLED` is `true`. While active, the
delivering agent arms auto-merge only after the run for the current head has terminated. If it has
not terminated within **35 minutes** of the last required check going green, the agent **cancels the
run first** — every run for that head that has not reached a terminal conclusion, not only the ones
already executing — then arms, and records the expiry as a delivery-policy event (ADR-0170 D5). If
any cancellation fails, containment was not established: auto-merge stays disarmed and the failure
is recorded. Cancelling
narrows the window in which a review can publish after integration; it does not close it, and
ADR-0170 D6 keeps that as a stated fail-open window. An expired review is never described as clean. Operating detail —
provisioning, diagnostics, the disable path, and mass disposition — is in
[`keiko-for-quality.md`](keiko-for-quality.md).

CodSpeed and Greptile are retired under ADR-0169. Neither has an installed App, repository config,
workflow, validator, package command, or protected context.

## Repository-owned enforcement

- Fallow rejects every semantic clone group introduced by the diff at the governed token and line
  floors.
- The checksum-pinned Gitleaks binary rejects secrets anywhere in the pull-request commit range and
  emits fully redacted diagnostics.
- Strict TypeScript, ESLint, formatting, architecture, contract, coverage, package, security,
  retrieval, and affected-area test gates run in required `ci`.
- Performance merge authority belongs to `npm run check:retrieval-latency`,
  `npm run check:retrieval-quality`, `npm run check:grounded-retrieval-quality`,
  `npm run check:context-quality`, `npm run check:editor-bundle-size`,
  `npm run check:editor-release-evidence`, `npm run check:perf-evidence:editor`, and
  `npm run check:perf-evidence`. The exact pull-request E2E checks are `npm run test:e2e:smoke`,
  `npm run test:e2e:editor-run-verification-2215`, `npm run test:e2e:editor-debugging-2348`, and
  `npm run test:e2e:editor-m11-closeout-2533`.
- `check:external-quality-config` semantically validates CodeRabbit's no-write, every-update,
  no-excluded-author policy and verifies that required `ci` still runs the repository-owned gates.
- `check:review-bot-suppression` rejects pull-request metadata that asks CodeRabbit to ignore,
  pause, or resolve review.

Local verification:

```bash
npm run check:external-quality-config
npm run check:review-bot-suppression
npm run check:semantic-duplication -- --changed-since origin/dev
npm run typecheck
npm run lint
npm run format:check
npm run gates:sonar
npm test
npm run arch:check
npm run arch:check:negative
```

## Hosted settings

### CodeRabbit

CodeRabbit uses the assertive profile, automatic `dev` review, incremental review on every push, no
auto-pause, and no excluded authors. Request-changes is enabled for emitted inline findings. Commit
status, general review status, pull-request-description summaries, code-writing features, web search,
cross-repository context, and post-merge features remain disabled.

### SonarCloud and Socket

SonarCloud remains required both through its native App context and the exact-head validator inside
`ci`. Socket retains its two independently App-bound required contexts. Their current plan and
producer identities are checked during branch-protection audits; repository secrets, endpoints, and
finding bodies never enter committed evidence.

## Retired-provider evidence

The 2026-08-01 canary remains historical evidence in
[`quality-gate-canary-2026-08-01.md`](quality-gate-canary-2026-08-01.md). It proved:

- Greptile exhausted trial credits and omitted current-head review, so its availability could not
  carry merge authority.
- CodSpeed reported materially different regressions for unchanged benchmark inputs on shared
  runners, so its comparison could not carry performance merge authority.
- The remaining base-owned policy job checked hosted configuration rather than product quality and
  byte-pinned its own changeable workflow and scripts, producing the PR #2918 self-deadlock.

Both Apps were uninstalled by the owner on 2026-08-02. Repository artifacts and the obsolete
`CodSpeed policy` protected context were permanently removed by ADR-0169. They are not candidates for
automatic restoration.

## Promotion requirements

A future hosted producer requires a new ADR and a live canary proving all of the following before
installation or branch protection:

1. every eligible current head receives one attributable result without prompting;
2. successive updates prove stale success cannot satisfy a new head;
3. a deliberate defect fails and a repaired head succeeds;
4. cancellation, large diffs, bot authors, and service errors cannot falsely green evidence;
5. check name and producer App identity are stable and App-bindable;
6. plan limits, credits, or quota cannot pace required evidence; and
7. unchanged inputs cannot fail because execution provenance changed.

No payment workaround, popularity manipulation, dormant configuration, or speculative required
context is accepted.
