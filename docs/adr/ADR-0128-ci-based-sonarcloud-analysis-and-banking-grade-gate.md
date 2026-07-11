# ADR-0128: CI-based SonarCloud analysis and the Keiko Banking Grade quality gate

## Status

Accepted (2026-07-11).

## Context

Keiko is developed almost exclusively by coding agents (Agentic Engineering) for regulated banking
and insurance customers. An independent, externally verifiable static-analysis gate is a natural
complement to the local ESLint/typecheck/arch:check gates: it is not written by the same agents
that write the product code, and it is the artifact regulated customers expect to see.

A 2026-07-11 audit of the SonarCloud project `oscharko-dev_Keiko` (organization `oscharko-dev`)
found:

- Analysis ran via **Automatic Analysis** (Autoscan): no `sonar-project.properties`, no Sonar step
  in `.github/workflows/*`, no `SONAR_TOKEN` secret. Only two analyses existed, both from the audit
  day itself.
- **Automatic Analysis does not support monorepos.** Keiko is an npm-workspaces monorepo
  (`packages/*`) — this alone makes Autoscan structurally unable to analyze the repository
  correctly, independent of any Quality Gate question.
- **Automatic Analysis cannot import coverage reports** for JavaScript/TypeScript. The measured
  `new_coverage` Quality Gate condition (`< 80`) was consequently unevaluable — `coverage` measured
  as "no data" on the project, not merely under a lenient value.
- The Quality Gate was the unmodified built-in **"Sonar way"**, New Code Definition
  `mode=previous_version` with a `VERSION` event of `"not provided"` (Autoscan never sets
  `sonar.projectVersion`).
- The project carried 3,558 OPEN/CONFIRMED issues (40 BLOCKER, 463 CRITICAL, 1,375 MAJOR, 1,676
  MINOR; 69 VULNERABILITY, 143 BUG, 3,346 CODE_SMELL) accumulated before this ADR, with no
  governance decision recorded for how to treat them.

## Decision

### D1 — CI-based analysis, embedded in the existing required `ci` job

Automatic Analysis is replaced by CI-based analysis using
`SonarSource/sonarqube-scan-action@713881670b6b3676cda39549040e2d88c70d582e` (v8.2.0, SHA verified
against the upstream repository tags at authoring time). The scan step is added **inside the
existing required `ci` job** in `.github/workflows/ci.yml`, not as a new job or a new required
check — following the precedent already recorded in
[ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md) Alternative 4 (embedding a gate in
an existing required job avoids a branch-protection admin change). The scan step runs after
"Coverage quality gates" so the lcov reports it consumes already exist, and is skipped under the
same condition as that step (PRs targeting `feat/keiko-editor`).

### D2 — The Quality Gate blocks the merge via the existing `ci` check

The scan step passes `-Dsonar.qualitygate.wait=true`, which makes the scanner poll the
server-computed Quality Gate result and exit non-zero when it is red. Because `ci` is already a
required status check on `dev`'s branch protection, this makes the SonarCloud Quality Gate
merge-blocking without any branch-protection configuration change.

### D3 — lcov coverage wiring

`"lcov"` is added to the `reporter` array of the two coverage-gated Vitest configs
(`vitest.coverage.packages.config.ts` and `packages/keiko-ui/vitest.coverage.config.ts`), alongside
the existing `text`/`json`/`json-summary` reporters used by the local coverage-baseline ratchet
(`scripts/check-package-coverage.mjs`), which are unchanged. `sonar-project.properties` points
`sonar.javascript.lcov.reportPaths` at both `coverage/packages/lcov.info` and
`packages/keiko-ui/coverage/lcov.info`. `sonar.javascript.lcov.reportPaths` covers both JavaScript
and TypeScript; the equivalent `sonar.typescript.lcov.reportPaths` key is deprecated upstream and is
deliberately not set.

### D4 — New Code Definition: keep `previous_version`, fix the data defect

The New Code Definition is **not** changed to Reference Branch, even though Sonar's own guidance
recommends Reference Branch for trunk-based development without a PR workflow. Keiko's workflow is
PR-gated (branch protection on `dev`, no direct pushes), and SonarCloud's PR analysis always
computes "new code" as the diff between the PR branch and its target branch regardless of the
project's New Code Definition setting — so Reference Branch would add no precision here. Instead,
the underlying defect (Autoscan never sets `sonar.projectVersion`, so the `previous_version` period
degrades to an unnamed `"not provided"` marker) is fixed by resolving the project version from
`package.json` at scan time and passing it via `-Dsonar.projectVersion`.

### D5 — Quality Gate hardening (New Code only, zero-tolerance for new findings)

The built-in "Sonar way" gate is kept as the baseline; the following changes harden it for a
regulated, agent-authored codebase (implemented as a copy of "Sonar way",
**"Keiko Banking Grade"**, id `156389` in the `oscharko-dev` organization):

| Condition | Change | Rationale |
| --- | --- | --- |
| `new_violations > 0` (metric `new_violations`, verified present and not hidden via `api/metrics/search`) | **added** | Explicit maintainer decision (2026-07-11): a PR is only green with **zero new findings of any severity** on new code — not merely an acceptable rating. Since new code is authored almost exclusively by coding agents, there is no reason to tolerate a new Minor/Info finding that a rating-based condition would silently allow; the agent fixes it before the PR is done. This subsumes and is strictly stronger than the four rating-based conditions below, which are kept for their per-dimension (security/reliability/maintainability) diagnostic signal in the Sonar UI. |
| `new_coverage < 80` | tightened to `< 85` | Explicit maintainer decision (2026-07-11): raises the bar on new-code test coverage beyond the Sonar-way default, once CI-based analysis (D1–D3) makes coverage measurable at all. |
| `security_hotspots_reviewed < 100` (overall, not `new_`) | added | Free to add: 0 hotspots existed at audit time, so this fixes today's clean state as a floor that must never regress. |
| `new_duplicated_lines_density > 3` | **kept at the Sonar-way default** | An initial tightening to `> 2` was reverted per explicit maintainer decision (2026-07-11): `new_violations > 0` already fails the gate on any new duplication-related finding, so a separate, stricter duplication-density threshold added no coverage and stayed at the built-in default. |

Any condition on **overall** (non-new-code) ratings was deliberately **not** added: overall
Reliability/Security ratings measured D/E at audit time due to the pre-existing 3,558 issues, and a
gate condition on overall ratings would fail permanently regardless of the current change —
contradicting Sonar's own Clean-as-You-Code guidance, which scopes gates to new code specifically
so legacy debt does not block delivery. `new_violations = 0` does not have this problem: it is
already scoped to new code only, so D6's legacy-debt acceptance is unaffected.

The final condition set, as applied via the SonarCloud API (`qualitygates/copy`,
`create_condition`, `update_condition`):

```
new_security_rating              GT  1
new_reliability_rating           GT  1
new_maintainability_rating       GT  1
new_coverage                     LT  85
new_duplicated_lines_density     GT  3
new_security_hotspots_reviewed   LT  100
security_hotspots_reviewed       LT  100
new_violations                   GT  0
```

**Known limitation at authoring time**: assigning "Keiko Banking Grade" to the project (via
`qualitygates/select`) and setting it as the organization default (via `qualitygates/set_as_default`)
both failed with `HTTP 403 "Organization ... is not allowed to modify Quality gates"` — a SonarCloud
plan/tier restriction on activating a non-built-in gate, not a permissions or configuration error.
Gate creation and condition management are unrestricted on the current plan; gate activation is
not. Resolving this requires either a SonarCloud plan change or confirming via the SonarCloud UI
whether it permits what the API currently rejects — both are human-executed follow-ups (D7).

### D6 — The 3,558 pre-existing issues are accepted legacy debt, not blocking

Per explicit maintainer decision (2026-07-11): the pre-existing issue backlog (40 BLOCKER, 463
CRITICAL, 1,375 MAJOR, 1,676 MINOR across 69 VULNERABILITY / 143 BUG / 3,346 CODE_SMELL) is tracked
as visible legacy debt in the SonarCloud dashboard and is **not** subject to a remediation quota or
deadline by this ADR. Only new code is gated (D5). This decision is recorded here so it is not
silently reinterpreted as an oversight later; revisiting it requires an amendment to this ADR.

### D7 — Deferred to a separate, human-executed step

The following require a SonarCloud UI action and are explicitly **out of scope** for this ADR's
repository diff. Each was confirmed (2026-07-11, via `api/webservices/list`) to have **no
corresponding public API action on this SonarCloud plan** — these are not merely permission-blocked
like the Quality Gate activation in D5, the endpoints do not exist at all for this org/plan, so
there is no API path to automate them even with an admin token:

- **Disable Automatic Analysis.** `sonar.autoscan.enabled` currently reads `true` at the project
  level, inherited from the organization default (`api/settings/values`); no project-level override
  exists yet and no API action can set one. Human action: Project → Administration → Analysis
  Method → deactivate Automatic Analysis, once a CI-based analysis run has completed successfully
  (avoids two conflicting analysis sources running in parallel).
- **AI Code Assurance activation** (`contains_ai_code` project flag + qualifying gate assignment).
  No `set_contains_ai_code`-equivalent action exists in this instance's public API (only a read-only
  `api/project_badges/ai_code_assurance` badge-image endpoint was found). Human action: Project
  Settings → General → AI Code Assurance → mark "Contains AI-generated code", then assign a
  qualifying gate — which is blocked by the same plan restriction as D5 until resolved.
- Any change to the "Administer Issues" permission template (who may reclassify issues as Won't
  Fix/False Positive) — a governance decision, not a technical one, and never an action this ADR's
  automation performs regardless of API availability.

## Consequences

### Positive

- The monorepo is analyzed correctly (Automatic Analysis could not do this at all).
- Coverage becomes measurable and gate-relevant for the first time.
- The Quality Gate becomes real merge-blocking pressure on new code without any branch-protection
  admin change.
- The New Code Definition's underlying data defect (missing project version) is fixed rather than
  papered over by switching modes.

### Negative

- The `ci` job grows by two steps (scanner download + Quality Gate polling), adding to its runtime.
- A `SONAR_TOKEN` secret is now a dependency of the required `ci` check; if it expires or is
  revoked, `ci` fails closed for every PR until it is rotated.
- `new_violations > 0` is strict: a single new Minor/Info finding blocks the merge, with no
  built-in exception path other than fixing it or an explicit, reviewed issue-status change in
  SonarCloud (see D7 on who may make that change). This is intentional (D5), not an oversight.

### Neutral

- The 3,558 pre-existing issues remain visible in the SonarCloud dashboard as accepted legacy debt
  (D6), not as a blocking condition.
- AI Code Assurance, Automatic Analysis deactivation, and permission-template governance are
  tracked as follow-up human actions, not part of this diff.

## Alternatives Considered

### Alternative 1: Keep Automatic Analysis

Rejected outright: Automatic Analysis does not support monorepos and cannot import JS/TS coverage
reports. Both limitations are structural, not configuration issues, so no Quality Gate tuning could
have made Automatic Analysis fit for this repository.

### Alternative 2: New dedicated GitHub Actions job/required check for Sonar

**Pros**: Gate failure is visible as its own named check. **Cons**: requires a branch-protection
configuration change (adding a new required check) needing admin coordination. **Why rejected**:
embedding the scan inside the already-required `ci` job achieves the same merge-blocking effect
with zero branch-protection changes, mirroring the exact trade-off already decided in
[ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md) Alternative 4 for the
`arch:check` gate.

### Alternative 3: New Code Definition = Reference Branch (`dev`)

**Pros**: Sonar's documented default recommendation for trunk-based development. **Cons**: Keiko
does not do trunk-based development without PRs — it requires PRs via branch protection, and
SonarCloud's PR analysis already diffs against the target branch regardless of the project-level
New Code Definition. Reference Branch would add configuration without adding precision.
**Why rejected**: no material benefit for this workflow; the actual defect (missing project
version) is a data problem, not a mode problem.

### Alternative 4: Gate blocking on overall (non-new-code) ratings

**Pros**: maximally strict; fully closes the "known vulnerability" gap, including legacy debt.
**Cons**: overall ratings are D/E today purely from pre-existing debt — a gate on them fails
permanently starting from this ADR, blocking every future PR regardless of its own quality.
**Why rejected**: contradicts Clean-as-You-Code, which scopes gates to new code specifically so
that legacy debt doesn't block delivery; revisit only after D6's legacy backlog has been
substantively reduced. This is distinct from `new_violations = 0` (D5), which is scoped to new code
only and was adopted, not rejected.

## Awareness of concurrent work (not a dependency)

At authoring time, [Epic #2291](https://github.com/oscharko-dev/Keiko/issues/2291) (dependency/runtime
modernization: generated-secret prevention, Node 24 LTS, React 19) and
[Epic #2266](https://github.com/oscharko-dev/Keiko/issues/2266) (native TypeScript 7 compiler
adoption) are in flight in parallel. Neither is a prerequisite for this ADR:

- This diff does not touch `package.json` or `package-lock.json`, so it does not conflict with the
  serialized manifest/lockfile write ownership both epics establish between themselves.
- Epic #2266's current phase keeps the TypeScript **API** at 6.0.3 and only swaps the native `tsc`
  **binary** for build speed; it is not a language/syntax version jump. SonarCloud's TypeScript
  analyzer uses its own bundled parser, independent of the project's installed `typescript` version,
  so `sonar-project.properties` and the scan step need no adjustment for this phase. Re-verify once
  #2270 (final TypeScript 7 API migration and compatibility-layer removal) lands, in case a later
  phase does introduce syntax the Sonar analyzer version in use does not yet parse.
- Epic #2294 (Node 24 LTS, part of #2291) is likely to touch `.github/workflows/ci.yml`'s
  `actions/setup-node` step — the same file this ADR changes. No logical conflict is expected (different
  steps), but the two PRs should be sequenced/rebased deliberately rather than merged concurrently
  without review.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md) — the monorepo topology that Automatic
  Analysis cannot handle.
- [ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md) — the embed-in-existing-job
  precedent this ADR reuses (Alternative 4).
- [ADR-0021](ADR-0021-publish-strategy-bundled-monorepo-product.md) — bundled monorepo product
  context.
- [ADR-0025](ADR-0025-forward-only-0-2-0-modular-baseline.md) — current package baseline this
  analysis covers.
