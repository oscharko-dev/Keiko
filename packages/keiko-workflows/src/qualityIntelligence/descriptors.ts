// Quality Intelligence workflow descriptors (Epic #270, Issue #273, ADR-0023 D6).
//
// Four reviewable QI workflows executed through `@oscharko-dev/keiko-harness` and
// `@oscharko-dev/keiko-workflows`. Each descriptor enumerates the deterministic
// stage sequence, the emitted event kinds, and the typed limits the run entry
// honours. NO model SDK reaches this module: stage runtime composes the gateway
// dispatcher seam shipped in #279.
//
// Structurally inspired by Test Intelligence reference (TI) workflow staging,
// but the Keiko port stays envelope-shaped, descriptor-driven, and free of
// any TI runtime / IR.
//
// The descriptors here are pure value records — they intentionally do NOT
// instantiate the WorkflowDescriptor shape from `../descriptor.js` because that
// shape is tuned to the apply/dry-run developer-assist workflows (#8/#9) and
// would force fictional input slots onto QI runs. The QI surface re-exports
// `QualityIntelligenceWorkflowDescriptor` from this file directly.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

export type QualityIntelligenceWorkflowId =
  | "qi:test-design"
  | "qi:coverage-review"
  | "qi:validation"
  | "qi:artifact-refinement";

export interface QualityIntelligenceWorkflowLimits {
  /** Wall-clock soft limit per stage (advisory, used to bound dispatcher waits). */
  readonly stageTimeoutMs: number;
  /** Total candidates a single test-design run may emit (truncated past). */
  readonly maxCandidatesPerRun: number;
  /** Total findings a single validation run may emit (truncated past). */
  readonly maxFindingsPerRun: number;
  /** Maximum total model gateway dispatches per run (across all stages). */
  readonly maxModelCallsPerRun: number;
}

export const QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS: QualityIntelligenceWorkflowLimits =
  Object.freeze({
    stageTimeoutMs: 45_000,
    maxCandidatesPerRun: 256,
    maxFindingsPerRun: 512,
    maxModelCallsPerRun: 32,
  });

export interface QualityIntelligenceWorkflowDescriptor {
  readonly workflowId: QualityIntelligenceWorkflowId;
  readonly displayName: string;
  readonly description: string;
  readonly stageNames: readonly string[];
  readonly emittedEventKinds: readonly QualityIntelligence.QualityIntelligenceRunEventKind[];
  readonly defaultLimits: QualityIntelligenceWorkflowLimits;
  readonly preferredCostClass: "low" | "medium" | "high";
}

const FROZEN_DEFAULT_LIMITS = QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS;

function freezeStringArray(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezeEventKinds(
  values: readonly QualityIntelligence.QualityIntelligenceRunEventKind[],
): readonly QualityIntelligence.QualityIntelligenceRunEventKind[] {
  return Object.freeze([...values]);
}

function freezeDescriptor(
  descriptor: QualityIntelligenceWorkflowDescriptor,
): QualityIntelligenceWorkflowDescriptor {
  return Object.freeze({
    ...descriptor,
    stageNames: freezeStringArray(descriptor.stageNames),
    emittedEventKinds: freezeEventKinds(descriptor.emittedEventKinds),
    defaultLimits: descriptor.defaultLimits,
  });
}

// Shared run-lifecycle envelope event kinds. Every QI workflow emits this set;
// stage-specific extra kinds are added per descriptor below.
const LIFECYCLE_EVENT_KINDS: readonly QualityIntelligence.QualityIntelligenceRunEventKind[] = [
  "run:queued",
  "run:started",
  "stage:started",
  "stage:completed",
  "stage:failed",
  "run:succeeded",
  "run:failed",
  "run:cancelled",
];

export const QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR: QualityIntelligenceWorkflowDescriptor =
  freezeDescriptor({
    workflowId: "qi:test-design",
    displayName: "Quality Intelligence — Test Design",
    description:
      "Derive intent, draft test-case candidates, build coverage map, validate, persist evidence. " +
      "Stages: plan, intent, candidates, coverage, validate, finalize.",
    stageNames: ["plan", "intent", "candidates", "coverage", "validate", "finalize"],
    emittedEventKinds: [...LIFECYCLE_EVENT_KINDS, "candidate:proposed", "finding:recorded"],
    defaultLimits: FROZEN_DEFAULT_LIMITS,
    preferredCostClass: "medium",
  });

export const QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR: QualityIntelligenceWorkflowDescriptor =
  freezeDescriptor({
    workflowId: "qi:coverage-review",
    displayName: "Quality Intelligence — Coverage Review",
    description:
      "Build and report a coverage map across existing candidates and atoms. " +
      "Stages: plan, analyse, report.",
    stageNames: ["plan", "analyse", "report"],
    emittedEventKinds: [...LIFECYCLE_EVENT_KINDS],
    defaultLimits: FROZEN_DEFAULT_LIMITS,
    preferredCostClass: "low",
  });

export const QI_VALIDATION_WORKFLOW_DESCRIPTOR: QualityIntelligenceWorkflowDescriptor =
  freezeDescriptor({
    workflowId: "qi:validation",
    displayName: "Quality Intelligence — Validation",
    description:
      "Run schema/logic validators and optional model judges over existing candidates, reconcile, persist. " +
      "Stages: plan, run-judges, reconcile, report.",
    stageNames: ["plan", "run-judges", "reconcile", "report"],
    emittedEventKinds: [...LIFECYCLE_EVENT_KINDS, "finding:recorded"],
    defaultLimits: FROZEN_DEFAULT_LIMITS,
    preferredCostClass: "high",
  });

export const QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR: QualityIntelligenceWorkflowDescriptor =
  freezeDescriptor({
    workflowId: "qi:artifact-refinement",
    displayName: "Quality Intelligence — Artifact Refinement",
    description:
      "Refine existing candidates by re-applying the policy profile and deduplication, then validate. " +
      "Stages: plan, refine, validate, report.",
    stageNames: ["plan", "refine", "validate", "report"],
    emittedEventKinds: [...LIFECYCLE_EVENT_KINDS, "candidate:proposed", "finding:recorded"],
    defaultLimits: FROZEN_DEFAULT_LIMITS,
    preferredCostClass: "medium",
  });

export const QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS: readonly QualityIntelligenceWorkflowDescriptor[] =
  Object.freeze([
    QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
    QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
    QI_VALIDATION_WORKFLOW_DESCRIPTOR,
    QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  ]);

export function findQualityIntelligenceWorkflowDescriptor(
  workflowId: QualityIntelligenceWorkflowId,
): QualityIntelligenceWorkflowDescriptor {
  for (const descriptor of QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS) {
    if (descriptor.workflowId === workflowId) {
      return descriptor;
    }
  }
  throw new Error(`Unknown Quality Intelligence workflow id: ${workflowId}`);
}
