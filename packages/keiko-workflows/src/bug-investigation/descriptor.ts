// The static UI workflow descriptor (ADR-0009 D12). Issue #13 reads this to render the
// bug-investigation workflow UI without knowing the implementation. Frozen and JSON-serializable.
// Imports the shared WorkflowDescriptor base from ../descriptor.js (NOT from the unit-test
// workflow) so the two sibling workflows do not depend on each other. preferredCostClass is "high"
// because root-cause analysis benefits from a stronger model than test generation.

import { DEFAULT_BUG_WORKFLOW_LIMITS, type BugWorkflowLimits } from "./types.js";
import type { WorkflowDescriptor } from "../descriptor.js";

export const BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR: WorkflowDescriptor<BugWorkflowLimits> = {
  workflowId: "bug-investigation",
  name: "Bug Investigation and Regression Test",
  description:
    "Investigates a bounded bug report (description, failing output, stack trace, and/or " +
    "suspected files), proposes a root-cause hypothesis with a minimal fix and a regression " +
    "test, and separates verified facts from model hypotheses. Dry-run by default; pass " +
    "apply:true to write the fix and run verification. When evidence is insufficient it returns " +
    "a scoped investigation report with no patch rather than an invented fix.",
  inputs: [
    {
      name: "report",
      type: "object",
      required: true,
      description:
        "Bug report: { description?, failingOutput?, stackTrace?, targetFiles? } — at least one present",
    },
    {
      name: "apply",
      type: "boolean",
      required: false,
      description: "Write the fix to disk and run verification",
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
      description: "Partial<BugWorkflowLimits> overrides (incl. the bug-fix change budget)",
    },
  ],
  defaultLimits: DEFAULT_BUG_WORKFLOW_LIMITS,
  modelSelectionOptions: { arbitrary: true, preferredCostClass: "high" },
  supportsDryRun: true,
  supportsApply: true,
} as const;
