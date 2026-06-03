import { describe, expect, it } from "vitest";
import { UNIT_TEST_WORKFLOW_DESCRIPTOR, type WorkflowInputSpec } from "./descriptor.js";
import { DEFAULT_WORKFLOW_LIMITS } from "./types.js";

function inputNamed(name: string): WorkflowInputSpec | undefined {
  return UNIT_TEST_WORKFLOW_DESCRIPTOR.inputs.find((i) => i.name === name);
}

describe("UNIT_TEST_WORKFLOW_DESCRIPTOR (AC #3)", () => {
  it("has the workflow identity and stable id", () => {
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.workflowId).toBe("unit-test-generation");
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.name).toBe("Unit Test Generation");
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  it("has all required input fields with correct requiredness", () => {
    expect(inputNamed("target")).toMatchObject({ type: "object", required: true });
    expect(inputNamed("modelId")).toMatchObject({ type: "string", required: true });
    expect(inputNamed("apply")).toMatchObject({ type: "boolean", required: false });
    expect(inputNamed("limits")).toMatchObject({ type: "object", required: false });
  });

  it("documents apply default as false", () => {
    expect(inputNamed("apply")?.defaultValue).toBe(false);
  });

  it("supports both dry-run and apply", () => {
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.supportsDryRun).toBe(true);
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.supportsApply).toBe(true);
  });

  it("exposes the default limits and an arbitrary medium-cost model hint", () => {
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.defaultLimits).toEqual(DEFAULT_WORKFLOW_LIMITS);
    expect(UNIT_TEST_WORKFLOW_DESCRIPTOR.modelSelectionOptions).toEqual({
      arbitrary: true,
      preferredCostClass: "medium",
    });
  });

  it("is JSON-serializable (UI/audit contract)", () => {
    const round = JSON.parse(JSON.stringify(UNIT_TEST_WORKFLOW_DESCRIPTOR)) as unknown;
    expect(round).toEqual(UNIT_TEST_WORKFLOW_DESCRIPTOR);
  });
});
