// The static UI workflow descriptor (ADR-0008 D10). Issue #13 reads this to render the workflow
// UI without knowing the implementation. Pure value, no imports beyond ./types.js. Frozen and
// JSON-serializable.

import { DEFAULT_WORKFLOW_LIMITS, type WorkflowLimits } from "./types.js";

export interface WorkflowInputSpec {
  readonly name: string;
  readonly type: "string" | "boolean" | "string[]" | "object";
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue?: unknown;
}

export interface WorkflowDescriptor {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly WorkflowInputSpec[];
  readonly defaultLimits: WorkflowLimits;
  readonly modelSelectionOptions: {
    // Whether the caller can specify an arbitrary modelId. Always true for this workflow.
    readonly arbitrary: boolean;
    // Hint to the UI: prefer fast/cheap models for test generation.
    readonly preferredCostClass: "low" | "medium" | "high";
  };
  readonly supportsDryRun: boolean;
  readonly supportsApply: boolean;
}

export const UNIT_TEST_WORKFLOW_DESCRIPTOR: WorkflowDescriptor = {
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
