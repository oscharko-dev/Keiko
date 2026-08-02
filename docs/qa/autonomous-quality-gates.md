# Autonomous quality gates

Keiko ships autonomously only when repository-owned and live-promoted required checks provide
independent, exact-current-head evidence that proves the candidate clean. For that required
evidence, a missing, skipped, neutral, stale, cancelled, timed-out, quota-paced, or differently
produced result is blocking. Advisory output carries no merge authority; every finding it does emit
is still repaired. Acknowledgement, dismissal, admin bypass, and threshold relaxation are not repair
paths.

## Enforced thresholds

- Sonar unresolved pull-request issues and new violations: `0`.
- Sonar new-code coverage: `>= 85%`.
- Sonar new-code duplication: `<= 3%` until Issue #2874 can safely synchronize a `<= 1%` OSS gate.
- Sonar new-code ratings: maintainability `A`, reliability `A`, and security `A`.
- Sonar security hotspots reviewed: `100%` on new code and overall.
- Semantic clone groups introduced by the diff: `0` at `>= 100` tokens and `>= 10` lines.
- Secrets introduced anywhere in the pull-request commit range: `0`.
- TypeScript and lint: strict, no `any`, explicit returns, and `0` warnings.
- Complexity and function size: cyclomatic complexity `<= 10` and `<= 50` non-comment lines per
  function.
- Package/file coverage: no committed per-file or per-package ratchet regression.
- Deterministic performance proxies: every governed bundle, retrieval-latency, retrieval-quality,
  context-quality, and immutable performance-evidence regression fails in repository-owned gates.
- Automated-review findings: `0` unresolved blocking findings and all conversations resolved.

The 85% coverage floor is constitutional, not aspirational. Per-file floors and package ratchets
prevent a high aggregate from hiding untested changed code. Mutation testing remains the deeper
scheduled/manual proof for security-critical code; it is not placed on every pull-request critical
path because its multi-hour runtime would turn availability into merge authority.

## Parallel gate topology

The protected `ci` context aggregates independent jobs and fails closed if any dependency is not
successful:

- core quality: typecheck, lint, formatting, architecture, contract, package, security, retrieval,
  evidence, and regression gates;
- sharded package/UI/script coverage, followed by one Sonar verdict over the reassembled evidence;
- cross-platform smoke when the change can affect native behavior;
- Fallow semantic duplicate analysis over changed files only; and
- Gitleaks over every addition in the pull-request commit range, including intermediate commits.

The jobs run concurrently. Full mutation, extended end-to-end, and reference-machine performance
measurements remain scheduled or release-owned; fast deterministic proxies and affected-area tests
stay on every pull request.

## Hosted supplemental checks

SonarCloud and Socket remain independently required. CodeRabbit uses the assertive profile on every
`dev` pull request and every subsequent push with auto-pause disabled. Its status is not required
because PR #2876 proved quota can omit a review while reporting success. When CodeRabbit emits an
inline finding, GitHub's conversation-resolution requirement blocks merge until the thread is
resolved. Repair remains mandatory policy, but GitHub's resolved bit alone is not proof of a code
change in this quota-tolerant interim topology.

CodSpeed and Greptile are retired under ADR-0169. Their Apps, workflows, policies, validators, and
protected contexts are absent. The canaries proved that Greptile quota could omit current-head
review and that shared-runner CodSpeed comparisons could report materially different regressions
for unchanged inputs. Neither provider produced dependable merge evidence.

Actual performance merge authority stays with `npm run check:retrieval-latency`,
`npm run check:retrieval-quality`, `npm run check:grounded-retrieval-quality`,
`npm run check:context-quality`, `npm run check:editor-bundle-size`,
`npm run check:editor-release-evidence`, `npm run check:perf-evidence:editor`, and
`npm run check:perf-evidence`. The exact pull-request E2E checks are `npm run test:e2e:smoke`,
`npm run test:e2e:editor-run-verification-2215`, `npm run test:e2e:editor-debugging-2348`, and
`npm run test:e2e:editor-m11-closeout-2533`. The stable protected set contains ten App-bound checks
and no hosted performance dashboard or quota-paced reviewer status.

Hosted products are not described as open-source merely because their service is free for a public
repository. The merge-critical foundation is repository-owned and implemented with open-source
tooling. No payment method or paid entitlement may be introduced to restore a retired provider.

## Sonar independence

The native `SonarCloud Code Analysis` context and `scripts/check-sonar-pr-quality-gate.mjs` enforce
Sonar independently. The repository validator binds the exact current head, native gate status,
custom gate definition, metric values, unresolved issue count, and new-violation count. No review
bot or retired aggregate participates in that decision.
