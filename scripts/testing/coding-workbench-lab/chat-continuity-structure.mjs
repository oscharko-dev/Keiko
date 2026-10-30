// Observe real compaction/recall producers without equating structural coverage with model quality.
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  deriveContextProfile,
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { importBuilt, parseCli, runMain } from "./lab-common.mjs";
import { privateContinuityOutput } from "./chat-continuity-runtime.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { readContinuityBuildIdentity } from "./chat-continuity-build.mjs";

const PROFILE = deriveContextProfile({
  maxInputTokens: 32000,
  reservedOutputTokens: 2000,
  safetyMarginTokens: 1000,
});
const SOURCE_MESSAGES = 40;
const IDENTIFIER_CASES = [
  { id: "short-hyphen", query: "Q7-42?", identifier: "Q7-42" },
  { id: "unicode-dash", query: "Q7‑42?", identifier: "Q7-42" },
  { id: "mixed-identifier", query: "A7?", identifier: "A7" },
  { id: "upper-abbreviation", query: "MCP?", identifier: "MCP" },
  { id: "lower-abbreviation", query: "mcp?", identifier: "MCP" },
  { id: "numeric", query: "47?", identifier: "47" },
  { id: "version", query: "v1.2?", identifier: "v1.2" },
  { id: "literal-boundaries", query: "Q7-42?", identifier: "Q7-42", boundary: true },
];
const IDENTIFIER_ANSWER = "ochre";
const IDENTIFIER_DISTRACTOR =
  "Reference XQ7-42 and Q7-420 are unrelated; version v1x2 uses remote mode.";

function identifierCase(store, project, entry, rehydrate) {
  const chatId = store.createChat(project, "Synthetic identifier case", "structural").id;
  const source = storedMessage(
    store,
    chatId,
    "user",
    `Reference ${entry.identifier}: agreed color ${IDENTIFIER_ANSWER}. Version v1.2 uses offline mode.`,
    0,
  );
  storedMessage(store, chatId, "assistant", "Acknowledged.", 1);
  if (entry.boundary) {
    storedMessage(store, chatId, "user", IDENTIFIER_DISTRACTOR, 2);
    storedMessage(store, chatId, "assistant", "Acknowledged.", 3);
  }
  const queries = entry.boundary ? [entry.query, "v1.2?"] : [entry.query];
  const results = queries.map((query) =>
    rehydrate(store, chatId, query, new Set(), [], "identifier-benchmark"),
  );
  return {
    id: entry.id,
    passed: results.every(
      (result) =>
        result?.includes(source.id) &&
        result.includes(IDENTIFIER_ANSWER) &&
        !result.includes("remote mode"),
    ),
    originalsPreserved: store.countMessages(chatId) === (entry.boundary ? 4 : 2),
  };
}

async function identifierRecallBenchmark(store, project) {
  const { rehydrateChatHistory } = await importBuilt("keiko-server", "chat-history-rehydration.js");
  const cases = IDENTIFIER_CASES.map((entry) =>
    identifierCase(store, project, entry, rehydrateChatHistory),
  );
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    version: "literal-identifier-v1",
    caseDigest: sha256Hex(
      JSON.stringify({
        cases: IDENTIFIER_CASES,
        answer: IDENTIFIER_ANSWER,
        distractor: IDENTIFIER_DISTRACTOR,
      }),
    ),
    passed,
    total: cases.length,
    score: Number(((10 * passed) / cases.length).toFixed(2)),
    cases,
  };
}

function storedMessage(store, chatId, role, content, index) {
  return store.createMessage({
    chatId,
    role,
    content,
    timestamp: 1700000000000 + index,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

function sourceMessages(store, chatId) {
  return Array.from({ length: SOURCE_MESSAGES }, (_, index) =>
    storedMessage(
      store,
      chatId,
      index % 2 ? "assistant" : "user",
      `WitnessMarker${String(index).padStart(3, "0")}. ${"Synthetic discussion detail. ".repeat(90)}`,
      index,
    ),
  );
}

function observedModel(requests) {
  return {
    call: (request) => {
      requests.push(request);
      return Promise.resolve({
        modelId: "structural",
        content: JSON.stringify({
          content: "Synthetic continuity summary.",
          decisions: [],
          constraints: [],
          filesAndSymbols: [],
          debuggingContext: [],
          openThreads: [],
        }),
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "synthetic",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "low",
        },
      });
    },
  };
}

function sourceRecord(store, chatId, messages) {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "synthetic-source-coverage-measurement",
    itemsBefore: messages.length,
    itemsAfter: 0,
    tokensBefore: 40000,
    tokensAfter: 1000,
    sourceSpans: messages.map((message) => ({ kind: "message", stableId: message.id })),
    conversationCoverage: {
      version: 1,
      throughMessageId: messages.at(-1).id,
      historyRevision: store.chatHistoryRevision(chatId),
      contextWindowTokens: PROFILE.maxInputTokens,
      effectiveInputBudget: PROFILE.effectiveInputBudget,
    },
  };
}

async function summarySourceCoverage(store, chatId, messages) {
  const { enrichChatCompactionWithModelSummary } = await importBuilt(
    "keiko-server",
    "chat-compaction-model-summary.js",
  );
  const requests = [],
    evidence = createInMemoryEvidenceStore();
  await enrichChatCompactionWithModelSummary(
    {
      store,
      evidenceStore: evidence,
      env: {},
      redactor: (value) => value,
      contextProfile: { ...PROFILE, model: { id: "structural" } },
      modelPortFactory: () => observedModel(requests),
    },
    {
      chatId,
      modelId: "structural",
      messageCount: messages.length,
      startedAt: 1700000000000,
      finishedAt: 1700000000001,
      historyPrefix: messages,
      compaction: sourceRecord(store, chatId, messages),
    },
  );
  const prompt = requests
    .flatMap((request) => request.messages)
    .map((message) => message.content)
    .join("\n");
  const delivered = messages.filter((message) =>
    prompt.includes(message.content.split(".")[0]),
  ).length;
  const runId = `chat-${sha256Hex(chatId).slice(0, 16)}-t${messages.length}`;
  const summary = loadEvidence(evidence, runId)?.compaction?.[0]?.modelSummary;
  return {
    availableMessages: messages.length,
    modelCalls: requests.length,
    witnessesDelivered: delivered,
    coveredFraction: delivered / messages.length,
    declaredCoveredItems: summary?.coveredItems ?? null,
    summaryStatus: summary?.status ?? "absent",
  };
}

async function shortIdentifierRecall(store, project) {
  const { rehydrateChatHistory } = await importBuilt("keiko-server", "chat-history-rehydration.js");
  const chatId = store.createChat(project, "Synthetic identifier recall", "structural").id;
  storedMessage(store, chatId, "user", "Vorgang Q7-42: vereinbarter Betrag 8100 EUR.", 0);
  storedMessage(store, chatId, "assistant", "Acknowledged.", 1);
  const result = rehydrateChatHistory(
    store,
    chatId,
    "Q7-42?",
    new Set(),
    [],
    "structural-short-id",
  );
  return { originalExists: store.countMessages(chatId) === 2, returned: result !== undefined };
}

async function manualProjection(messages) {
  const { conversationForGatewayWithCompaction } = await importBuilt(
    "keiko-server",
    "conversation-compaction.js",
  );
  const outcome = conversationForGatewayWithCompaction(messages, {
    contextProfile: PROFILE,
    effectiveInputBudget: 20000,
    preserveNewestTurn: false,
    compactAllHistory: true,
  });
  return {
    originalMessages: messages.length,
    gatewayMessages: outcome.messages.length,
    verbatimSourceMessagesRetained: messages.filter((message) =>
      outcome.messages.some((sent) => sent.content === message.content),
    ).length,
    tokensBefore: outcome.compaction?.tokensBefore ?? null,
    tokensAfter: outcome.compaction?.tokensAfter ?? null,
  };
}

export async function observeChatContinuityStructure() {
  const { createInMemoryUiStore } = await importBuilt("keiko-server", "store/index.js");
  const { createServerLogger, setServerLogger, getServerLogger } = await importBuilt(
    "keiko-server",
    "observability/index.js",
  );
  const previous = getServerLogger(),
    events = [];
  setServerLogger(createServerLogger({ sink: { write: (event) => events.push(event) } }));
  const project = realpathSync(mkdtempSync(join(tmpdir(), "keiko-continuity-structure-")));
  const store = createInMemoryUiStore();
  try {
    store.createProject(project, "Synthetic structural measurement");
    const chatId = store.createChat(project, "Synthetic source coverage", "structural").id;
    const messages = sourceMessages(store, chatId);
    const report = {
      measurementKind: "deterministic-production-path-observation-not-model-quality",
      shortIdentifierRecall: await shortIdentifierRecall(store, project),
      identifierRecallBenchmark: await identifierRecallBenchmark(store, project),
      summarySourceCoverage: await summarySourceCoverage(store, chatId, messages),
      manualProjection: await manualProjection(messages),
      canonicalMessagesAfter: store.countMessages(chatId),
      logOperations: [...new Set(events.map((event) => event.op))],
    };
    return report;
  } finally {
    store.close();
    rmSync(project, { recursive: true, force: true });
    setServerLogger(previous);
  }
}

async function main() {
  const cli = parseCli({
    usage: "chat-continuity-structure.mjs --output <new-private-external-json>",
    options: { output: { type: "string" } },
  });
  if (cli.help) return;
  const output = privateContinuityOutput(cli.values.output);
  const report = {
    ...readContinuityBuildIdentity(),
    harnessDigest: sha256Hex(readFileSync(new URL(import.meta.url))),
    ...(await observeChatContinuityStructure()),
  };
  writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (isMainModule(import.meta.url)) runMain(main);
