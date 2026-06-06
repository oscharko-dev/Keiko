## Summary

Describe what changed and why it matters for Keiko.

Refs #<issue_number>

## Scope

- In scope:
- Out of scope:

## Reuse And No-Duplication

- [ ] Existing Keiko functionality was inspected before implementation.
- [ ] This PR reuses, extends, generalizes, or consolidates existing functionality where practical.
- [ ] Any new implementation is limited to a documented capability gap in the linked issue.
- [ ] This PR does not introduce a parallel workspace, graph, relationship, policy, evidence, memory, connector, workflow, or UI subsystem where an existing subsystem can be extended.
- [ ] Refactoring or consolidation was considered when existing functionality was close but not shaped for this change.

## Delivery Board

- [ ] Linked issue is in the public `Keiko Product Delivery` project.
- [ ] Linked issue has a valid `Parent Epic: #<epic_number>` unless this PR updates an epic container directly.
- [ ] Linked issue is attached as a GitHub sub-issue of its parent epic so it appears in the correct board swimlane.
- [ ] Parent epic is on the board with `Classification: Epic`, `Status: Open Epics`, and priority/order set for top-to-bottom implementation sequencing.
- [ ] Linked task/card issue is on the board with `Classification: Task`, `Status: In Progress` while active, inherited or explicit `Priority`, and `Human Review Required: Yes`.
- [ ] Project `Status` is `In Progress` while work is active, or `Done` only after merge and closure evidence.
- [ ] Project `Workflow State` is `PR Open` or `Ready for Human Review`.
- [ ] `Owner / Agent`, `Branch`, `Pull Request`, and `Human Review Required` are filled.
- [ ] Issue label reflects the current state: `status: in progress`, `status: ready for human review`, or `status: done` after merge.
- [ ] Autonomous agents did not merge into `dev`, enable auto-merge, close the issue, or bypass human review unless explicitly authorized by the human maintainer.

## Product Impact

- [ ] UI or user workflow
- [ ] CLI or developer workflow
- [ ] Core generation engine
- [ ] Evidence, audit, or compliance artifact
- [ ] Security or supply chain
- [ ] Packaging, release, or npm publication
- [ ] Documentation or repository hygiene
- [ ] No user-facing behavior change

## Verification

Required:

- [ ] Required GitHub checks pass before merge.
- [ ] Local verification commands or rationale are listed below.
- [ ] Reuse/extension/generalization evidence or gap rationale is listed below.

Local verification:

```text

```

Reuse / gap rationale:

```text

```

Select only what applies:

- [ ] UI behavior manually verified or covered by tests.
- [ ] CLI behavior verified with command output or tests.
- [ ] Core logic covered by unit, integration, property, or fixture tests.
- [ ] Security-sensitive change reviewed for trust boundaries, secrets, external calls, and generated artifacts.
- [ ] Supply-chain or package-surface change verified with package, license, lockfile, SBOM, or npm dry-run checks.
- [ ] Documentation or Markdown change verified by the repository link check or a targeted local equivalent.
- [ ] Release-impacting change verified with `pnpm run release:check` or an explicit rationale.
- [ ] Not applicable items are explained below.

Not applicable rationale:

-

## Review And Closure

- [ ] The PR implements only the linked issue scope.
- [ ] Actionable review findings are fixed or explicitly dispositioned.
- [ ] Unresolved review threads are resolved before merge.
- [ ] Checks are repeated after the latest pushed fix.
- [ ] Issue acceptance criteria and closure evidence are updated only where evidence exists.
- [ ] The linked issue records reuse, extension, generalization, or new-gap rationale before closure.
- [ ] Delivery board status is updated before requesting final maintainer review.
- [ ] Use `Resolves #<issue_number>` only when this PR should close the issue.

## Risk Notes

List compatibility, migration, security, data, auditability, release, or operational risks.
