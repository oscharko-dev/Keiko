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

All sixteen required, app-bound status checks must pass for the current head commit before a change
can merge into `dev`:

1. `ci`
2. `actionlint`
3. `Verify pinned action SHAs`
4. `zizmor`
5. `Analyze (actions)`
6. `Analyze (javascript-typescript)`
7. `Build, scan, SBOM, smoke`
8. `Review dependency diff (dev/main)`
9. `ui`
10. `Scan dependency lockfiles`
11. `Mutation quality gate`
12. `SonarCloud Code Analysis`
13. `Socket Security: Project Report`
14. `Socket Security: Pull Request Alerts`
15. `Gitar`
16. `Banking Quality Gate`

The approval ruleset has a pull-request-only bypass for `oscharko` and `Niko4417`, allowing
agent-authored delivery in their names without a second human approval after explicit delivery
authorization. That bypass does not apply to required checks. Missing, pending, stale, or failed
technical evidence blocks both maintainers and administrators.

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
