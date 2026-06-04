// The redacted-by-construction manifest builder (ADR-0010 D2/D3/D7/D8). It maps a harness
// RunResult/RunManifest (+ optional #5/#7 audit summaries) into an EvidenceManifest, applying the
// audit redactor at the moment each sensitive value is copied in — there is no intermediate "raw
// manifest" object. The persist layer (D3 defense-in-depth) additionally deep-redacts every string
// leaf before serialization, so a builder bug that missed a field cannot silently persist a secret.

import type {
  CommandExecutedEvent,
  HarnessEvent,
  PatchAppliedEvent,
  PatchProposedEvent,
  ReasoningTraceEvent,
  RunResult,
  SandboxConfiguredEvent,
  StateTransitionEvent,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  VerificationResultEvent,
} from "@oscharko-dev/keiko-contracts";
import { aggregateUsage } from "./aggregate.js";
import { createAuditRedactor, deepRedactStrings } from "./redaction.js";
import type {
  EvidenceBuildInput,
  EvidenceCommandExecution,
  EvidenceDeps,
  EvidenceFailure,
  EvidenceManifest,
  EvidencePatch,
  EvidenceReasoningEntry,
  EvidenceRunIdentity,
  EvidenceSandboxConfiguration,
  EvidenceStateTransition,
  EvidenceToolCall,
  EvidenceVerificationResult,
} from "./types.js";
import { EVIDENCE_SCHEMA_VERSION } from "./types.js";

type Redactor = (input: string) => string;

function buildModel(
  modelId: string,
  deps: EvidenceDeps,
): {
  readonly modelId: string;
  readonly costClass: ReturnType<NonNullable<EvidenceDeps["costClassResolver"]>>;
} {
  return { modelId, costClass: deps.costClassResolver?.(modelId) ?? "unknown" };
}

function buildIdentity(input: EvidenceBuildInput): EvidenceRunIdentity {
  const { result, manifest } = input;
  return {
    runId: result.runId,
    fingerprint: result.fingerprint,
    harnessVersion: manifest.harnessVersion,
    taskType: result.taskType,
    outcome: result.outcome,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.finishedAt - result.startedAt,
  };
}

function mapStateTransition(e: StateTransitionEvent, redact: Redactor): EvidenceStateTransition {
  return { seq: e.seq, ts: e.ts, from: e.from, to: e.to, reason: redact(e.reason) };
}

function mapToolCompleted(e: ToolCallCompletedEvent): EvidenceToolCall {
  return {
    seq: e.seq,
    ts: e.ts,
    toolName: e.toolName,
    toolCallId: e.toolCallId,
    outcome: "completed",
    durationMs: e.durationMs,
  };
}

function mapToolFailed(e: ToolCallFailedEvent): EvidenceToolCall {
  // The redacted message is dropped (D3); only the stable errorCode is retained.
  return {
    seq: e.seq,
    ts: e.ts,
    toolName: e.toolName,
    toolCallId: e.toolCallId,
    outcome: "failed",
    errorCode: e.errorCode,
  };
}

function mapCommand(e: CommandExecutedEvent): EvidenceCommandExecution {
  return {
    seq: e.seq,
    ts: e.ts,
    executable: e.executable,
    argCount: e.argCount,
    exitCode: e.exitCode,
    timedOut: e.timedOut,
    durationMs: e.durationMs,
  };
}

function mapSandbox(e: SandboxConfiguredEvent): EvidenceSandboxConfiguration {
  return {
    seq: e.seq,
    ts: e.ts,
    envAllowlist: e.envAllowlist,
    network: e.network,
    maxOutputBytes: e.maxOutputBytes,
    timeoutMs: e.timeoutMs,
    terminationGraceMs: e.terminationGraceMs,
    cwdRequested: e.cwdRequested,
  };
}

function mapVerificationResult(
  e: VerificationResultEvent,
  redact: Redactor,
): EvidenceVerificationResult {
  return { seq: e.seq, ts: e.ts, passed: e.passed, detail: redact(e.detail) };
}

function mapReasoning(e: ReasoningTraceEvent, redact: Redactor): EvidenceReasoningEntry {
  return {
    seq: e.seq,
    ts: e.ts,
    phase: e.phase,
    rationale: redact(e.rationale),
    ...(e.modelResponse === undefined ? {} : { modelResponse: redact(e.modelResponse) }),
  };
}

// Mutable accumulator for patch events; collapsed into an EvidencePatch only when any patch event
// occurred (so the manifest key is absent — not a zeroed object — when no patch ran, D2).
interface PatchAccumulator {
  seen: boolean;
  proposed: boolean;
  applied: boolean;
  targetFileCount: number;
  patchBytes: number;
  changedFiles: number;
  created: number;
  deleted: number;
  redactedDiff: string | undefined;
}

function newPatchAccumulator(): PatchAccumulator {
  return {
    seen: false,
    proposed: false,
    applied: false,
    targetFileCount: 0,
    patchBytes: 0,
    changedFiles: 0,
    created: 0,
    deleted: 0,
    redactedDiff: undefined,
  };
}

function foldPatchProposed(
  acc: PatchAccumulator,
  e: PatchProposedEvent,
  redact: Redactor,
  includeDiff: boolean,
): void {
  acc.seen = true;
  acc.proposed = true;
  acc.targetFileCount += 1;
  acc.patchBytes += e.patchBytes;
  if (includeDiff) {
    acc.redactedDiff = redact(e.diff);
  }
}

function foldPatchApplied(acc: PatchAccumulator, e: PatchAppliedEvent): void {
  acc.seen = true;
  acc.applied = true;
  acc.changedFiles += e.changedFiles;
  acc.created += e.created;
  acc.deleted += e.deleted;
}

function toPatch(acc: PatchAccumulator): EvidencePatch | undefined {
  if (!acc.seen) {
    return undefined;
  }
  return {
    proposed: acc.proposed,
    applied: acc.applied,
    targetFileCount: acc.targetFileCount,
    patchBytes: acc.patchBytes,
    changedFiles: acc.changedFiles,
    created: acc.created,
    deleted: acc.deleted,
    ...(acc.redactedDiff === undefined ? {} : { redactedDiff: acc.redactedDiff }),
  };
}

function toFailure(result: RunResult, redact: Redactor): EvidenceFailure | undefined {
  if (result.failure === undefined) {
    return undefined;
  }
  return { category: result.failure.category, message: redact(result.failure.message) };
}

interface FoldState {
  readonly stateTransitions: EvidenceStateTransition[];
  readonly toolCalls: EvidenceToolCall[];
  readonly commandExecutions: EvidenceCommandExecution[];
  readonly sandboxConfigurations: EvidenceSandboxConfiguration[];
  readonly verificationResults: EvidenceVerificationResult[];
  readonly reasoning: EvidenceReasoningEntry[];
  readonly patch: PatchAccumulator;
}

function foldRecordEvent(state: FoldState, event: HarnessEvent, redact: Redactor): boolean {
  if (event.type === "state:transition") {
    state.stateTransitions.push(mapStateTransition(event, redact));
    return true;
  } else if (event.type === "tool:call:completed") {
    state.toolCalls.push(mapToolCompleted(event));
    return true;
  } else if (event.type === "tool:call:failed") {
    state.toolCalls.push(mapToolFailed(event));
    return true;
  } else if (event.type === "command:executed") {
    state.commandExecutions.push(mapCommand(event));
    return true;
  } else if (event.type === "sandbox:configured") {
    state.sandboxConfigurations.push(mapSandbox(event));
    return true;
  } else if (event.type === "verification:result") {
    state.verificationResults.push(mapVerificationResult(event, redact));
    return true;
  }
  return false;
}

function foldEvent(
  state: FoldState,
  event: HarnessEvent,
  redact: Redactor,
  options: { includeDiff: boolean; includeReasoning: boolean },
): void {
  if (foldRecordEvent(state, event, redact)) {
    return;
  }
  if (event.type === "patch:proposed") {
    foldPatchProposed(state.patch, event, redact, options.includeDiff);
  } else if (event.type === "patch:applied") {
    foldPatchApplied(state.patch, event);
  } else if (event.type === "reasoning:trace" && options.includeReasoning) {
    state.reasoning.push(mapReasoning(event, redact));
  }
}

// Assembles the optional sections (undefined-when-absent, never an empty object/array masquerading
// as "ran but produced nothing" — D2). exactOptionalPropertyTypes means each key is only present
// when its value exists; reasoning is keyed only under its opt-in.
function optionalSections(
  input: EvidenceBuildInput,
  state: FoldState,
  redact: Redactor,
  includeReasoning: boolean,
): Partial<EvidenceManifest> {
  const patch = toPatch(state.patch);
  const failure = toFailure(input.result, redact);
  return {
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(patch === undefined ? {} : { patch }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(failure === undefined ? {} : { failure }),
    ...(includeReasoning ? { reasoning: state.reasoning } : {}),
  };
}

export function buildEvidenceManifest(
  input: EvidenceBuildInput,
  deps: EvidenceDeps,
): EvidenceManifest {
  const redact = createAuditRedactor(input.redaction ?? {}, deps.env ?? {});
  const includeDiff = input.options?.includeDiff ?? false;
  const includeReasoning = input.options?.includeReasoning ?? false;
  const state: FoldState = {
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    sandboxConfigurations: [],
    verificationResults: [],
    reasoning: [],
    patch: newPatchAccumulator(),
  };
  for (const event of input.result.events) {
    foldEvent(state, event, redact, { includeDiff, includeReasoning });
  }
  const manifest: EvidenceManifest = {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: buildIdentity(input),
    model: buildModel(input.manifest.modelId, deps),
    usageTotals: aggregateUsage(input.result.events),
    stateTransitions: state.stateTransitions,
    toolCalls: state.toolCalls,
    commandExecutions: state.commandExecutions,
    ...(state.sandboxConfigurations.length === 0
      ? {}
      : { sandboxConfigurations: state.sandboxConfigurations }),
    ...(state.verificationResults.length === 0
      ? {}
      : { verificationResults: state.verificationResults }),
    ...optionalSections(input, state, redact, includeReasoning),
  };
  // C2: the #5 context and #7 verification summaries are embedded VERBATIM above, so per-field
  // redaction during the fold does not reach them. Apply the audit redactor over every string leaf so
  // a DIRECT builder caller (not only via persistEvidence) gets a truly redacted-by-construction
  // manifest. Idempotent, so the fold's per-field redaction still stands and persist's DiD pass is a
  // no-op on already-redacted tokens.
  return deepRedactStrings(manifest, redact) as EvidenceManifest;
}
