// Shared UI workflow-descriptor interfaces (ADR-0009 D12). Extracted from the unit-test
// workflow's descriptor so BOTH workflows depend on this common base and NEITHER depends on the
// other — a clean dependency direction for the workflows layer. Pure types, no runtime logic.
// Each workflow exports its own concrete `*_WORKFLOW_DESCRIPTOR: WorkflowDescriptor<TLimits>`
// value; issue #13 reads those values to render the workflow UI without the implementation.
// `TLimits` is the workflow's own frozen limits shape so each descriptor keeps precise typing on
// `defaultLimits` (it defaults to `object` for callers that handle descriptors generically).

export interface WorkflowInputSpec {
  readonly name: string;
  readonly type: "string" | "boolean" | "string[]" | "object";
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue?: unknown;
}

export interface WorkflowDescriptor<TLimits = object> {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly WorkflowInputSpec[];
  readonly defaultLimits: TLimits;
  readonly modelSelectionOptions: {
    // Whether the caller can specify an arbitrary modelId.
    readonly arbitrary: boolean;
    // Hint to the UI about the preferred model cost class for this workflow.
    readonly preferredCostClass: "low" | "medium" | "high";
  };
  readonly supportsDryRun: boolean;
  readonly supportsApply: boolean;
}
