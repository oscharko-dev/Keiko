# ADR-0134: SonarCloud Free-plan scope, coverage, and native compensation

## Status

Accepted (2026-07-13).

## Context

[ADR-0131](ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md) established
CI-based SonarCloud analysis, but the first production runs exposed four remaining governance gaps:

- scanner binaries, extraction output, working data, and logs were created close enough to the
  checkout to risk self-analysis;
- source, test, generated, binary, and native-compensated scope was not modeled by one executable
  classification;
- LCOV mapping covered only a subset of productive JavaScript and TypeScript; and
- the repository contains three productive C/C# sources even though Linux Sonar analysis cannot
  provide the same build-aware evidence as their owning operating systems.

The project remains on SonarQube Cloud's zero-cost plan. On 2026-07-13, the active project still
used the built-in `Sonar way` gate. The existing custom `Keiko Banking Grade` definition remained
publicly readable but could not be assigned through the API for this organization. Sonar's current
documentation describes AI Code Assurance as requiring both the AI-code project label and an
AI-qualified active gate. Neither an unassigned custom gate nor a repository verifier satisfies
that product-level status.

The pre-change `dev` analysis (`9b60e076-5b5c-401a-aec6-bc5c2da0bc72`, revision
`a5c7157e5a59e55bb6c9acd98b549f48271a3783`) reported 102 unresolved new-code issues: six
vulnerabilities, thirteen bugs, and eighty-three code smells. Those keys are immutable remediation
input, not a reason to move the leak period.

## Decision

### D1 — Free-plan architecture and truthful assurance status

Keiko stays on the zero-cost SonarQube Cloud plan. No delivery automation may upgrade the plan,
start a trial, add payment details, or make repository correctness depend on a paid feature.

The active native gate remains the built-in `Sonar way`. The stricter Keiko conditions are enforced
inside the required repository `ci` aggregate by one versioned gate contract. The dormant
`Keiko Banking Grade` definition is checked for drift but is never represented as the active native
gate. Keiko does not publish or claim AI Code Assurance unless SonarQube Cloud itself reports the
project as containing AI code and an AI-qualified gate is active. A repository verifier is
compensating evidence, not a Sonar badge.

This supersedes ADR-0131 D5 and D7 wherever they imply that a plan change is a desired resolution.
The restriction is now an accepted permanent operating constraint.

### D2 — One explicit and executable analysis scope

`sonar-project.properties` defines UTF-8 explicitly and keeps production and test scope disjoint.
Tracked files are classified by `scripts/sonar-analysis-scope.mjs` as exactly one of production,
test, generated/binary exclusion, native compensation, or non-analyzable repository material.
Unclassified C, C++, header, or C# files fail closed.

Tests include `tests/**`, `**/__tests__/**`, `**/*.test.*`, and `**/*.spec.*`. Dependencies, build
and coverage outputs, generated evidence, temporary state, declarations, and binary/media assets
are excluded. The scanner archive, installation, working directory, and full log all live under
`RUNNER_TEMP`; the log pipeline preserves the scanner exit status.

Scanner warnings are blocking. A future exception requires an exact, documented signature and a
bounded count with a regression test. Wildcard warning suppression is forbidden.

### D3 — Manual analysis always means the remote `dev` revision

For `workflow_dispatch`, the coverage/Sonar job checks out `dev` independently of the branch
selected in the GitHub UI. It fetches and compares the checked-out SHA with `origin/dev`, runs
coverage and scope checks, performs a main-branch scan, verifies scanner warnings, and evaluates
the resulting main analysis against the exact SHA. The New Code Definition remains
`previous_version`; neither `sonar.projectVersion` nor the leak period may be manipulated to hide
findings.

### D4 — LCOV covers the complete instrumentable production scope

The Sonar scope classifier owns the definition of coverable production JavaScript and TypeScript.
It includes package sources, root runtime entrypoints, and productive scripts while excluding
tests, fixtures, generated files, declarations, and static browser-realm assets. Package, UI, and
script coverage each produce a repository-relative LCOV report. Script coverage uses `all`
semantics through an explicit include, so an unexecuted script appears as uncovered instead of
disappearing.

`check-lcov-source-mapping` rejects a changed coverable production file without an `SF:` entry.
Non-LCOV sources require a named compensating gate: browser smoke, actionlint/zizmor, shell
guardrails, static analysis, or native quality. Coverage thresholds and the committed ratchet are
not lowered.

### D5 — Productive C/C# is excluded from Sonar and compensated natively

The following productive files are deliberately outside the Linux Sonar scope:

- `native/portable-launcher/keiko-portable-launcher.c`;
- `native/portable-launcher/macos-keychain-helper.c`; and
- `scripts/windows-portable-rfc3161.cs`.

`scripts/native-quality-scope.json` maps every native source to its platforms and required gates.
On macOS, Clang compiles C17 with strict warnings-as-errors, runs the Clang static analyzer, and
executes hermetic launcher/keychain-boundary checks. On Windows, MSVC compiles and analyzes the
launcher with `/std:c17 /W4 /WX /analyze`; .NET builds the RFC3161 implementation with current
built-in analyzers and warnings-as-errors before the existing hermetic fixtures run.

These checks are part of `cross-platform-smoke`, which is a mandatory dependency of the required
`ci` aggregate. A failed, skipped, cancelled, neutral, stale, or missing platform result blocks the
merge. Release signing, notarization, and portable-asset evidence remain separate and are not
replaced by these PR gates.

### D6 — Count-aware Free-plan gate semantics

The repository verifier enforces all of the following on the exact PR head: native gate `OK`, no
unresolved PR issues, `new_violations = 0`, new-code coverage at least 85 percent, new-code
duplication at most 3 percent, and 100 percent review of both new and overall security hotspots.
The overall hotspot evidence is read from the current `dev` main analysis. Overall security and
reliability ratings remain outside this PR gate while legacy debt exists.

A missing rate is acceptable only when Sonar explicitly reports its applicability count as zero.
A positive count without a rate fails; a missing count also fails. This rule applies independently
to lines to cover, duplicated lines, new hotspots, and overall hotspots. The verifier also compares
the publicly readable dormant `Keiko Banking Grade` definition with the repository contract and
fails on identity or condition drift.

### D7 — The 102 new-code findings are mandatory remediation input

The immutable baseline in `docs/qa/sonarcloud-new-code-baseline-2026-07-13.json` records every
issue key and its analysis identity before scope changes. Each key must receive exactly one
evidenced outcome in a separate remediation change: a code fix with regression proof, a proven
false positive, or an individually justified accepted risk backed by a compensating control.
Bulk disposition without data-flow or control-flow review is forbidden.

This narrowly supersedes ADR-0131 D6: the older overall backlog remains visible legacy debt, but
these 102 issues are specifically committed remediation scope. Their New Code Definition,
project version, and baseline date are not moved to conceal them.

## Consequences

### Positive

- Analysis scope, LCOV applicability, scanner warnings, and native compensation are executable and
  drift-tested instead of prose-only.
- Every productive native source has build-aware evidence on its owning platform.
- Manual analyses are reproducibly bound to the current remote `dev` commit.
- Free-plan limitations and AI assurance status are represented without unsupported badges or
  paid dependencies.

### Negative

- The required aggregate now waits for the Windows and macOS matrix.
- Complete script/root coverage makes previously invisible untested files visible and can require
  additional tests before a PR becomes green.
- A scanner warning or missing Sonar applicability counter blocks delivery until its cause is
  understood.

## Alternatives Considered

### Upgrade the SonarQube Cloud plan

Rejected by maintainer decision. Keiko must extract the available zero-cost value and keep stronger
requirements in open repository gates.

### Send C/C# through the Linux CLI scan without build context

Rejected because it would produce incomplete or misleading evidence. Native compilation, analyzer,
and behavior gates on the owning platforms are the explicit equivalent control.

### Reset the New Code baseline

Rejected because it would hide the 102 findings rather than resolve or disposition them.

## Related

- [ADR-0131](ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md) — superseded in the
  limited areas named above.
- [Autonomous quality gates](../qa/autonomous-quality-gates.md) — direct required-check composition and
  aggregate evidence
  rules.
- [SonarQube Cloud subscription plans](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans)
- [SonarQube Cloud quality gates for AI code](https://docs.sonarsource.com/sonarqube-cloud/standards/ai-code-assurance/quality-gates-for-ai-code)
