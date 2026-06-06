---
name: Epic
about: Plan a coordinated delivery wave with child issues
title: 'Epic: '
labels: ['type: epic', 'status: new']
assignees: ''
---

## Summary

Describe the strategic outcome, user/developer value, and why this epic exists.

## Product Thesis

Explain the product belief this epic validates and the trust or capability it should create.

## Non-goals

- This epic does not:

## Architecture Invariants

- Existing architecture boundaries, quality gates, security posture, evidence semantics, and deterministic verification must not be weakened.
- Productive model calls must remain behind the Model Gateway.
- Workflow authority must remain explicit and documented.

## Reuse And No-Duplication Gate

- Before any new implementation is planned, inspect existing Keiko packages, UI surfaces, server routes, contracts, validation helpers, evidence models, memory/local-knowledge graph patterns, workflow state, and tool/workspace boundaries that could satisfy or partially satisfy this epic.
- Existing Keiko functionality must be reused, extended, or generalized when it can meet the target outcome without weakening architecture boundaries, security posture, evidence semantics, deterministic verification, or maintainability.
- New functionality is allowed only for capability gaps that remain after the existing-capability review is recorded in the epic or a required child issue.
- This epic must not create a parallel workspace, graph, relationship, policy, evidence, memory, connector, workflow, or UI subsystem when an existing subsystem can be extended through a documented contract.
- Prefer consolidation, refactoring, and documented extension points over adding another feature path.

## Target Outcome

1. Outcome 1.
2. Outcome 2.
3. Outcome 3.

## Child Issues

- [ ] Child issues are created from the current `Feature / Task` template, not as free-form issues.
- [ ] Every executable child issue starts with `Parent Epic: #<epic_number>`.
- [ ] Every executable child issue is added as a GitHub sub-issue of this epic so the Product Delivery board can render the epic as a swimlane.
- [ ] Child issues are ordered under this epic in the required implementation sequence.
- [ ] Child issues use `Classification: Task`, `Status: Open Issues`, `Workflow State: New` or `Triaged`, and `Human Review Required: Yes`.

## Required Implementation Order

1. First child issue.
2. Second child issue.
3. Final verification child issue.

## Definition of Done

- [ ] All child issues are closed with acceptance criteria and expected verification updated.
- [ ] Required GitHub checks are green on implementation PRs.
- [ ] Reuse, extension, or generalization decisions are recorded for every implemented child issue.
- [ ] Final closure evidence is recorded in the epic or final child issue.
- [ ] Known limitations and follow-ups are documented.

## Delivery Board Workflow

- [ ] Add this epic and all executable child issues to the public `Keiko Product Delivery` project.
- [ ] Set this epic's project fields before handoff: `Classification: Epic`, `Status: Open Epics`, `Workflow State: Triaged`, `Priority: P0 Now | P1 Next | P2 Later | P3 Backlog`, and `Human Review Required: Yes`.
- [ ] Position this epic item in the Product Delivery board according to its implementation priority so open epic swimlanes read top-to-bottom in delivery order.
- [ ] Set executable child issue project fields before handoff: `Classification: Task`, `Status: Open Issues`, `Workflow State: New` or `Triaged`, inherited or explicit `Priority`, and `Human Review Required: Yes`.
- [ ] Link every child issue as a GitHub sub-issue of this epic; do not rely only on a body link or checklist reference.
- [ ] Keep the child issue order under this epic aligned with `Required Implementation Order`.
- [ ] Keep `Workflow State` current: `New`, `Triaged`, `In Progress`, `PR Open`, `Ready for Human Review`, `Blocked`, `Waiting for User`, or `Done`.
- [ ] When an agent starts work, set the issue label to `status: in progress`, set project `Status` and `Workflow State` to `In Progress`, and fill `Owner / Agent`.
- [ ] When implementation starts, fill the `Branch` field with the active branch name.
- [ ] When a PR is opened, set `Workflow State` to `PR Open`, fill `Pull Request`, and keep `Human Review Required` set to `Yes`.
- [ ] When the PR is ready for maintainer review, set `Workflow State` to `Ready for Human Review` and replace the issue label with `status: ready for human review`.
- [ ] Only after merge and closure evidence, set the issue label to `status: done`, project `Status` to `Done`, and project `Workflow State` to `Done`.

## Agent Execution Mode

- [ ] Single-agent
- [ ] Agent team
- [ ] Audit-only
- [ ] Refactor-only
- [ ] Feature delivery
- [ ] Architecture / governance coordination
- [ ] Audit/verification-heavy

This epic is a planning and coordination container. Do not implement the full epic directly; execute the linked child issues in order.

## Agent Routing Hints

- Lead agent: `coordinator`.
- Required planning agents: `architect | explorer | security-reviewer | performance-engineer | docs-editor`.
- Delivery agents per child issue: selected from `implementor | developer | test-engineer | ui-engineer | a11y-auditor | verifier | pr-reviewer | pr-shepherd`.
- Write ownership: assigned per child issue only; no parallel write agents may own overlapping files.
- PR lifecycle owner: `pr-shepherd` waits for GitHub checks, resolves findings, and confirms formal issue completion before merge.

## Expected Verification

- [ ] Each child issue defines its own relevant verification gates.
- [ ] Required GitHub check: `ci` on every implementation PR.
- [ ] Each implementation PR records whether existing functionality was reused, extended, generalized, or why a new implementation was required.
- [ ] Security review when trust boundaries, model access, execution, patch application, generated artifacts, or validation guardrails change.
- [ ] Final regression evidence captured in the final child issue.

## Review Settlement and Formal Issue Completion

- [ ] Implementation PRs wait for required GitHub checks before merge.
- [ ] All actionable review findings are fixed or explicitly dispositioned before merge.
- [ ] Child issue Acceptance Criteria and Expected Verification checkboxes are updated only when evidence exists.
- [ ] Delivery board fields are updated before handoff, including `Owner / Agent`, `Branch`, `Pull Request`, and `Human Review Required`.
- [ ] The epic remains on the Product Delivery board as an `Open Epics` swimlane until all child issues are closed and final closure evidence exists.
- [ ] New follow-up issues are either added as sub-issues in the correct order or explicitly deferred to a separate epic with rationale.
- [ ] The epic remains open until all child issues are closed and final closure evidence is recorded.

## Stop Conditions

- [ ] Stop if the implementation would expand beyond this epic's stated scope.
- [ ] Stop if required acceptance criteria are missing, contradictory, or no longer match the linked child issues.
- [ ] Stop if the work requires secrets, customer data, private runtime logs, or token-bearing artifacts.
- [ ] Stop if two parallel agents would need to edit the same file scope.
- [ ] Stop if existing Keiko functionality can satisfy the outcome through reuse, extension, or generalization; update the epic or child issue with the reuse plan instead of implementing a duplicate subsystem.
- [ ] Stop if the change would weaken architecture boundaries, quality gates, security posture, evidence semantics, deterministic verification, or required `ci` guarantees.
- [ ] Stop after three CI or review-finding repair attempts with different root causes and report the blocker.

## Language and Professional Standard

- All issue work, PR descriptions, code comments, configuration properties, schema fields, README updates, Markdown files, and GitHub comments must be written in professional English.
- Use accurate enterprise product terminology; when limitations exist, state them precisely without prototype-only, placeholder, fake, or informal framing.
- Build production-ready, state-of-the-art solutions while keeping implementation simple, maintainable, and focused on the issue scope.
- Be creative and innovative where it improves product quality, but avoid unnecessary special cases, speculative abstractions, and process overhead.
