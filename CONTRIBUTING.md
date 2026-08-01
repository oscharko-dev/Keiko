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

All required status checks must pass on the current pull-request head before a change can merge into
`dev`. The stable app-bound set is the eleven checks below:

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
11. `CodSpeed policy`

`workflow hygiene` runs actionlint, the pinned-SHA verification, zizmor and the OSV lockfile scan as
one context (ADR-0159); the tools, pinned versions and rule sets are unchanged. The hosted contexts
and their bounded zero-cost eligibility are recorded in
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

No human approving review or manual merge is required. GitHub native auto-merge integrates only
after the required checks succeed on the exact current head and every review conversation is
resolved. CodeRabbit remains an assertive advisory reviewer under `.coderabbit.yaml`; its free-tier
status can report success when quota omits a current-head review, so neither that status nor its
review state has merge authority. Agents still repair every finding they receive.

Greptile is retired because its 50-credit trial omitted a final-head review before the calendar
expiry. Its pending OSS application does not provide merge authority; reactivation requires a
durable zero-cost entitlement and a new live canary.

CodSpeed performance reports remain advisory because shared GitHub runner variability produced
large reported regressions on canary heads that changed no benchmark or transitive production path.
The required `CodSpeed policy` context still pins the hosted signal to a blocking 5% dashboard
threshold. Deterministic bundle, latency, and performance-proxy gates inside `ci` retain merge
authority.

Qodo and its Keiko for Quality bridge are retired by
[ADR-0167](docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md); neither is Sonar evidence.
Sonar remains independently enforced by its native required check and the exact-head validator
inside `ci`. Full mutation runs daily/on demand and reference-machine performance evidence runs
outside the pull-request critical path. Fast semantic-duplication, secret, coverage, static-analysis,
and CPU-simulation proxies run in parallel on pull requests. Thresholds and operational details are
in [`docs/qa/autonomous-quality-gates.md`](docs/qa/autonomous-quality-gates.md) and
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

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
