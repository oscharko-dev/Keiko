// The static UI workflow descriptor (ADR-0008 D10). Issue #13 reads this to render the workflow
// UI without knowing the implementation. Frozen and JSON-serializable. The descriptor interfaces
// are the shared base (ADR-0009 D12) — re-exported here so #8's existing import surface (the
// unit-tests barrel) is unchanged; both workflows depend on the base and neither on the other.

import { DEFAULT_WORKFLOW_LIMITS, type WorkflowLimits } from "./types.js";
import type { WorkflowDescriptor } from "../descriptor.js";

export type { WorkflowDescriptor, WorkflowInputSpec } from "../descriptor.js";

export const UNIT_TEST_WORKFLOW_DESCRIPTOR: WorkflowDescriptor<WorkflowLimits> = {
  workflowId: "unit-test-generation",
  name: "Unit Test Generation",
  description:
    "Generates a reviewable unit-test patch for a target TypeScript file, function, or module. " +
    "Detects the project's test framework and naming conventions. Dry-run by default; " +
    "pass apply:true to write the tests and run verification.",
  inputs: [
    {
      name: "target",
      type: "object",
      required: true,
      description:
        "Target: { kind: 'file', filePath } | { kind: 'module', moduleDir } | { kind: 'changedFiles', filePaths }",
    },
    {
      name: "apply",
      type: "boolean",
      required: false,
      description: "Write tests to disk and run verification",
      defaultValue: false,
    },
    {
      name: "modelId",
      type: "string",
      required: true,
      description: "Model ID registered in gateway config",
    },
    {
      name: "limits",
      type: "object",
      required: false,
      description: "Partial<WorkflowLimits> overrides",
    },
  ],
  defaultLimits: DEFAULT_WORKFLOW_LIMITS,
  modelSelectionOptions: { arbitrary: true, preferredCostClass: "medium" },
  supportsDryRun: true,
  supportsApply: true,
} as const;
