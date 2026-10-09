// Closed, body-free observations of actual responses; no answer is promoted to a semantic proof.
import { createHash } from "node:crypto";
import { importBuilt } from "./lab-common.mjs";
import { flatten } from "./activity-log-events.mjs";
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
  "search.connected-context.completed": [
    "scopeIdentitySha256",
    "queryIdentitySha256",
    "usageFilesRead",
    "selectedFileCount",
  ],
  "search.connected-context.completion-details": [
    "scopeIdentitySha256",
    "queryIdentitySha256",
    "indexProviderStatus",
    "indexSearchMode",
    "indexIndexedRecords",
    "indexReusedRecords",
    "workspaceIoContentReadCalls",
    "workspaceIoContentReadBytes",
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
    new Set(rows.map((row) => row.instanceId)).size === 1 &&
    new Set(rows.map((row) => row.pid)).size === 1
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

function retrievalObservation(rows, answer) {
  const coverage = answer.contextPack?.coverage;
  return {
    coverage:
      coverage === undefined
        ? undefined
        : {
            incomplete: coverage.incomplete,
            truncated: coverage.truncated,
            reasons: coverage.reasons,
            filesDiscovered: coverage.filesDiscovered,
            filesScanned: coverage.filesScanned,
            filesSkipped: coverage.filesSkipped,
            matchesReturned: coverage.matchesReturned,
          },
    retrievalEvents: rows
      .filter((row) => row.op === "search.connected-context.completed")
      .map((row) => ({
        scopeIdentitySha256: row.scopeIdentitySha256,
        queryIdentitySha256: row.queryIdentitySha256,
        dedicatedExcerptFilesRead: row.usageFilesRead,
        selectedFileCount: row.selectedFileCount,
      })),
    workspaceEvents: rows
      .filter((row) => row.op === "search.connected-context.completion-details")
      .map((row) => ({
        scopeIdentitySha256: row.scopeIdentitySha256,
        queryIdentitySha256: row.queryIdentitySha256,
        indexProviderStatus: row.indexProviderStatus,
        indexSearchMode: row.indexSearchMode,
        indexIndexedRecords: row.indexIndexedRecords,
        indexReusedRecords: row.indexReusedRecords,
        workspaceIoContentReadCalls: row.workspaceIoContentReadCalls,
        workspaceIoContentReadBytes: row.workspaceIoContentReadBytes,
      })),
  };
}

function evidenceObservation(manifests, target) {
  return {
    expectedTargetInRetainedEvidence:
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

function targetPromptObservation(answer, target) {
  if (target === undefined) return {};
  const cited = expectedTargetCited(answer, target);
  return {
    expectedTargetInPrompt:
      cited === true ? true : answer.contextPack?.filesInPrompt === 0 ? false : undefined,
    targetPhysicalReadDisposition: "unobserved",
    targetDeclarationStates: (answer.insufficiencyDeclarations ?? [])
      .filter((entry) => entry.scopePath === target)
      .map((entry) => entry.state),
  };
}

async function logAnalysis(stateDir, correlationId) {
  const reader = await importBuilt("keiko-activity-log", "reader/index.js");
  const { openSafeArtifactFile } = await importBuilt("keiko-security", "fs-hardening.js");
  const files = reader.listActivityLogStoreFiles(stateDir);
  const digest = createHash("sha256");
  let lineCount = 0;
  let firstLine;
  function* lines() {
    for (const file of files) {
      const open = () =>
        openSafeArtifactFile(file.path, {
          artifactClass: "activity-log",
          mode: "read",
          trustedRoot: stateDir,
        });
      for (const line of reader.readActivityLogFileLines(open, {
        onChunk: (chunk) => digest.update(chunk),
      })) {
        firstLine ??= line.text;
        lineCount += 1;
        yield line;
      }
    }
  }
  const analysis = reader.analyzeLogLines(lines(), { sourceKind: "raw-log" });
  const seed =
    correlationId === null
      ? undefined
      : reader.buildReproductionSeedFromAnalysis(
          analysis,
          { kind: "raw-log", lineCount, sha256: digest.digest("hex"), firstLine },
          correlationId,
          new Date(),
        );
  return { analysis, seed };
}

export async function connectedChatObservation(runtime, result, manifests, target) {
  const { splitOwnAssessment } = await importBuilt("keiko-contracts", "grounded-assessment.js");
  const { analysis, seed } = await logAnalysis(runtime.stateDir, result.correlationId);
  const rows = (seed?.timeline ?? []).map(flatten);
  return {
    correlationId: result.correlationId,
    stableProcess: sameActualProcess(rows),
    ...answerObservation(result.json, splitOwnAssessment),
    ...evidenceObservation(manifests, target),
    ...targetPromptObservation(result.json, target),
    ...selectedObservation(rows),
    ...retrievalObservation(rows, result.json),
    expectedTargetCited: expectedTargetCited(result.json, target),
    findingKinds: (seed?.findings ?? []).map((finding) => finding.reason),
    analysisSufficiency: seed?.sufficiency?.status,
    evidenceClassification: analysis.evidence.classification,
    corruptLogLineCount: analysis.evidence.corruptLineCount,
    truncatedLogLineCount: analysis.evidence.truncatedLineCount,
    unsupportedLogLineCount: analysis.evidence.unsupportedLineCount,
    incompleteLogLineCount: analysis.evidence.incompleteLineCount,
    sequenceAnomalyCount: analysis.evidence.sequenceAnomalies.length,
    readerTimelineCount: rows.length,
  };
}

function canonicalNumericValue(value) {
  const token = value.replace(/\s/gu, "").replace("−", "-").replace(",", ".");
  const sign = token.startsWith("-") ? "-" : "";
  const [whole, fraction = ""] = token.replace(/^[+-]/u, "").split(".");
  const integer = whole.replace(/^0+(?=\d)/u, "");
  const decimal = fraction.replace(/0+$/u, "");
  return `${sign}${integer}${decimal.length > 0 ? `.${decimal}` : ""}`;
}

/** A numeric synthetic-corpus witness, not a semantic verdict over arbitrary prose. */
export async function expectedSourceFactObservation(content, fact) {
  if (fact === undefined) return {};
  const { ownAssessmentSourceText } = await importBuilt(
    "keiko-contracts",
    "grounded-assessment.js",
  );
  const { stripInlineCitations } = await importBuilt("keiko-server", "grounded-faithfulness.js");
  const source = stripInlineCitations(ownAssessmentSourceText(content));
  const unit =
    fact.unit === "seconds"
      ? "(?:seconds?|Sekunden|s)\\b"
      : "(?:°\\s*C|degrees?(?:\\s+Celsius)?|Celsius|Grad(?:\\s+Celsius)?)\\b";
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}.,+\\-−])((?:[+\\-−]\\s*)?\\d+(?:[.,]\\d+)?)\\s*(?:[-–]\\s*)?${unit}`,
    "giu",
  );
  const expected = canonicalNumericValue(fact.number);
  return {
    expectedSourceFactPresent: [...source.matchAll(pattern)].some(
      (match) => canonicalNumericValue(match[1]) === expected,
    ),
    expectedSourceFactSha256: createHash("sha256").update(JSON.stringify(fact)).digest("hex"),
  };
}
