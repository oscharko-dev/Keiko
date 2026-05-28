# ADR-0002: CI and Supply-Chain Security Baseline

## Status

Accepted

## Context

The `dev` branch has protection rules requiring 7 named status checks before any PR can merge
(`enforce_admins: true`, no bypass). The check names are fixed — they are derived from GitHub Actions job
names (or job IDs when no `name:` field is present) — and must match byte-for-byte or the check never
reports, leaving the PR permanently blocked. The 7 required contexts are:

1. `ci`
2. `actionlint`
3. `Verify pinned action SHAs`
4. `Analyze (actions)`
5. `Analyze (javascript-typescript)`
6. `Build, scan, SBOM, smoke`
7. `Review dependency diff (dev/main)`

Regulated enterprise environments impose additional requirements beyond "tests pass":
- Dependency integrity: every GitHub Action must be pinned to a full 40-hex commit SHA. A mutable tag
  (e.g., `uses: actions/checkout@v4`) allows the action author to silently change the code that runs in CI.
  This is a supply-chain attack vector (analogous to the `tj-actions/changed-files` incident in 2025).
- Dependency review: PRs that introduce new transitive dependencies must surface license and vulnerability
  data before merge.
- SBOM: regulated environments require a software bill of materials for audit. npm 10's built-in
  `npm sbom --sbom-format cyclonedx` generates a CycloneDX SBOM without external tooling.
- Code scanning: CodeQL is required for GitHub Advanced Security and is free for public repositories.
- Workflow correctness: actionlint catches YAML schema errors, undefined expression references, and
  incorrect `runs-on` values before they reach production runners.

The repo is **public**. `actions/dependency-review-action` works on public repos without a GHAS license.
CodeQL's advanced setup is used because the repo's default-setup is `not-configured`.

Resolved action SHAs (pinned at decision time, 2026-05-28):
- `actions/checkout@v4`: `34e114876b0b11c390a56381ad16ebd13914f8d5`
- `actions/setup-node@v4`: `49933ea5288caeca8642d1e84afbd3f7d6820020`
- `github/codeql-action/{init,analyze}@v3`: `03e4368ac7daa2bd82b3e85262f3bf87ee112f57`
- `actions/dependency-review-action@v4`: `2031cfc080254a8a887f58cffee85186f0e49e48`
- `actions/upload-artifact@v4`: `ea165f8d65b6e75b540449e92b4886f43607fa02`
- `rhysd/actionlint@v1.7.12` (used via `run:` step, not `uses:` — see below): commit
  `914e7df21a07ef503a81201c76d2b11c789d3fca`, binary SHA-256
  `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` (linux_amd64)

Note: Dependabot (`dependabot.yml`, already committed) will open PRs to update these SHAs when new
versions are released. Each such PR will trigger the `Verify pinned action SHAs` job, which confirms
the updated references are still full SHAs.

## Decision

We will use **three workflow files** split by trigger and responsibility:

### Workflow 1: `.github/workflows/ci.yml`

Triggers: `push` to `dev`, `pull_request` targeting `dev`.

Jobs:
- `ci` (job ID, no `name:` field — this makes the check context exactly `ci`): install → typecheck → lint →
  test → build. Runs on `ubuntu-latest`, Node 22.x. Permissions: `contents: read`.
- `actionlint` (job ID + name — `name: actionlint`): downloads actionlint v1.7.12 linux_amd64 binary via
  `run:` step (no `uses:` means no SHA-pin complexity for this step), verifies the SHA-256 checksum, runs
  `actionlint` against all `.github/workflows/*.yml`. Permissions: `contents: read`.
- `Verify pinned action SHAs` (job `name:` field exactly): uses a `run:` step with grep to assert that
  every `uses:` line in `.github/workflows/**` that is not a local `./` action matches the pattern of a
  40-hex SHA. Fails loudly if any mutable tag reference is found. Permissions: `contents: read`.
- `Build, scan, SBOM, smoke` (job `name:` field exactly): install → `npm run build` → `npm audit
  --audit-level=high` → `npm sbom --sbom-format cyclonedx --omit dev > sbom.cdx.json` → smoke tests
  (`node dist/cli/index.js --help`, `node dist/cli/index.js --version`, unknown-command exit-2 check) →
  `actions/upload-artifact` to attach the SBOM. Permissions: `contents: read`.

### Workflow 2: `.github/workflows/codeql.yml`

Triggers: `push` to `dev`, `pull_request` targeting `dev`, `schedule` (weekly, Sunday 02:15 UTC).

Jobs:
- `Analyze` with matrix `language: [actions, javascript-typescript]`. GitHub derives check contexts
  `Analyze (actions)` and `Analyze (javascript-typescript)` from this pattern. Uses `build-mode: none`
  for `javascript-typescript` (no compiled artifact needed for JS/TS analysis). Permissions:
  `actions: read`, `contents: read`, `security-events: write`.

### Workflow 3: `.github/workflows/dependency-review.yml`

Triggers: `pull_request` targeting `dev` only (the `actions/dependency-review-action` requires a base
to diff against; it cannot run on `push`).

Jobs:
- `Review dependency diff (dev/main)` (job `name:` field exactly): runs
  `actions/dependency-review-action@v4` with `fail-on-severity: high` and `deny-licenses:` covering
  known copyleft licenses (GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.1, LGPL-3.0). Permissions:
  `contents: read`.

### Workflow file permission policy

Every workflow file declares a top-level `permissions: {}` block (deny-all default). Individual jobs
override only the permissions they need. No workflow uses `write-all` or omits the `permissions:` key.

### actionlint implementation choice

`rhysd/actionlint` does not publish a GitHub Actions marketplace action (no `action.yml` in the repo
root). We use a `run:` step that downloads the pinned binary, verifies its SHA-256 checksum, and runs it.
This avoids introducing an unpinnable `uses:` reference.

## Consequences

### Positive

- All 7 required branch-protection status checks are produced with byte-for-byte correct names; PRs can
  merge as soon as checks pass.
- SHA-pinned actions eliminate the mutable-tag attack vector in CI. Dependabot will surface updates as
  reviewable PRs rather than silent in-place changes.
- `Verify pinned action SHAs` is a self-enforcing gate: if a developer adds a new action with a mutable
  tag, the job fails immediately on their PR, before any code runs with that action.
- `npm audit` in the `Build, scan, SBOM, smoke` job catches newly published CVEs in devDependencies
  before they merge.
- The CycloneDX SBOM artifact satisfies regulated-environment audit requirements without external tooling
  or a separate pipeline.
- Three separate workflow files keep trigger logic clean and failure blast radius small: a CodeQL timeout
  does not block a fast `ci` run.

### Negative

- Three workflow files increase maintenance surface compared to one. Mitigated by the `actionlint` job
  catching schema errors in all three.
- The `Verify pinned action SHAs` grep-based check is simple but not infallible: a developer could
  technically write a valid SHA pin that still resolves to a malicious commit. This gate enforces the
  form, not the content. Actual action provenance verification requires SLSA Level 3 / Sigstore, which
  is deferred.
- `npm audit --audit-level=high` will fail the build if a high-severity CVE exists in a devDependency.
  This is intentional but may create noise on zero-day disclosure days.
- actionlint binary download adds ~3s to the `actionlint` job on every run (binary is not cached).
  Acceptable for the current check cadence.

### Neutral

- CodeQL `build-mode: none` for `javascript-typescript` means CodeQL does not need a successful build
  to analyze the code. This is correct for TS/JS and removes the ordering dependency between the `ci`
  build and the CodeQL job.
- The `schedule` trigger on `codeql.yml` (weekly Sunday 02:15 UTC) ensures the database is refreshed
  even on weeks with no commits, catching newly published query packs.

## Alternatives Considered

### Alternative 1: Single monolithic workflow file

- **Pros**: one file to maintain; simpler mental model.
- **Cons**: CodeQL requires `security-events: write` permission, which should not be granted to the fast
  `ci` job running on every push. A single file either over-permissions all jobs or requires per-job
  overrides anyway, eliminating the benefit. A 200-line single-file workflow is also harder to read.
- **Why rejected**: principle of least privilege requires separating the permission scopes. Three files
  with explicit per-job permissions is cleaner and more auditable.

### Alternative 2: Use rhysd/actionlint as a `uses:` marketplace action

- **Pros**: simpler job definition; no binary download step.
- **Cons**: `rhysd/actionlint` does not publish a GitHub Actions marketplace action (`action.yml` does
  not exist in the repo root). Using a repo reference without `action.yml` as `uses:` would either fail
  or require a composite action wrapper that does not exist. Cannot be done.
- **Why rejected**: technically infeasible.

### Alternative 3: Use mutable tag references (e.g., `uses: actions/checkout@v4`) and rely on Dependabot

- **Pros**: simpler YAML; easier for contributors to read at a glance.
- **Cons**: mutable tags allow supply-chain substitution between Dependabot PRs. The `tj-actions/
  changed-files` incident (March 2025) demonstrated that a maintainer account compromise can silently
  alter a mutable-tag action for all consumers. Enterprise security policy prohibits this.
- **Why rejected**: supply-chain risk is non-negotiable for an enterprise product. SHA pinning + the
  `Verify pinned action SHAs` job is the enforced standard.

### Alternative 4: OSSF Scorecard action for supply-chain scoring

- **Pros**: produces a structured supply-chain health score visible in the Security tab.
- **Cons**: requires `security-events: write` and `id-token: write` permissions; writes to code-scanning
  results. This is additive scope beyond issue #2 and not required by the branch protection rules.
- **Why rejected**: out of scope for issue #2. Add as a separate job in a future security-hardening issue.

### Alternative 5: External SBOM tool (Syft/Anchore) instead of `npm sbom`

- **Pros**: Syft produces richer SBOM data and supports more formats.
- **Cons**: requires a `uses:` reference to `anchore/syft-action` (another action SHA to pin and
  maintain), or a binary download step similar to the actionlint approach. `npm sbom` ships with npm
  10.9.8 (already in the environment), produces valid CycloneDX JSON, and adds zero dependencies.
- **Why rejected**: `npm sbom` is sufficient for Wave 1. The SBOM scope (npm dependencies of the package)
  matches what `npm sbom` covers. Add Syft if the SBOM needs to cover container layers or non-npm
  artifacts.

## Related

- ADR-0001: Project Foundation and Toolchain
- Issue #2: Bootstrap TypeScript npm workspace, CLI/SDK skeleton, and CI workflow
- GitHub Actions security hardening: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- tj-actions/changed-files supply chain incident: https://github.com/advisories/GHSA-mrrh-fwg4-5jwj
- actions/dependency-review-action: https://github.com/actions/dependency-review-action

## Date

2026-05-28
