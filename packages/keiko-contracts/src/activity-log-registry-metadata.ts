import type {
  ActivityLogDataClass,
  ActivityLogFieldContract,
  ActivityLogLifecyclePhase,
  ActivityLogOperationRegistration,
} from "./observability.js";

/** Stable metadata schemas; concrete registry counts and list positions are generated data. */
export interface ActivityLogFailureClassOperationMetadata extends Pick<
  ActivityLogOperationRegistration,
  "op" | "owner" | "category" | "lifecycle" | "causal" | "analyzerProjection" | "proofIds"
> {
  readonly safeContextFields: readonly (Pick<
    ActivityLogFieldContract,
    "type" | "dataClass" | "required"
  > & { readonly name: string })[];
  readonly evidenceClasses: readonly ActivityLogDataClass[];
  readonly frameCauseEvidence: { readonly frames: boolean; readonly causeChain: boolean };
  readonly replayReferences: readonly string[];
  readonly missingObligations: readonly string[];
}

export interface ActivityLogFailureClassMetadata {
  readonly failureClass: string;
  readonly requirementContract?: string;
  readonly productSurfaces: readonly string[];
  readonly lifecycleTransitions: readonly ActivityLogLifecyclePhase[];
  readonly lifecycleOperations: Readonly<Record<ActivityLogLifecyclePhase, readonly string[]>>;
  readonly causalEdges: readonly {
    readonly op: string;
    readonly mode: ActivityLogOperationRegistration["causal"];
  }[];
  readonly lossSignals: readonly string[];
  readonly resourceSignals: readonly string[];
  readonly replayReferences: readonly string[];
  readonly operations: readonly ActivityLogFailureClassOperationMetadata[];
  readonly missingObligations: readonly string[];
  readonly completeness: "complete" | "incomplete";
}

export interface ActivityLogFailureClassCoverageMetadata {
  readonly schemaVersion: 1;
  readonly releaseExpectation: "100%-complete";
  readonly supportedClassCount: number;
  readonly completeClassCount: number;
  readonly completeness: "complete" | "incomplete";
  readonly classes: readonly ActivityLogFailureClassMetadata[];
}

export type ReadonlyRegistryData<Value> = Value extends object
  ? { readonly [Key in keyof Value]: ReadonlyRegistryData<Value[Key]> }
  : Value;
