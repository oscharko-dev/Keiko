import {
  isPathWithinSelectedScope,
  type EvidenceAtom,
  type ContinuityReferentSource,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  extractRetrievalChannels,
  type ExplorationPlan,
  type SearchReference,
} from "@oscharko-dev/keiko-workflows";
import type { SearchScope, WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import {
  testSourcePairingAdapter,
  type StructuralAdapterRequestContext,
} from "@oscharko-dev/keiko-workspace/code-intelligence";
import { GROUNDED_TRACE_SEARCH_LIMITS } from "./grounded-symbol-trace.js";
import {
  admitExplicitPaths,
  normalizedExplicitReferencePath,
  EXPLICIT_PATH_REJECTION_REASONS,
  type ExplicitPathAdmission,
} from "./grounded-explicit-paths.js";

export interface DiagnosticReferenceObservation {
  readonly continuityReferentSource: ContinuityReferentSource;
  readonly continuityReferentCount: number;
  readonly continuityAdmittedCount: number;
  readonly continuityRejectedCount: number;
  readonly stackTraceDetected: boolean;
  readonly stackTraceFrameCount: number;
  readonly stackTraceInScopeFrameCount: number;
  readonly stackTraceExternalFrameCount: number;
  readonly stackTraceAdmittedPathCount: number;
  readonly testSourcePairCount: number;
  readonly referenceChannelCount: number;
  readonly metadataInjectionReason: "intent" | "pattern" | "none";
}

export interface DiagnosticReferenceInputs {
  readonly assistantReferents?: readonly SearchReference[] | undefined;
  readonly continuityReferentSource?: ContinuityReferentSource | undefined;
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly plan: ExplorationPlan;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly structuralFs: WorkspaceFs;
  readonly requestContext: () => StructuralAdapterRequestContext;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal | undefined;
  readonly tryReserveSearchCall: () => boolean;
  readonly metadataInjectionReason: DiagnosticReferenceObservation["metadataInjectionReason"];
}

function mergedAdmission(
  a: ExplicitPathAdmission,
  b: ExplicitPathAdmission,
): ExplicitPathAdmission {
  const selections = [...a.selections, ...b.selections];
  return {
    selections,
    rejectedPaths: new Set([...a.rejectedPaths, ...b.rejectedPaths]),
    omitted: [...a.omitted, ...b.omitted],
    observation: {
      explicitPathAnchorCount:
        a.observation.explicitPathAnchorCount + b.observation.explicitPathAnchorCount,
      explicitPathAdmittedCount: new Set(selections.map((reference) => reference.path)).size,
      explicitPathRejectedCount:
        a.observation.explicitPathRejectedCount + b.observation.explicitPathRejectedCount,
      explicitPathRejectionReasons: EXPLICIT_PATH_REJECTION_REASONS.filter(
        (reason) =>
          a.observation.explicitPathRejectionReasons.includes(reason) ||
          b.observation.explicitPathRejectionReasons.includes(reason),
      ),
      explicitLineHintCount: selections.filter((reference) => reference.line !== undefined).length,
      basenameDiscoveryTermCount:
        a.observation.basenameDiscoveryTermCount + b.observation.basenameDiscoveryTermCount,
      basenameDiscoveryMatchCount:
        a.observation.basenameDiscoveryMatchCount + b.observation.basenameDiscoveryMatchCount,
    },
  };
}

async function primaryDiagnosticPair(
  inputs: DiagnosticReferenceInputs,
  primary: SearchReference | undefined,
): Promise<readonly EvidenceAtom[]> {
  if (primary === undefined || !inputs.tryReserveSearchCall()) return [];
  return testSourcePairingAdapter.lookup(
    inputs.searchScope,
    {
      ...inputs.query,
      kind: "natural-language",
      text: primary.path,
      caseSensitive: true,
    },
    GROUNDED_TRACE_SEARCH_LIMITS,
    inputs.structuralFs,
    {
      nowMs: inputs.nowMs,
      deadlineAtMs: inputs.deadlineAtMs,
      requestContext: inputs.requestContext(),
      ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    },
  );
}

function frameWithinSelectedScope(
  reference: SearchReference,
  inputs: DiagnosticReferenceInputs,
  admission: ExplicitPathAdmission,
): boolean {
  const path = normalizedExplicitReferencePath(reference, inputs.searchScope.workspace.root);
  if (path === undefined) return false;
  if (!path.includes("/") && inputs.scope.kind !== "workspace-root") {
    return admission.selections.some((selection) => selection.path.split("/").at(-1) === path);
  }
  return isPathWithinSelectedScope(inputs.scope, new Set(inputs.scope.relativePaths), path);
}

export async function admitDiagnosticReferences(inputs: DiagnosticReferenceInputs): Promise<{
  readonly admission: ExplicitPathAdmission;
  readonly observation: DiagnosticReferenceObservation;
}> {
  const admission = await admitExplicitPaths({ ...inputs, references: inputs.plan.references });
  const diagnostic = admission.selections.filter((reference) => reference.origin === "diagnostic");
  const pairs = await primaryDiagnosticPair(inputs, diagnostic[0]);
  const existing = new Set(admission.selections.map((reference) => reference.path));
  const paired = await admitExplicitPaths({
    ...inputs,
    references: pairs
      .filter((atom) => !existing.has(atom.scopePath))
      .map((atom) => ({ path: atom.scopePath, origin: "diagnostic" })),
  });
  const channels = extractRetrievalChannels(inputs.query.text, 8);
  return {
    admission: mergedAdmission(admission, paired),
    observation: {
      ...continuityObservation(inputs, admission),
      stackTraceDetected: channels.stackTraceDetected,
      stackTraceFrameCount: channels.stackTraceFrameCount,
      stackTraceInScopeFrameCount: channels.diagnosticFrames.filter((reference) =>
        frameWithinSelectedScope(reference, inputs, admission),
      ).length,
      stackTraceExternalFrameCount: channels.stackTraceExternalFrameCount,
      stackTraceAdmittedPathCount: new Set(diagnostic.map((reference) => reference.path)).size,
      testSourcePairCount: paired.selections.length,
      referenceChannelCount: inputs.plan.references?.length ?? 0,
      metadataInjectionReason: inputs.metadataInjectionReason,
    },
  };
}

function continuityObservation(
  inputs: DiagnosticReferenceInputs,
  admission: ExplicitPathAdmission,
): Pick<
  DiagnosticReferenceObservation,
  | "continuityReferentSource"
  | "continuityReferentCount"
  | "continuityAdmittedCount"
  | "continuityRejectedCount"
> {
  const references = inputs.assistantReferents ?? [];
  const selected = admission.selections.filter((reference) => reference.origin === "assistant");
  const admitted = references.filter((reference) => {
    const normalized = normalizedExplicitReferencePath(
      reference,
      inputs.searchScope.workspace.root,
    );
    if (normalized === undefined) return false;
    return selected.some(
      (candidate) =>
        candidate.path === normalized ||
        (!normalized.includes("/") && candidate.path.split("/").at(-1) === normalized),
    );
  }).length;
  return {
    continuityReferentSource: inputs.continuityReferentSource ?? "none",
    continuityReferentCount: references.length,
    continuityAdmittedCount: admitted,
    continuityRejectedCount: references.length - admitted,
  };
}
