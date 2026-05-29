import { describe, expect, it } from "vitest";
import { BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR } from "../../../src/workflows/bug-investigation/descriptor.js";
import {
  DEFAULT_BUG_WORKFLOW_LIMITS,
  type BugWorkflowLimits,
} from "../../../src/workflows/bug-investigation/types.js";
import type { WorkflowInputSpec } from "../../../src/workflows/descriptor.js";

function inputNamed(name: string): WorkflowInputSpec | undefined {
  return BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === name);
}

describe("BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR (AC #3)", () => {
  it("has the workflow identity and stable id", () => {
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.workflowId).toBe("bug-investigation");
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.name.length).toBeGreaterThan(0);
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  it("has all required input fields with correct requiredness", () => {
    expect(inputNamed("report")).toMatchObject({ type: "object", required: true });
    expect(inputNamed("modelId")).toMatchObject({ type: "string", required: true });
    expect(inputNamed("apply")).toMatchObject({ type: "boolean", required: false });
    expect(inputNamed("limits")).toMatchObject({ type: "object", required: false });
  });

  it("documents apply default as false", () => {
    expect(inputNamed("apply")?.defaultValue).toBe(false);
  });

  it("supports both dry-run and apply", () => {
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.supportsDryRun).toBe(true);
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.supportsApply).toBe(true);
  });

  it("exposes the default limits incl. the change budget and a high-cost model hint", () => {
    const limits: BugWorkflowLimits = BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.defaultLimits;
    expect(limits).toEqual(DEFAULT_BUG_WORKFLOW_LIMITS);
    expect(limits.maxFilesChanged).toBe(10);
    expect(limits.maxChangedLines).toBe(300);
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.modelSelectionOptions).toEqual({
      arbitrary: true,
      preferredCostClass: "high",
    });
  });

  it("is JSON-serializable (UI/audit contract)", () => {
    const round = JSON.parse(JSON.stringify(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR)) as unknown;
    expect(round).toEqual(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR);
  });
});
