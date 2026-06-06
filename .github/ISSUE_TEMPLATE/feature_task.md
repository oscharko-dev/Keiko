---
name: Feature / Task
about: Propose a new feature, implementation task, or chore
title: ''
labels: ['type: task', 'status: new']
assignees: ''
---

Parent Epic: #<epic_number>

## Purpose

Describe the goal of this issue and the user, developer, platform, or governance outcome it must create.

## Epic And Board Placement

- [ ] `Parent Epic: #<epic_number>` is present and points to the governing open epic.
- [ ] This issue is linked as a GitHub sub-issue of the parent epic, not only referenced in Markdown.
- [ ] This issue appears under the parent epic swimlane on the public `Keiko Product Delivery` board.
- [ ] Project fields are set before handoff: `Classification: Task`, `Status: Open Issues`, `Workflow State: New` or `Triaged`, inherited or explicit `Priority`, and `Human Review Required: Yes`.
- [ ] The parent epic remains `Classification: Epic`, `Status: Open Epics`, and positioned in the board's top-to-bottom implementation order.
- [ ] Card Chat or conversation-card work uses this same parent/sub-issue and board placement flow; do not create loose chat/card issues outside an epic swimlane.

## Agent Execution Mode

- [ ] Single-agent
- [ ] Agent team
- [ ] Audit-only
- [ ] Refactor-only
- [ ] Feature delivery
- [ ] Audit/verification-heavy
- [ ] Human-led / agent-assisted

## Agent Routing Hints

- Lead agent: `coordinator | developer | architect | pr-shepherd`.
- Suggested specialist agents: `explorer | implementor | test-engineer | security-reviewer | performance-engineer | a11y-auditor | docs-editor | docs-writer | verifier | pr-reviewer | pr-shepherd`.
- Primary area label: `area:...`.
- Expected write ownership: list files/modules that may be edited, or say `TBD by coordinator`.

## Existing Capability Review

- [ ] Existing Keiko packages, UI surfaces, server routes, contracts, validation helpers, evidence models, memory/local-knowledge graph patterns, workflow state, and tool/workspace boundaries were inspected before implementation.
- [ ] The issue identifies what will be reused, extended, generalized, or left untouched.
- [ ] Any new implementation is justified as a real capability gap, not a parallel implementation of existing behavior.
- [ ] Refactoring or consolidation was considered when existing functionality is close but not yet shaped for this issue.

## Delivery Board Workflow

- [ ] Add this issue to the public `Keiko Product Delivery` project before work starts.
- [ ] Set project `Classification` to `Task`.
- [ ] Set project `Status` to `Open Issues` while the issue is open and unclaimed.
- [ ] Confirm this issue is visible under the parent epic swimlane through the GitHub sub-issue relationship.
- [ ] Keep `Workflow State` current: `New`, `Triaged`, `In Progress`, `PR Open`, `Ready for Human Review`, `Blocked`, `Waiting for User`, or `Done`.
- [ ] When an agent starts work, set the issue label to `status: in progress`, set project `Status` and `Workflow State` to `In Progress`, and fill `Owner / Agent`.
- [ ] When implementation starts, fill the `Branch` field with the active branch name.
- [ ] When a PR is opened, set `Workflow State` to `PR Open`, fill `Pull Request`, and keep `Human Review Required` set to `Yes`.
- [ ] When the PR is ready for maintainer review, set `Workflow State` to `Ready for Human Review` and replace the issue label with `status: ready for human review`.
- [ ] Do not mark `Done` until the PR is merged, closure evidence exists, the issue is closed, and project `Status` is set to `Done`.

## Expected Verification

- [ ] Required GitHub check: `ci`.
- [ ] Reuse/extension/generalization evidence or gap rationale is documented in the issue or linked PR.
- [ ] Studio browser quality gate when Studio UI or BFF browser behavior changes.
- [ ] Studio performance and memory gates when editor performance, Monaco, rendering, or large-output behavior changes.
- [ ] Studio visual regression when visible UI structure changes.
- [ ] Markdown link check when documentation changes.
- [ ] W0.2 release gate when W0.2 product-path semantics change.
- [ ] W0.3 release gate when W0.3 workflow or Studio hardening semantics change.
- [ ] Security review when trust boundaries, auth/session, secrets, CSP, model access, execution, patch application, or external calls change.
- [ ] Qodana/static-analysis review when security-sensitive or shared control-plane code changes.

## Review Settlement and Formal Issue Completion

- [ ] The implementation PR waits for required GitHub checks before merge.
- [ ] All actionable review findings are fixed or explicitly dispositioned in the PR before merge.
- [ ] Acceptance Criteria and Expected Verification checkboxes are updated only when evidence exists.
- [ ] Delivery board fields are updated before handoff, including `Owner / Agent`, `Branch`, `Pull Request`, and `Human Review Required`.
- [ ] Required documentation, PR evidence, issue comments, migration notes, screenshots, logs, or follow-up issues are completed when requested by this issue.
- [ ] The issue remains open until implementation is merged, review findings are settled, and closure evidence is recorded.

## Stop Conditions

- [ ] Stop if the implementation would expand beyond this issue's stated scope.
- [ ] Stop if required acceptance criteria are missing, contradictory, or no longer match the linked epic.
- [ ] Stop if the work requires secrets, customer data, private runtime logs, or token-bearing artifacts.
- [ ] Stop if two parallel agents would need to edit the same file scope.
- [ ] Stop if existing Keiko functionality can satisfy the issue outcome through reuse, extension, or generalization; update the issue or PR with the reuse plan instead of implementing a duplicate subsystem.
- [ ] Stop if the change would weaken architecture boundaries, quality gates, security posture, evidence semantics, deterministic verification, or required `ci` guarantees.
- [ ] Stop after three CI or review-finding repair attempts with different root causes and report the blocker.

## Language and Professional Standard

- All issue work, PR descriptions, code comments, configuration properties, schema fields, README updates, Markdown files, and GitHub comments must be written in professional English.
- Use accurate enterprise product terminology; when limitations exist, state them precisely without prototype-only, placeholder, fake, or informal framing.
- Build production-ready, state-of-the-art solutions while keeping implementation simple, maintainable, and focused on the issue scope.
- Be creative and innovative where it improves product quality, but avoid unnecessary special cases, speculative abstractions, and process overhead.

## Scope

Clearly define what is in scope. Remember: no implementation happens without an issue.

## Out of Scope

List items that are explicitly not part of this issue. Use follow-up issues for deferred scope.

## Deliverables

- [ ] Deliverable 1
- [ ] Deliverable 2

## Acceptance Criteria

- [ ] Criteria 1
- [ ] Criteria 2

## Engineering Notes

Add specific constraints, architectural notes, related ADRs, or known implementation risks.
