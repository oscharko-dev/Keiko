# Contributing to Keiko

Keiko is built to a production-ready, enterprise quality bar: strict TypeScript (no `any`), tested behavior,
minimal runtime dependencies, and reviewable, evidence-backed changes. The architecture and release constraints
are recorded in the [Architecture Decision Records](docs/adr/); read the current decisions before opening a pull request.
Working, clean, secure, verified code is authoritative. ADRs are architectural guardrails and
memory, not executable truth: if a repair exposes outdated, contradictory, or unsafe ADR text, fix
the code and update the affected ADR sections together. Do not preserve a defect merely because an
ADR recorded it, and do not create a new ADR merely to correct existing text.

## Local development

```bash
npm install                # install all workspaces from the single root lockfile
npm run provision:usearch  # ONCE per checkout — see AGENTS.md §2
npm run build              # compile TypeScript outputs
npm run typecheck          # strict type-checking for src + tests
npm run lint               # ESLint, zero-warning policy
npm run format:check       # Prettier check
npm test                   # run the unit test suite
npm run arch:check         # dependency-cruiser + import-policy + contract-boundaries
npm run arch:check:negative
```

See [AGENTS.md §3](AGENTS.md) for the full local gate loop and the touched-area gate table.

### Activity Log runtime changes

Production runtime behavior extends the existing Activity Log; it never creates a second logger,
event store, analyzer, or incident subsystem. Register every operation through the canonical typed
APIs in `keiko-contracts` and emit only the registration-derived event shape. The checked-in
`docs/observability/op-catalog.generated.json` is generated from those canonical declarations and
emitters. Its typed registry is authoritative; the legacy literal scan is migration input only.

Each registration owns exact fields, bounds, data classes and vocabularies, causal and lifecycle
semantics, analyzer projection, failure classes, proof ids, and release impact. Unknown or dynamic
operations, arbitrary metadata, nested objects, missing required fields, unbounded strings, and
unknown error/loss states fail closed. Persisted v2 records also require the sink-owned version and
digest dimensions, compatibility/writer state, and complete `(pid, instanceId, seq)` identity.
Tests for changed behavior assert the emitted line and the support-analyzer projection. Regenerate
the catalog with `npm run generate:op-catalog`, then run `npm run check:activity-log`, the Activity
Log implementation gate, which required CI runs unchanged. Every run builds the packages and
evaluates the complete registered inventory by composing `check:op-catalog`,
`test:activity-log-scenarios` (the curated end-to-end scenario matrix), `check:error-observability`,
`arch:check`, `arch:check:negative`, and `check:release-impact`; it takes no changed-file input, so
a narrower change set never narrows what it proves.

The generated registry also publishes the stable implementation-obligation categories and the
failure-class coverage matrix consumed by permanent quality gates. Its release expectation is
100% complete. Exemptions are not comments or wildcards: the sole registry exemption contract is
limited to one registered operation/failure-class pair and requires the operation's owning package
as owner, a technical reason, a linked tracking issue, an unavoidable platform or durability
boundary, and an expiry at most 180 days ahead. It cannot permit unknown fields, prohibited data,
silent loss, or incomplete evidence.

Keep this contract converged in one change. A runtime change that affects Activity Log behavior
updates the owning implementation, its failure-first regression, emitted-line and analyzer/replay
proof, ADR-0173, AGENTS.md, this contributor contract, and directly affected operator documentation
as applicable. Saved support reports remain local artifacts written to a user-selected destination;
publishing or attaching one to GitHub or another external system requires separate explicit user
authority and is never part of logging or export.

Activity Log storage must remain bounded on every intermediate change. The Activity Log is stored as
immutable segments in `<stateDir>/logs/` (ADR-0173 D14). Each process appends only to its own active
segment, sealed segments are read-only, and retention bounds every segment and legacy file by bytes
and age, so total use stays within the byte budget plus the pin quota. Filesystem mutation is
limited to verified owner-private, non-redirected directories and opened regular owner-matched
targets, and only on names in the closed grammar of `keiko-contracts` `activity-log-files.ts`.
Publication never replaces an existing name; rename is permitted only when the filesystem reports
hard links unsupported. Any successor storage design must replace this bound atomically rather than
remove it first.

## Pull requests

All required status checks must pass on the current pull-request head before a change can merge into
`dev`. The stable app-bound set is the ten checks below:

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

`workflow hygiene` runs actionlint, the pinned-SHA verification, zizmor and the OSV lockfile scan as
one context (ADR-0159); the tools, pinned versions and rule sets are unchanged. It also runs the
repository-owned `check:zizmor-anchors` ahead of zizmor, so a line anchor that drifted out of
`.github/zizmor.yml` reports as itself rather than as the finding it silently stopped suppressing. The hosted contexts
and their bounded zero-cost eligibility are recorded in
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

The required matrix measures a change once. `dev` is protected with linear history and signed
squash merges of up-to-date heads, so the integration commit carries a new sha and the identical
tree sha as the pull-request head the matrix already proved green. The `dev` run resolves that
before any gate starts and reuses that verdict rather than re-measuring identical bytes
([ADR-0178](docs/adr/ADR-0178-reuse-proven-tree-evidence-on-integration-runs.md)). Reuse requires
the merge commit to be that pull request's exact `merge_commit_sha`, the trees to match, a completed
successful `pull_request` run on that head, and that run to have executed every skipped job; any
other outcome runs the full matrix, and the `ci` aggregate still fails closed. Editing a workflow
changes the tree, so CI changes always measure themselves.

No human approving review or manual merge is required. GitHub native auto-merge integrates only
after the required checks succeed on the exact current head and every review conversation is
resolved. CodeRabbit reviews every pull request targeting `dev` and every subsequent push with no
auto-pause. Its status is not required because quota can omit a current-head review. When CodeRabbit
does emit an inline finding, GitHub's required conversation-resolution rule blocks merge until its
conversation is resolved. Policy additionally requires the underlying defect to be repaired; the
quota-tolerant interim topology cannot infer code repair merely from GitHub's resolved bit.

`.github/CODEOWNERS` intentionally stays a single flat `* @oscharko` rule while Keiko has one
maintainer; it has no merge-gating effect under this no-human-review auto-merge model. Revisit
path-scoped rows if/when a second maintainer joins.

The hosted performance dashboard and quota-paced reviewer evaluated in ADR-0169 are retired.
Neither has repository configuration, an installed App, a workflow, or a protected context.
Deterministic bundle, latency, retrieval, and performance gates inside `ci` retain merge authority.
No payment method, finding dismissal, or gate bypass is an accepted repair path.

Keiko for Quality is retired by
[ADR-0176](docs/adr/ADR-0176-retire-keiko-for-quality.md). It has no workflow, review profile,
repository variable, credential consumer, or protected context in this repository. Its product is
being rebuilt inside Keiko itself; until that ships, no model-backed reviewer runs on a pull
request here.

Qodo is retired by
[ADR-0167](docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md); it is not Sonar evidence.
Sonar remains independently enforced by its native required check and the exact-head validator
inside `ci`. Full mutation runs daily/on demand and reference-machine performance evidence runs
outside the pull-request critical path. Fast semantic-duplication, secret, coverage, static-analysis,
and deterministic performance proxies run in parallel on pull requests. Thresholds and operational details are
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
