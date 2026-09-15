---
name: Epic
about: Plan a coordinated delivery wave with child issues
title: "Epic: Connector capability library for workspace widgets"
labels: ["type: epic", "status: new"]
assignees: ""
---

## Summary

Build a central connector capability library so workspace connections are not only visual lines.
Every connectable widget, file field, and future workspace surface should advertise typed
capabilities, accepted inputs, authority requirements, and user-visible outcomes through one shared
contract that Keiko Chat and later agent runs can discover and invoke.

## Product Thesis

Non-technical users should be able to connect workspace surfaces and immediately understand that the
connection has semantic value. A connected Chat should know what a Git widget, file widget,
knowledge pod, editor selection, or future widget can do, which inputs it can safely provide, and
where generated results should appear for human review.

## Non-goals

- This epic does not:
  - Replace the existing relationship engine or draw-only connector UI in one step.
  - Grant model egress, file access, Git mutation, or external delivery authority by connection
    alone.
  - Implement every future widget capability before the registry contract is proven.
  - Create a parallel tool, graph, relationship, memory, workflow, or evidence subsystem.

## Architecture Invariants

- Existing architecture boundaries, quality gates, security posture, evidence semantics, and
  deterministic verification must not be weakened.
- Productive model calls must remain behind the Model Gateway.
- Workflow authority must remain explicit and documented.
- Visual connection state must be optimistic and immediate; expensive capability preparation may
  settle asynchronously without leaving the user uncertain.
- A connector capability can advertise what is possible, but every invocation still validates the
  current source, target, selected data, user intent, and authority envelope.
- Connected-source content and generated outputs remain untrusted data until validated by the
  receiving capability.

## Implementation Orchestrator Revalidation Contract

- **Before planning and implementation, revalidate against the current code and architecture.**
- Before sequencing, assigning, or implementing Epic work, the orchestrator must re-audit:
  - the current target branch/code state,
  - the current package graph and dependencies,
  - relevant contracts, ADRs, and governing gates,
  - existing implementations and reusable subsystems,
  - concurrent or in-flight work that can invalidate assumptions.
- Epic and child issue text must capture product goals, invariants, constraints, acceptance
  boundaries, evidence expectations, and an initial decomposition.
- Working, clean, secure, verified current code is authoritative. Any divergence from initial plan
  must be evidence-backed and traceable.
- A genuinely new product decision, unsafe conflict, or material scope expansion is escalated to the
  Product Owner before implementation continues.
- Closeout depends on verified current-head behavior and evidence, not checklist completion alone.

## Reuse And No-Duplication Gate

- Reuse and generalize the existing relationship engine, connector rendering, widget identity model,
  Chat Git-change scope, file-source connection flow, Model Gateway, authority gates, and activity
  log.
- Do not add a second connector graph or a second tool registry when the existing systems can be
  extended through typed capability descriptors.
- Record every capability gap before adding new surface area.

## Target Outcome

1. A central registry exposes connector capabilities for each source/target pair, including typed
   inputs, expected outputs, authority requirements, lifecycle states, and UI placement hints.
2. Connecting two surfaces provides immediate visual confirmation while capability preparation runs
   asynchronously and reports a typed ready, blocked, or stale state.
3. Keiko Chat can discover connected capabilities and invoke an explicit operation, such as drafting
   a commit message from the Git widget's currently staged selection and writing the proposed
   summary/body into the Git commit form.
4. Future agent/model runs can inspect the same capability library to understand available
   connector operations without scraping UI text or duplicating widget-specific logic.
5. Connector invocations are observable through body-free activity-log events with correlation ids,
   state transitions, source/target ids, capability ids, and closed failure reasons.

## Planned Update Impact

- Release-note categories expected: `new-additions`, `improvements`, `ui-polish`,
  `state-or-compatibility-changes`.
- User-visible change summary: Workspace connectors become functional, discoverable capability
  links rather than only visual relationships.
- Release-note bullet: Workspace connectors can advertise and invoke typed widget capabilities, with
  immediate visual feedback and governed Keiko Chat integration.
- State or compatibility areas expected: workspace relationship state, widget capability metadata,
  chat connected-source state, activity-log operation catalog.
- Supported-from baseline: Keiko 1.0.x workspace UI with existing widget connector relationships.
- User action required and remediation: none expected; existing visual connections should migrate or
  project to compatible capability descriptors.
- Release-note aggregation rule: Aggregate child issues under one connector-capability entry unless a
  child adds a distinct user-facing widget capability.
- Internal-only items that must stay out of default patch notes: registry implementation details,
  body-free evidence schema hashes, gate wiring.

## Child Issues

- [ ] Child issues are created from the current `Feature / Task` template, not as free-form issues.
- [ ] Every executable child issue starts with `Parent Epic: #<epic_number>`.
- [ ] Every executable child issue is added as a GitHub sub-issue of this epic so the Product
      Delivery board can render the epic as a swimlane.
- [ ] Child issues are ordered under this epic in the required implementation sequence.
- [ ] Child issues use `Classification: Task`, `Status: Open Issues`, `Workflow State: New` or
      `Triaged`, and `Human Review Required: No`.

## Required Implementation Order

1. Audit existing connector, relationship, Chat scope, and widget source systems; record reuse points
   and gaps.
2. Define the shared connector capability contract and registry ownership.
3. Convert existing visual connector flows to immediate optimistic confirmation plus typed
   asynchronous capability readiness.
4. Implement Git widget to Chat capability discovery for staged-diff commit and PR-description
   drafting.
5. Add the Chat-to-Git commit-draft operation: selected staged files plus optional user instruction
   produce editable summary/body in the Git commit form.
6. Add evidence, logging, accessibility, performance, browser-compatibility, and regression coverage.
7. Validate N+1 widgets and N+1 repositories in real browser workflows before closeout.

## Definition of Done

- [ ] The integration branch is green on required checks before any closeout evidence document is
      written.
- [ ] Every child was closed only after each acceptance criterion had a test that failed before the
      change and passed after.
- [ ] Children were composed by merges, not accumulated as direct commits.
- [ ] All child issues are closed with acceptance criteria and expected verification updated.
- [ ] Required GitHub checks are green on implementation PRs.
- [ ] Reuse, extension, or generalization decisions are recorded for every implemented child issue.
- [ ] Final closure evidence is recorded in the epic or final child issue.
- [ ] Known limitations and follow-ups are documented.

## Delivery Board Workflow

- [ ] Add this epic and all executable child issues to the public `Keiko Product Delivery` project.
- [ ] Set this epic's project fields before autonomous delivery: `Classification: Epic`,
      `Status: Open Epics`, `Workflow State: Triaged`, priority, and `Human Review Required: No`.
- [ ] Position this epic item in the Product Delivery board according to its implementation priority.
- [ ] Keep child issue order under this epic aligned with `Required Implementation Order`.
- [ ] Keep `Workflow State` current: `New`, `Triaged`, `In Progress`, `PR Open`, `Blocked`,
      `Waiting for User`, or `Done`.

## Agent Execution Mode

- [x] Single-agent
- [ ] Agent team
- [ ] Audit-only
- [ ] Refactor-only
- [x] Feature delivery
- [x] Architecture / governance coordination
- [x] Audit/verification-heavy

This epic is a planning and coordination container. Do not implement the full epic directly; execute
the linked child issues in order.

## Agent Routing Hints

- Lead agent: `coordinator`.
- Required planning agents: `architect | explorer | security-reviewer | performance-engineer |
docs-editor`.
- Delivery agents per child issue: selected from `implementor | developer | test-engineer |
ui-engineer | a11y-auditor | verifier | pr-reviewer | pr-shepherd`.
- Write ownership: assigned per child issue only; no parallel write agents may own overlapping files.
- PR lifecycle owner: `pr-shepherd`.

## Expected Verification

- [ ] Unit tests for capability registry validation, invocation admission, and stale-source handling.
- [ ] UI tests for immediate connector confirmation, asynchronous ready/blocked states, and
      accessible status announcements.
- [ ] Server tests for authority denial, stale source, body-free logging, and no model egress without
      explicit user intent.
- [ ] Real-browser tests with multiple widgets, multiple repositories, and selected-file subsets.
- [ ] Performance checks for N+1 windows/connectors so connector overlays and capability updates stay
      responsive.
- [ ] Cross-browser compatibility checks for pointer/drag/keyboard paths supported by Keiko's browser
      baseline.

## Review Settlement and Formal Issue Completion

- [ ] Implementation PRs wait for required GitHub checks before merge.
- [ ] All actionable review findings are fixed or explicitly dispositioned before merge.
- [ ] Child issue acceptance criteria and expected verification checkboxes are updated only when
      evidence exists.
- [ ] Delivery board fields are updated before handoff.
- [ ] The epic remains open until all child issues are closed and final closure evidence is recorded.

## Stop Conditions

- [ ] Stop if implementation would expand beyond this epic's stated scope.
- [ ] Stop if required acceptance criteria are missing, contradictory, or no longer match linked child
      issues.
- [ ] Stop if the work requires secrets, customer data, private runtime logs, or token-bearing
      artifacts.
- [ ] Stop if existing Keiko functionality can satisfy the outcome through reuse, extension, or
      generalization; update the epic or child issue with the reuse plan instead of implementing a
      duplicate subsystem.
- [ ] Stop if the change would weaken architecture boundaries, quality gates, security posture,
      evidence semantics, deterministic verification, or required CI guarantees.

## Language and Professional Standard

- All issue work, PR descriptions, code comments, configuration properties, schema fields, README
  updates, Markdown files, and GitHub comments must be written in professional English.
- Use accurate enterprise product terminology; when limitations exist, state them precisely without
  prototype-only, placeholder, fake, or informal framing.
- Build production-ready, state-of-the-art solutions while keeping implementation simple,
  maintainable, and focused on the issue scope.
