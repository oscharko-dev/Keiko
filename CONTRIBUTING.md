# Contributing to Keiko

Keiko is built to a production-ready, enterprise quality bar: strict TypeScript (no `any`), tested behavior,
minimal runtime dependencies, and reviewable, evidence-backed changes. The architecture and release constraints
are recorded in the [Architecture Decision Records](docs/adr/); read the current decisions before opening a pull request.

## Local development

```bash
npm install        # install dev tooling and generate package-lock.json
npm run build      # compile TypeScript outputs
npm test           # run the unit test suite
npm run lint       # ESLint, zero-warning policy
npm run typecheck  # strict type-checking for src + tests
```

## Pull requests

All 11 app-bound required status checks must pass on the current pull-request head before a change
can merge into `dev`:

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
11. `Keiko for Quality`

`workflow hygiene` runs actionlint, the pinned-SHA verification, zizmor and the OSV lockfile
scan as one context (ADR-0159); the tools, pinned versions and rule sets are unchanged.

No human approving review or manual merge is required. GitHub native auto-merge integrates only
after the required checks succeed on the exact current head and every review conversation is
resolved. `Keiko for Quality` is a required, app-bound check (App id `4290143`) since the
ADR-0142 cutover on 2026-07-19: all six live-probe conditions in
[`docs/qa/keiko-for-quality.md`](docs/qa/keiko-for-quality.md) were proven on live pull requests
(ledger in
[`docs/qa/keiko-for-quality-action-evaluation.md`](docs/qa/keiko-for-quality-action-evaluation.md))
before the maintainer promoted it. Qodo itself remains advisory and comment-only; the KFQ check
is the gateable bridge for its findings. Full mutation testing runs daily and
on explicit dispatch; shared-runner performance evidence runs after merge and for releases. Neither
unbounded workload is part of the pull-request critical path. Qodo configuration, large-PR
acceptance, safe commands, and boundaries are governed by
[`docs/qa/qodo-review-policy.md`](docs/qa/qodo-review-policy.md).

The rationale for the package architecture, workspace gate, bundled publish model, and 0.2.0 baseline is recorded in
[ADR-0019](docs/adr/ADR-0019-modular-package-architecture.md),
[ADR-0020](docs/adr/ADR-0020-workspace-tooling-and-architecture-gate.md),
[ADR-0021](docs/adr/ADR-0021-publish-strategy-bundled-monorepo-product.md), and
[ADR-0025](docs/adr/ADR-0025-forward-only-0-2-0-modular-baseline.md).

UI-facing features must use the existing i18n API instead of hard-coded user-visible strings, and every UI change
must update both `packages/keiko-ui/src/lib/i18n-messages.en.ts` and
`packages/keiko-ui/src/lib/i18n-messages.de.ts` with matching keys. Pull request CI runs
`npm run check:ui-i18n` to enforce this guard before review and merge.

Published release notes live in GitHub Releases. This repository intentionally does not maintain a root `CHANGELOG.md`.

## Troubleshooting documentation

Operator-facing failure modes live in [`docs/troubleshooting/README.md`](docs/troubleshooting/README.md).
When adding a new entry, copy [`docs/troubleshooting/_template.md`](docs/troubleshooting/_template.md)
and follow the **Symptom**, **Root Cause**, **Diagnostic Steps**, and
**Resolution** structure. Do not include API keys, customer data,
internal endpoints, or unredacted log lines in examples.
