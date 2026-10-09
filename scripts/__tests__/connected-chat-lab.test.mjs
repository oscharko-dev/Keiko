// Tool qualification only: real registered writer/reader and privacy projection, no model call.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileServerLogSink,
  createServerLogger,
  nullServerLogger,
  setServerLogger,
} from "../../packages/keiko-activity-log/dist/index.js";
import { logAnswerAssessment } from "../../packages/keiko-server/dist/grounded-citation-log.js";
import { activityLogSegmentFileName } from "../../packages/keiko-contracts/dist/activity-log-files.js";
import {
  connectedChatObservation,
  expectedSourceFactObservation,
} from "../testing/coding-workbench-lab/connected-chat-record.mjs";
import { materializeManualCases } from "../testing/coding-workbench-lab/connected-chat-cases.mjs";
import { createNodeEvidenceStore } from "../../packages/keiko-evidence/dist/index.js";
import { createInMemoryUiStore } from "../../packages/keiko-server/dist/store/index.js";
import { groundedConversationContinuity } from "../../packages/keiko-server/dist/grounded-conversation-continuity.js";
import { persistChatCompactionEvidence } from "../../packages/keiko-server/dist/chat-compaction-evidence.js";
import { readChatContextStatus } from "../../packages/keiko-server/dist/chat-context-status.js";
import {
  logChatContextSelection,
  logGroundedPromptSelection,
} from "../../packages/keiko-server/dist/chat-activity.js";
import { selectGatewayPromptAssembly } from "../../packages/keiko-server/dist/chat-prompt-budget.js";
import { deriveContextProfile } from "../../packages/keiko-contracts/dist/context-engineering.js";

const DIRECTORIES = [];
const CORRELATION = "corr-connected-chat-lab-observation";
const PRIVATE_BODY = "Private model answer and source path /private/secret-source.txt";

function stateWithAcceptedAssessment(count = 1) {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-chat-tool-"));
  DIRECTORIES.push(stateDir);
  const sink = createFileServerLogSink(stateDir, { level: "info" });
  setServerLogger(createServerLogger({ sink, level: "info" }));
  for (let index = 0; index < count; index += 1)
    logAnswerAssessment(
      {
        policy: "allowed",
        sourceBacked: "",
        assessment: PRIVATE_BODY,
        neutralized: false,
      },
      CORRELATION,
      { phase: "accepted-final" },
    );
  sink.close();
  return { stateDir };
}

function copiedState(runtime, transform) {
  const source = join(runtime.stateDir, "logs");
  const segment = readdirSync(source).find((name) => name.endsWith(".jsonl"));
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-chat-copy-"));
  DIRECTORIES.push(stateDir);
  mkdirSync(join(stateDir, "logs"), { mode: 0o700 });
  writeFileSync(
    join(stateDir, "logs", segment),
    transform(readFileSync(join(source, segment), "utf8")),
    { mode: 0o600 },
  );
  return { stateDir };
}

function response() {
  return {
    correlationId: CORRELATION,
    json: {
      content: `<assessment>${PRIVATE_BODY}</assessment>`,
      citations: [],
      uncertainty: [],
    },
  };
}

function compactionFixture(historyCount = 80) {
  const runtime = stateWithAcceptedAssessment();
  const store = createInMemoryUiStore();
  const root = runtime.stateDir;
  store.createProject(root);
  const chat = store.createChat(root, "Qualification", "qualification-model");
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", root, relativePaths: [], connectedAtMs: 0 },
  });
  for (let index = 0; index < historyCount; index += 1)
    store.createMessage({
      chatId: chat.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: "Synthetic user history, not evidence or a model response. ".repeat(120),
      timestamp: index,
    });
  const startedAt = Date.now();
  const question = "Compare alternatives with uncertain evidence.";
  const user = store.createMessage({
    chatId: chat.id,
    role: "user",
    content: question,
    timestamp: startedAt,
  });
  const evidenceStore = createNodeEvidenceStore(join(root, "evidence"));
  const deps = {
    store,
    evidenceStore,
    env: {},
    contextProfile: deriveContextProfile({
      maxInputTokens: 4096,
      reservedOutputTokens: 256,
      safetyMarginTokens: 128,
    }),
  };
  const sink = createFileServerLogSink(root, { level: "info" });
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const continuity = groundedConversationContinuity(deps, user, "qualification-model", CORRELATION);
  persistChatCompactionEvidence(deps, {
    compaction: continuity.compaction,
    chatId: chat.id,
    modelId: "qualification-model",
    messageCount: historyCount,
    startedAt,
    finishedAt: Date.now(),
    correlationId: CORRELATION,
  });
  const assembly = selectGatewayPromptAssembly({
    historyPrefix: store.listMessages(chat.id).filter((message) => message.id !== user.id),
    historyTurnCount: historyCount,
    request: { content: "", discussionMode: undefined },
    profile: deps.contextProfile,
    memoryEntries: [],
    documentContext: [],
    redactionSecrets: [],
    proactiveCompaction: true,
  });
  if (assembly !== undefined) logChatContextSelection(CORRELATION, assembly, 0);
  logGroundedPromptSelection(CORRELATION, { messages: [] }, 4096);
  const answer = store.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: PRIVATE_BODY,
    timestamp: Date.now(),
  });
  sink.close();
  const binding = {
    chatId: chat.id,
    question,
    startedAt,
    finishedAt: Date.now(),
    evidenceStore,
    modelId: "qualification-model",
    scopeIdentityBefore: store.findChatById(chat.id).groundingScopeIdentity,
    scopeIdentityAfter: store.findChatById(chat.id).groundingScopeIdentity,
    persistedMessages: store.listMessages(chat.id),
    contextStatus: readChatContextStatus(deps, chat.id, "qualification-model"),
  };
  const result = response();
  result.status = 200;
  result.json.assistantMessageId = answer.id;
  return { runtime, binding, result, store, continuity };
}

afterEach(() => {
  setServerLogger(nullServerLogger());
  while (DIRECTORIES.length > 0) rmSync(DIRECTORIES.pop(), { recursive: true, force: true });
});

describe("connected-chat lab's body-free observation", () => {
  it("reads the actual registered assessment writer through the canonical support reader", async () => {
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), response(), []);
    expect(record.assessmentEvents).toEqual([
      expect.objectContaining({
        phase: "accepted-final",
        policy: "allowed",
        outcome: "assessment-only",
        sourceBackedChars: 0,
      }),
    ]);
    expect(record.readerTimelineCount).toBeGreaterThan(0);
    expect(record.unsupportedLogLineCount).toBe(0);
    expect(record.corruptLogLineCount).toBe(0);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(record)).not.toContain("secret-source");
  });

  it("counts actual compaction records and omits unknown usage metadata", async () => {
    const manifest = {
      compaction: [],
      usageTotals: {
        promptTokens: 13,
        completionTokens: 7,
        requestCount: 1,
        totalLatencyMs: 4,
        arbitraryBody: PRIVATE_BODY,
      },
    };
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), response(), [
      manifest,
    ]);
    expect(record.compactionEvidenceCount).toBe(0);
    expect(record.usageTotals).toEqual([
      {
        promptTokens: 13,
        completionTokens: 7,
        requestCount: 1,
        totalLatencyMs: 4,
      },
    ]);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
  });

  it("preserves malformed persisted lines for the validated reader's integrity verdict", async () => {
    const runtime = stateWithAcceptedAssessment();
    const logDir = join(runtime.stateDir, "logs");
    const segment = readdirSync(logDir).find((name) => name.endsWith(".jsonl"));
    const damaged = mkdtempSync(join(tmpdir(), "keiko-connected-chat-damaged-"));
    DIRECTORIES.push(damaged);
    mkdirSync(join(damaged, "logs"), { mode: 0o700 });
    writeFileSync(
      join(damaged, "logs", segment),
      `${readFileSync(join(logDir, segment), "utf8")}{ broken record\n`,
      { mode: 0o600 },
    );
    runtime.stateDir = damaged;
    const record = await connectedChatObservation(runtime, response(), []);
    expect(record.evidenceClassification).toBe("corrupt");
    expect(record.corruptLogLineCount).toBe(1);
  });

  it("retains the actual wire's uncited warning count", async () => {
    const result = response();
    result.json.uncertainty.push({ kind: "uncited-answer", claim: PRIVATE_BODY });
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), result, []);
    expect(record.uncitedWarningCount).toBe(1);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
  });

  it("does not label two valid process IDs with the same instance as stable", async () => {
    let matched = 0;
    const runtime = copiedState(
      stateWithAcceptedAssessment(2),
      (text) =>
        text
          .trimEnd()
          .split("\n")
          .map((line) => {
            const row = JSON.parse(line);
            if (row.correlationId === CORRELATION && matched++ === 1) row.pid += 1;
            return JSON.stringify(row);
          })
          .join("\n") + "\n",
    );
    const record = await connectedChatObservation(runtime, response(), []);
    expect(record.assessmentEvents).toHaveLength(2);
    expect(record.readerTimelineCount).toBeGreaterThanOrEqual(2);
    expect(record.corruptLogLineCount).toBe(0);
    expect(record.stableProcess).toBe(false);
  });

  it("keeps an earlier torn segment truncated through the canonical per-file line iterator", async () => {
    const original = stateWithAcceptedAssessment();
    const runtime = copiedState(original, (text) => `${text}{ torn fragment`);
    const next = activityLogSegmentFileName(
      { startMs: Date.now(), pid: 4242, instanceId: "a1b2c3d4", index: 2 },
      "sealed",
    );
    const originalName = readdirSync(join(original.stateDir, "logs")).find((name) =>
      name.endsWith(".jsonl"),
    );
    writeFileSync(
      join(runtime.stateDir, "logs", next),
      readFileSync(join(original.stateDir, "logs", originalName)),
      { mode: 0o600 },
    );
    const record = await connectedChatObservation(runtime, response(), []);
    expect(record.evidenceClassification).toBe("truncated");
    expect(record.truncatedLogLineCount).toBe(1);
    expect(record.corruptLogLineCount).toBe(0);
  });

  it("distinguishes retained evidence from zero-sent prompt and unobserved physical reads", async () => {
    const result = response();
    result.json.contextPack = { filesInPrompt: 0 };
    const target = "manual/guide.html";
    const record = await connectedChatObservation(
      stateWithAcceptedAssessment(),
      result,
      [{ connectedContext: { files: [{ scopePath: target }] } }],
      target,
    );
    expect(record.expectedTargetInRetainedEvidence).toBe(true);
    expect(record.expectedTargetInPrompt).toBe(false);
    expect(record.targetPhysicalReadDisposition).toBe("unobserved");
    expect(record.expectedTargetRead).toBeUndefined();
  });

  it("does not promote a declaration read-state to final-prompt membership", async () => {
    const result = response();
    const target = "manual/guide.html";
    result.json.insufficiencyDeclarations = [{ scopePath: target, state: "read-in-this-turn" }];
    const record = await connectedChatObservation(
      stateWithAcceptedAssessment(),
      result,
      [],
      target,
    );
    expect(record.expectedTargetInPrompt).toBeUndefined();
    expect(record.targetDeclarationStates).toEqual(["read-in-this-turn"]);
    expect(record.expectedTargetInRetainedEvidence).toBe(false);
  });

  it("verifies a separately persisted history checkpoint despite a later zero-compaction synthesis log", async () => {
    const { runtime, binding, result, continuity } = compactionFixture();
    expect(continuity.compaction.itemsBefore).toBeGreaterThan(0);
    const record = await connectedChatObservation(runtime, result, [], undefined, binding);
    expect(record.compactionEvidenceCount).toBe(0);
    expect(record.compaction.state).toBe("compacted");
    expect(record.contextSelections.map((entry) => entry.state)).toEqual(["compacted", "verbatim"]);
    expect(record.historyCompaction).toMatchObject({
      disposition: "observed",
      cause: "persisted-checkpoint",
      requestMessagesBound: true,
      scopeUnchanged: true,
      contextStatusBound: true,
    });
    expect(record.historyCompaction.itemsBefore).toBe(continuity.compaction.itemsBefore);
    expect(record.historyCompaction.tokensBefore).toBeGreaterThan(
      record.historyCompaction.tokensAfter,
    );
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(record)).not.toContain(binding.question);
    expect(JSON.stringify(record)).not.toContain(binding.chatId);
    expect(JSON.stringify(record)).not.toContain(
      binding.evidenceStore.location(binding.evidenceStore.list()[0]),
    );
  });

  it.each(["scope-changed", "history-boundary-unobserved", "context-status-unobserved"])(
    "keeps compaction unobserved when %s",
    async (cause) => {
      const { runtime, binding, result, store, continuity } = compactionFixture();
      if (cause === "scope-changed")
        binding.scopeIdentityAfter = store.updateChat(binding.chatId, {
          connectedScopes: [],
        }).groundingScopeIdentity;
      if (cause === "history-boundary-unobserved")
        binding.persistedMessages = binding.persistedMessages.filter(
          (message) => message.id !== continuity.compaction.conversationCoverage.throughMessageId,
        );
      if (cause === "context-status-unobserved") binding.contextStatus = undefined;
      const record = await connectedChatObservation(runtime, result, [], undefined, binding);
      expect(record.historyCompaction).toMatchObject({ disposition: "unobserved", cause });
    },
  );

  it("does not claim checkpoint evidence from a zero-compaction or unbound request", async () => {
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), response(), []);
    expect(record.historyCompaction).toEqual({
      disposition: "unobserved",
      cause: "request-binding-unobserved",
    });
  });

  it("keeps an actually empty history's zero-compaction outcome unobserved", async () => {
    const { runtime, binding, result, continuity } = compactionFixture(0);
    expect(continuity.compaction).toBeUndefined();
    const record = await connectedChatObservation(runtime, result, [], undefined, binding);
    expect(record.compaction.compactedHistoryMessages).toBe(0);
    expect(record.historyCompaction).toEqual({
      disposition: "unobserved",
      cause: "checkpoint-unobserved",
    });
  });
});

describe("manual campaign's existing corpus witness", () => {
  const corpus = () => ({
    fileCount: 100_000,
    noGit: true,
    root: "/private/corpus",
    targets: {
      late: { path: "late/interlock.html", body: PRIVATE_BODY },
      generated: { path: "generated/Überhitzungsschutz.html", body: PRIVATE_BODY },
      deep72: { path: "deep72/recovery.html", expectedDelaySeconds: 49 },
    },
  });
  it("binds original content/entity queries and same-chat depth/follow-up/general/source-return without retaining bodies", async () => {
    const rows = await materializeManualCases(corpus());
    expect(rows).toHaveLength(8);
    expect(rows[0].question).toBe(
      "What temperature trips the Vesper dosing interlock? Cite the authoritative manual. Keep the answer under 100 words.",
    );
    expect(rows[0].question).not.toContain(rows[0].target);
    expect(rows[2].question).toContain("Überhitzungsschutz");
    expect(rows[3].question).toContain("deep72/recovery.html");
    expect(rows[4].target).toBe(rows[3].target);
    expect(rows[5].target).toBeUndefined();
    expect(rows[7].target).toBe(rows[3].target);
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(rows)).not.toContain("/private/corpus");
  });
  it("rejects witness paths outside portable relative scope before any API use", async () => {
    const witness = corpus();
    witness.targets.late.path = "../outside.html";
    await expect(materializeManualCases(witness)).rejects.toThrow("invalid-manual-target");
  });
  it("records a unit-qualified source fact without accepting path digits or assessment prose", async () => {
    const fact = { number: "49", unit: "seconds" };
    const present = await expectedSourceFactObservation(
      "Wait 49 seconds [deep/49/recovery.html:1].",
      fact,
    );
    expect(present.expectedSourceFactPresent).toBe(true);
    expect(present.expectedSourceFactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await expectedSourceFactObservation(
        "[deep/49/recovery.html:1] <assessment>Wait 49 seconds</assessment>",
        fact,
      ),
    ).toMatchObject({ expectedSourceFactPresent: false });
    expect(Object.keys(present)).toEqual(["expectedSourceFactPresent", "expectedSourceFactSha256"]);
  });

  it.each([
    ["0.61 seconds", "61", "seconds", false],
    ["0,61 seconds", "61", "seconds", false],
    ["0.91°C", "91", "temperature", false],
    ["0,91°C", "91", "temperature", false],
    ["-61 seconds", "61", "seconds", false],
    ["− 61 Sekunden", "61", "seconds", false],
    ["-91°C", "91", "temperature", false],
    ["+0.61 seconds", "61", "seconds", false],
    ["1e+61 seconds", "61", "seconds", false],
    ["+-61 seconds", "61", "seconds", false],
    ["61.000000000000001 seconds", "61", "seconds", false],
    ["91,000000000000001°C", "91", "temperature", false],
    ["161 seconds", "61", "seconds", false],
    ["191°C", "91", "temperature", false],
    ["61 seconds", "61", "seconds", true],
    ["+61 seconds", "61", "seconds", true],
    ["+ 91 °C", "91", "temperature", true],
    ["61,2 Sekunden", "61.2", "seconds", true],
    ["61.20 seconds", "61.2", "seconds", true],
    ["91.5 degrees Celsius", "91.5", "temperature", true],
    ["0.61 seconds", "0.61", "seconds", true],
    ["0,91°C", "0.91", "temperature", true],
    ["<assessment>61 seconds</assessment>", "61", "seconds", false],
    ["[manual/61/recovery.html:1]", "61", "seconds", false],
  ])("matches a complete numeric source token in %s", async (content, number, unit, expected) => {
    const record = await expectedSourceFactObservation(content, { number, unit });
    expect(record.expectedSourceFactPresent).toBe(expected);
    expect(record.expectedSourceFactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(record)).toEqual(["expectedSourceFactPresent", "expectedSourceFactSha256"]);
  });
});
