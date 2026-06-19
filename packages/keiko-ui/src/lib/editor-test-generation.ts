// Maps the governed test-generation wire response (Issue #1202) into the editor package's
// `EditorTestGenerationOutcome`. The host (keiko-ui) owns this seam: it calls the BFF
// (`requestEditorTestGeneration`) and adapts the content-free wire shape — status, the assured
// pre-filter funnel, content-free context citations, and (only for `generated`) the reviewable
// candidate patch and model provenance — into the editor's render contract. The editor package itself
// stays free of any BFF or contracts-wire knowledge (ADR-0042 D5/D7). In v1 the server only ever
// returns `disabled`/`deferred`, so the `generated` branch is exercised by tests and wave 2.

import type {
  EditorContextEntry,
  EditorContextOmission,
  EditorContextPack,
  EditorGeneratedPatch,
  EditorModelProvenance,
  EditorOutputProvenance,
  EditorPatchFileChange,
  EditorRange,
  EditorRequestIdentity,
  EditorTestGenerationAssurance,
  EditorTestGenerationFunnel,
  EditorTestGenerationOutcome,
  EditorTestGenerationResult,
  EditorTextEdit,
} from "@oscharko-dev/keiko-editor";
import type {
  EditorTestGenerationFunnel as WireFunnel,
  EditorTestGenerationWireFileChange,
  EditorTestGenerationWirePatch,
  EditorTestGenerationWireProvenance,
  EditorTestGenerationWireResponse,
} from "./types";

const DISABLED_FALLBACK = "Editor-driven test generation is disabled in this build.";
const FAILED_FALLBACK = "Test generation could not be completed. The editor is still usable.";

// Wire geometry uses {line, character}; the editor uses {line, column}. Pure 1:1 remap.
function toEditorRange(
  range: EditorTestGenerationWireFileChange["edits"][number]["range"],
): EditorRange {
  return {
    start: { line: range.start.line, column: range.start.character },
    end: { line: range.end.line, column: range.end.character },
  };
}

function toEditorEdit(edit: EditorTestGenerationWireFileChange["edits"][number]): EditorTextEdit {
  return { range: toEditorRange(edit.range), newText: edit.newText };
}

function toEditorFileChange(file: EditorTestGenerationWireFileChange): EditorPatchFileChange {
  return {
    uri: file.path,
    edits: file.edits.map(toEditorEdit),
    isNewFile: file.changeKind === "added",
    isDeletion: file.changeKind === "deleted",
  };
}

function toEditorFunnel(funnel: WireFunnel): EditorTestGenerationFunnel {
  return {
    executionEnabled: funnel.executionEnabled,
    candidatesGenerated: funnel.candidatesGenerated,
    candidatesSurfaced: funnel.candidatesSurfaced,
    stabilityRunsRequired: funnel.stabilityRunsRequired,
    build: funnel.build,
    pass: funnel.pass,
    stability: funnel.stability,
    coverage: funnel.coverage,
    mutation: funnel.mutation,
    antiTautology: funnel.antiTautology,
  };
}

// Content-free model provenance for a generated candidate (origin `generated-test`).
function toGeneratedProvenance(
  provenance: EditorTestGenerationWireProvenance,
): EditorOutputProvenance {
  const model: EditorModelProvenance = {
    modelId: provenance.modelId,
    gatewayPolicyVersion: provenance.gatewayPolicyVersion,
    promptHash: provenance.promptHash,
    producedAt: provenance.producedAt,
  };
  return { origin: "generated-test", model };
}

function toEditorPatch(
  patch: EditorTestGenerationWirePatch,
  provenance: EditorOutputProvenance,
): EditorGeneratedPatch {
  return {
    patchId: patch.patchId,
    changes: patch.files.map(toEditorFileChange),
    status: "previewed",
    provenance,
  };
}

// Maps the content-free coding-context wire pack to the editor context pack (drops the source tier,
// which is a server-side audit label). Returns undefined when the response carried no context.
function toEditorContext(
  request: EditorRequestIdentity,
  wire: EditorTestGenerationWireResponse,
): EditorContextPack | undefined {
  if (wire.context === undefined) {
    return undefined;
  }
  const entries: EditorContextEntry[] = wire.context.entries.map((entry) => ({
    sourceKind: entry.sourceKind,
    id: entry.id,
    score: entry.score,
    rank: entry.rank,
    ...(entry.citationRef === undefined ? {} : { citationRef: entry.citationRef }),
    byteCount: entry.byteCount,
    truncated: entry.truncated,
  }));
  const omissions: EditorContextOmission[] = wire.context.omissions.map((omission) => ({
    sourceKind: omission.sourceKind,
    reason: omission.reason,
  }));
  return {
    request,
    entries,
    usedBytes: wire.context.usedBytes,
    budgetBytes: wire.context.budgetBytes,
    droppedForBudget: wire.context.droppedForBudget,
    omissions,
  };
}

function toGeneratedOutcome(
  request: EditorRequestIdentity,
  wire: EditorTestGenerationWireResponse,
): EditorTestGenerationOutcome {
  // A `generated` response always carries a patch + provenance; fall back to `failed` if malformed.
  if (wire.patch === undefined || wire.provenance === undefined) {
    return { status: "failed", request, reason: wire.reason ?? FAILED_FALLBACK };
  }
  const provenance = toGeneratedProvenance(wire.provenance);
  const result: EditorTestGenerationResult = {
    request,
    patch: toEditorPatch(wire.patch, provenance),
    provenance,
  };
  const assurance: EditorTestGenerationAssurance = wire.assurance ?? "unverified";
  const context = toEditorContext(request, wire);
  return {
    status: "generated",
    request,
    result,
    funnel: toEditorFunnel(wire.funnel),
    assurance,
    ...(context === undefined ? {} : { context }),
  };
}

/** Adapts the wire response into the discriminated editor outcome the host port returns. */
export function mapWireToEditorTestGenerationOutcome(
  request: EditorRequestIdentity,
  wire: EditorTestGenerationWireResponse,
): EditorTestGenerationOutcome {
  if (wire.status === "disabled") {
    return { status: "disabled", request, reason: wire.reason ?? DISABLED_FALLBACK };
  }
  if (wire.status === "failed") {
    return { status: "failed", request, reason: wire.reason ?? FAILED_FALLBACK };
  }
  if (wire.status === "deferred") {
    const context = toEditorContext(request, wire);
    return {
      status: "deferred",
      request,
      reason: wire.reason ?? FAILED_FALLBACK,
      funnel: toEditorFunnel(wire.funnel),
      ...(context === undefined ? {} : { context }),
    };
  }
  return toGeneratedOutcome(request, wire);
}
