# ADR-0145: Retire the agent:pre-pr aggregate local gate

## Status

Accepted (owner decision, 2026-07-19). Amends ADR-0139 (D4): the aggregate-wrapper mandate is
retired; every underlying quality gate and the required CI matrix remain unchanged.

## Context

ADR-0139 D4 introduced `npm run agent:pre-pr` as the single diff-scoped, content-addressed
aggregate every agent runs before a push or PR update. In practice the aggregate's wall-clock
cost per iteration (roughly 25 minutes for a server-touching diff: unit tests, coverage ratchet,
clean builds, e2e smoke) exceeded its marginal value: the required CI matrix executes the same
checks authoritatively on every pull request, and the review products (Qodo, CodeRabbit, Keiko
for Quality) surface the defect classes a local aggregate cannot see. The repository owner
directed the aggregate's removal on 2026-07-19.

## Decision

- Remove the `agent:pre-pr` npm alias, `scripts/agent-pre-pr.mjs`, and its co-located test.
- Local-first verification remains policy, expressed as targeted commands: before a push or PR
  update, agents run the minimum-loop commands scoped to what the change touches (`typecheck`,
  `lint`, `format:check`, `test`, `arch:check`, `arch:check:negative`) plus the touched-area
  gates listed in `AGENTS.md`, and reproduce any red required CI gate locally with the targeted
  command before pushing a fix.
- The required CI run on the pull request is the final, complete arbiter. No CI workflow
  referenced the aggregate, so the required-check surface is unchanged.

## Consequences

- The `.agent/pre-pr-report.json` and `.agent/pre-pr-cache.json` artifacts are no longer
  produced; verification claims in pull requests cite the targeted commands that actually ran.
- ADR-0139's D4 provisions (diff-scoped aggregate, content-addressed step cache, `--full` parity
  mode) are inoperative. ADR-0139's other decisions — deterministic required checks, nightly
  perf-evidence ownership, and the D10/D12 semantics — are untouched.
- `AGENTS.md` §3 and the normative `docs/qa/` references are rewritten accordingly. Historical
  evidence, planning, and troubleshooting documents that cite past `agent:pre-pr` or
  `codex:pre-pr` runs stay as recorded.
