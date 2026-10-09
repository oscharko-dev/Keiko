// Closed, body-free observations of actual responses; no answer is promoted to a semantic proof.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { importBuilt } from "./lab-common.mjs";
import { flatten, readActivityLogText } from "./activity-log-events.mjs";
import { assertOperationContract, registeredOperations, readOpCatalog } from "./op-contract.mjs";

const OPERATIONS = registeredOperations(readOpCatalog());
assertOperationContract("connected-chat-record", {
  "chat.context.selected": [
    "state",
    "compactedHistoryMessages",
    "retainedHistoryMessages",
    "tokensBefore",
    "tokensAfter",
  ],
  "search.connected-context.answer-details": [
    "scopeIdentitySha256",
    "queryIdentitySha256",
    "filesInPrompt",
    "synthesisCallCount",
    "completedSynthesisCallCount",
    "followUpPassCount",
    "followUpOutcome",
    "citationRepairDisposition",
  ],
  "search.answer.assessed": [
    "policy",
    "phase",
    "outcome",
    "scopeIdentitySha256",
    "queryIdentitySha256",
    "sourceBackedChars",
    "assessmentChars",
  ],
});

function answerObservation(answer, splitOwnAssessment) {
  const content = typeof answer.content === "string" ? answer.content : "";
  const split = splitOwnAssessment(content);
  return {
    answerSha256: createHash("sha256").update(content).digest("hex"),
    answerChars: content.length,
    sourceBackedChars: split.grounded.length,
    assessmentChars: split.assessment?.length ?? 0,
    ...citationObservation(answer),
  };
}

function citationObservation(answer) {
  return {
    citationCount: (answer.citations?.length ?? 0) + (answer.knowledgeCitations?.length ?? 0),
    declaredCount: answer.insufficiencyDeclarations?.length ?? 0,
    uncitedWarningCount:
      answer.uncertainty?.filter((marker) => marker.kind === "uncited-answer").length ?? 0,
  };
}

function expectedTargetCited(answer, target) {
  return target === undefined
    ? undefined
    : answer.citations?.some((citation) => citation.scopePath === target);
}

function sameActualProcess(rows) {
  return (
    rows.length > 0 &&
    rows.every((row) => row.pid !== undefined && row.instanceId !== undefined) &&
    new Set(rows.map((row) => row.instanceId)).size === 1
  );
}

function selectedObservation(rows) {
  const context = rows.filter((row) => row.op === "chat.context.selected").at(-1);
  const details = rows.filter((row) => row.op === "search.connected-context.answer-details");
  return {
    compaction:
      context === undefined
        ? undefined
        : {
            state: context.state,
            compactedHistoryMessages: context.compactedHistoryMessages,
            retainedHistoryMessages: context.retainedHistoryMessages,
            tokensBefore: context.tokensBefore,
            tokensAfter: context.tokensAfter,
          },
    answerDetails: details.map((row) => ({
      scopeIdentitySha256: row.scopeIdentitySha256,
      queryIdentitySha256: row.queryIdentitySha256,
      filesInPrompt: row.filesInPrompt,
      synthesisCallCount: row.synthesisCallCount,
      completedSynthesisCallCount: row.completedSynthesisCallCount,
      followUpPassCount: row.followUpPassCount,
      followUpOutcome: row.followUpOutcome,
      citationRepairDisposition: row.citationRepairDisposition,
    })),
    assessmentEvents: rows
      .filter((row) => row.op === "search.answer.assessed")
      .map((row) => ({
        policy: row.policy,
        phase: row.phase,
        outcome: row.outcome,
        scopeIdentitySha256: row.scopeIdentitySha256,
        queryIdentitySha256: row.queryIdentitySha256,
        sourceBackedChars: row.sourceBackedChars,
        assessmentChars: row.assessmentChars,
      })),
    operationCounts: Object.fromEntries(
      [...new Set(rows.map((row) => row.op))]
        .filter((op) => OPERATIONS.has(op))
        .map((op) => [op, rows.filter((row) => row.op === op).length]),
    ),
  };
}

function usageObservation(usage) {
  return usage === undefined
    ? undefined
    : {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        requestCount: usage.requestCount,
        totalLatencyMs: usage.totalLatencyMs,
      };
}

function evidenceObservation(manifests, target) {
  return {
    expectedTargetRead:
      target === undefined
        ? undefined
        : manifests.some((manifest) =>
            manifest.connectedContext?.files?.some((file) => file.scopePath === target),
          ),
    compactionEvidenceCount: manifests.reduce(
      (count, manifest) => count + (manifest.compaction?.length ?? 0),
      0,
    ),
    usageTotals: manifests.map((manifest) => usageObservation(manifest.usageTotals)),
  };
}

export async function connectedChatObservation(runtime, result, manifests, target) {
  const text = await readActivityLogText(join(runtime.stateDir, "logs"));
  const { splitOwnAssessment } = await importBuilt("keiko-contracts", "grounded-assessment.js");
  const { analyzeLogText, buildReproductionSeed } = await importBuilt(
    "keiko-activity-log",
    "reader/index.js",
  );
  const analysis = analyzeLogText(text);
  const seed =
    result.correlationId === null
      ? undefined
      : buildReproductionSeed(text, result.correlationId, new Date());
  const rows = (seed?.timeline ?? []).map(flatten);
  return {
    correlationId: result.correlationId,
    stableProcess: sameActualProcess(rows),
    ...answerObservation(result.json, splitOwnAssessment),
    ...evidenceObservation(manifests, target),
    ...selectedObservation(rows),
    expectedTargetCited: expectedTargetCited(result.json, target),
    findingKinds: (seed?.findings ?? []).map((finding) => finding.reason),
    analysisSufficiency: seed?.sufficiency?.status,
    evidenceClassification: analysis.evidence.classification,
    corruptLogLineCount: analysis.evidence.corruptLineCount,
    unsupportedLogLineCount: analysis.evidence.unsupportedLineCount,
    incompleteLogLineCount: analysis.evidence.incompleteLineCount,
    sequenceAnomalyCount: analysis.evidence.sequenceAnomalies.length,
    readerTimelineCount: rows.length,
  };
}
