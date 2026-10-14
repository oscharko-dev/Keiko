// Qualification observations reuse the product's protected-context accounting and validated log
// reader. No text from a source, skill, answer or checkpoint is returned by these helpers.
import { importBuilt } from "../coding-workbench-lab/lab-common.mjs";
import { logAnalysis } from "../coding-workbench-lab/connected-chat-record.mjs";
import { flatten } from "../coding-workbench-lab/activity-log-events.mjs";
import { digest } from "./runtime.mjs";

export function contextObservation(status, selected, expectedTokens) {
  const segments = status.segments ?? [];
  const protectedSegment = segments.find((segment) => segment.id === "skill");
  return {
    window: status.contextWindowTokens,
    inputBudget: status.inputBudgetTokens,
    estimatedInputTokens: status.estimatedInputTokens,
    skillTokens: protectedSegment?.tokens ?? 0,
    expectedSkillTokens: expectedTokens,
    accounted:
      segments.reduce((sum, segment) => sum + segment.tokens, 0) === status.contextWindowTokens &&
      (protectedSegment?.tokens ?? 0) === expectedTokens &&
      (selected
        ? status.protectedSkill?.reference.digest === selected.digest
        : status.protectedSkill === undefined),
    compaction: status.compaction,
    pendingCompaction: status.pendingCompaction,
  };
}

export async function expectedSkillTokens(runtime, selected) {
  const { loadConfigFromFile } = await importBuilt("keiko-model-gateway", "index.js");
  const { currentContextProfileForModel } = await importBuilt("keiko-server", "deps.js");
  const { markdownSkillInstructionTokens } = await importBuilt(
    "keiko-server",
    "markdown-skill-prompt.js",
  );
  const config = loadConfigFromFile(runtime.env.KEIKO_CONFIG_FILE, runtime.env);
  const profile = currentContextProfileForModel({ config }, runtime.model);
  return markdownSkillInstructionTokens(selected, profile);
}

function checkpointObservation(checkpoint, status, skillBody, messages) {
  if (checkpoint === undefined) return { observed: false };
  const wire = JSON.stringify(checkpoint);
  return {
    observed:
      messages.some(
        (message) => message.id === checkpoint.conversationCoverage?.throughMessageId,
      ) && status.compaction?.messagesCompacted === checkpoint.itemsBefore,
    digest: digest(wire),
    messagesCompacted: checkpoint.itemsBefore,
    tokensBefore: checkpoint.tokensBefore,
    tokensAfter: checkpoint.tokensAfter,
    excludesSkill:
      !wire.includes(skillBody) &&
      !wire.includes("GARDEN_SKILL_TAIL_4028") &&
      !wire.includes("<selected_skill>"),
  };
}

export async function turnObservation(runtime, correlationId, chatId, status, skillBody, messages) {
  const { analysis, seed } = await logAnalysis(runtime.env.KEIKO_STATE_DIR, correlationId);
  const rows = (seed?.timeline ?? []).map(flatten);
  const capture = rows.findLast((row) => row.op === "chat.continuity.capture");
  const { createNodeEvidenceStore } = await importBuilt("keiko-evidence", "index.js");
  const { loadChatContinuityCheckpoint } = await importBuilt(
    "keiko-server",
    "chat-compaction-resurfacing.js",
  );
  const store = createNodeEvidenceStore(runtime.env.KEIKO_EVIDENCE_DIR);
  const checkpoint =
    capture === undefined
      ? undefined
      : loadChatContinuityCheckpoint(store, chatId, capture.historyRevision, correlationId);
  return {
    evidenceClassification: analysis.evidence.classification,
    analysisSufficiency: seed?.sufficiency?.status,
    corruptLogLineCount: analysis.evidence.corruptLineCount,
    selectedEvents: rows
      .filter((row) => row.op === "chat.context.selected")
      .map((row) => ({
        state: row.state,
        compactedHistoryMessages: row.compactedHistoryMessages,
        retainedHistoryMessages: row.retainedHistoryMessages,
      })),
    usage: rows
      .filter((row) => row.op === "gateway.chat.completed")
      .map((row) => ({
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        reasoningTokens: row.reasoningTokens,
        finishReason: row.finishReason,
        durationMs: row.durationMs,
      })),
    checkpoint: checkpointObservation(checkpoint, status, skillBody, messages),
  };
}
