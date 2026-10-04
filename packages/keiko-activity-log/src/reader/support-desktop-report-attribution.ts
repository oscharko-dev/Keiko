import {
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  normalizeDefectFrameSignature,
  type SupportIncidentDescriptorRecord,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  computeDefectFingerprint,
  registeredFailureCorrelation,
  registeredFailureFingerprintInput,
  type RegisteredFailureFacts,
} from "../defect-fingerprint.js";
import { supportIncidentEligibleOperation } from "../support-incident.js";
import type { SupportQueryResult } from "./support-query.js";

type SelectedEvent = SupportQueryResult["events"][number];

function failureFacts(event: SelectedEvent): RegisteredFailureFacts {
  const view = event.parsed.view;
  return {
    op: view.op,
    errorKind: view.errorKind,
    frames: view.frames,
    correlationId: event.parsed.correlationId,
    parentCorrelationId: view.parentCorrelationId,
    clientKind: view.extra?.clientKind,
    renderFailure: view.extra?.renderFailure,
    moduleLoadFailure: view.extra?.moduleLoadFailure,
    stage: view.extra?.stage,
  };
}

function eligibleFailure(event: SelectedEvent, root: string): boolean {
  const view = event.parsed.view;
  return (
    supportIncidentEligibleOperation(view.op) &&
    (view.level === "error" || view.level === "warn") &&
    view.errorKind !== undefined &&
    registeredFailureCorrelation(failureFacts(event)).rootCorrelationId === root
  );
}

function preferFailure(candidate: SelectedEvent, current: SelectedEvent): boolean {
  if (candidate.parsed.view.level !== current.parsed.view.level) {
    return candidate.parsed.view.level === "error";
  }
  const candidateFrames = normalizeDefectFrameSignature(
    registeredFailureFingerprintInput(failureFacts(candidate)),
  ).length;
  const currentFrames = normalizeDefectFrameSignature(
    registeredFailureFingerprintInput(failureFacts(current)),
  ).length;
  if (candidateFrames !== currentFrames) return candidateFrames > currentFrames;
  return (
    candidate.parsed.view.category === "diagnostic" && current.parsed.view.category !== "diagnostic"
  );
}

function primaryFailure(query: SupportQueryResult, root: string): SelectedEvent | undefined {
  let primary: SelectedEvent | undefined;
  for (const event of query.events) {
    if (!eligibleFailure(event, root)) continue;
    if (primary === undefined || preferFailure(event, primary)) {
      primary = event;
    }
  }
  return primary;
}

/** Attribute a manual descriptor only to its authoritative selected failing event. */
export function attributeUnretainedReportFailure(
  record: SupportIncidentDescriptorRecord,
  query: SupportQueryResult,
): SupportIncidentDescriptorRecord {
  const root = record.correlation.rootCorrelationId;
  if (
    record.trigger !== "user-report" ||
    root === undefined ||
    query.integrity.classification !== "supported"
  )
    return record;
  const selected = primaryFailure(query, root);
  if (selected === undefined) return record;
  const facts = failureFacts(selected);
  const input = registeredFailureFingerprintInput(facts);
  return {
    ...record,
    trigger: "registered-failure",
    correlation: registeredFailureCorrelation(facts),
    fingerprint: {
      algorithm: input.algorithm ?? DEFECT_FINGERPRINT_ALGORITHM_VERSION,
      defectFingerprint: computeDefectFingerprint(input),
      surface: input.surface,
      op: input.op,
      errorKind: input.errorKind,
      frameCount: normalizeDefectFrameSignature(input).length,
    },
  };
}
