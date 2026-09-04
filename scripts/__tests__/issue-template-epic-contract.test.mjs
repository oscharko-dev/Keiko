import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "../../.github/ISSUE_TEMPLATE");
const epicTemplatePath = join(templatesDir, "epic.md");
const taskTemplatePath = join(templatesDir, "feature_task.md");

const epicTemplateText = readFileSync(epicTemplatePath, "utf8");
const taskTemplateText = readFileSync(taskTemplatePath, "utf8");

describe("Epic issue template contract", () => {
  it("contains the Implementation Orchestrator Revalidation block", () => {
    expect(epicTemplateText).toContain("## Implementation Orchestrator Revalidation Contract");
    expect(epicTemplateText).toContain(
      "Before planning and implementation, revalidate against the current code and architecture",
    );
  });

  it("requires live architecture and dependency revalidation before sequencing or assigning", () => {
    expect(epicTemplateText).toContain("current package graph and dependencies");
    expect(epicTemplateText).toContain("concurrent or in-flight work");
  });

  it("captures scope, gates, and evidence as a required planning contract", () => {
    expect(epicTemplateText).toContain(
      "product goals, invariants, constraints, acceptance boundaries, evidence expectations",
    );
    expect(epicTemplateText).toContain(
      "Closeout depends on verified current-head behavior and evidence",
    );
  });

  it("enforces safe escalation and traceability when implementation needs change", () => {
    expect(epicTemplateText).toContain(
      "Working, clean, secure, verified current code is authoritative",
    );
    expect(epicTemplateText).toContain(
      "genuinely new product decision, unsafe conflict, or material scope expansion is escalated",
    );
    expect(epicTemplateText).toContain(
      "never weaken acceptance criteria, trust boundaries, authority, redaction policy, or gate posture",
    );
  });

  it("requires explicit revalidation after interruption or handoff", () => {
    expect(epicTemplateText).toContain(
      "If this epic is reassigned, interrupted, or resumed across handoffs",
    );
  });
});

describe("Feature task issue template contract", () => {
  it("contains the Task Orchestrator Revalidation block", () => {
    expect(taskTemplateText).toContain("## Task Orchestrator Revalidation Contract");
    expect(taskTemplateText).toContain("revalidate against:");
  });

  it("requires issue-scoped planning contract fields", () => {
    expect(taskTemplateText).toContain(
      "Issue text must include product goal, invariant and constraint boundary, acceptance boundary, evidence expectation, and the initial implementation decomposition.",
    );
    expect(taskTemplateText).toContain(
      "This issue text is a planning guardrail, not an immutable implementation contract.",
    );
  });

  it("requires safe traceability and escalation when assumptions shift", () => {
    expect(taskTemplateText).toContain(
      "Any shift in assumptions must be traceable: update this issue and parent epic",
    );
    expect(taskTemplateText).toContain(
      "New product decisions, unsafe conflicts, or material scope expansion are escalated to the Product Owner",
    );
  });

  it("requires revalidation when paused, resumed, or handed off", () => {
    expect(taskTemplateText).toContain(
      "If this task is assigned, paused, or resumed across an agent handoff, rerun revalidation",
    );
  });
});
