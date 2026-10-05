import { resetServerLogFailureNotices } from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
// Activity-log contract for connected-context retrieval (#3347). Every invocation emits one start
// and exactly one body-free terminal line, including failure and cancellation paths.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type EvidenceAtom,
  type ExplorationBudget,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  createWorkspaceIndex,
  WorkspaceReadError,
  type WorkspaceIndex,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import type { MicroIndex, RerankerSeam } from "@oscharko-dev/keiko-workflows";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { deriveGroundedContextAssembly } from "./grounded-context-diagnostics.js";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  retrieveConnectedContextPack,
  ClarificationNeededError,
  type GroundedAnswerer,
  type OrchestratorDeps,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import type { GitFileHistoryEvidenceProvider } from "./grounded-git-history-evidence.js";
import {
  createFileServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
} from "./observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  ACTIVITY_LOG_STORAGE_OPERATIONS,
  MAX_LOG_FIELD_COUNT,
} from "@oscharko-dev/keiko-activity-log";

const FIXTURE_NOW_MS = 1_700_000_000_000;
const FIXTURE_ROOT = "/private/customer/connected-context-log-fixture";
const FIXTURE_QUERY_TEXT = "Trace PrivateCustomerHandler implementation";
const CORRELATION_ID = "connected-context-log-correlation-0001";
const PRIVATE_SCOPE_PATH = "private-source";
const PRIVATE_SCOPE_FILE = `${PRIVATE_SCOPE_PATH}/private-customer-handler.ts`;
const UNUSED_EXPECTED_STAT: WorkspaceStat = {
  size: 1,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

const ANSWERER_NOT_USED: GroundedAnswerer = {
  answer: (): Promise<string> => Promise.resolve("answerer must not run"),
};

const NO_GIT_HISTORY: GitFileHistoryEvidenceProvider = (): Promise<readonly EvidenceAtom[]> =>
  Promise.resolve([]);

function fixtureScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "connected-context-log-scope",
    workspaceRoot: FIXTURE_ROOT,
    kind: "files",
    relativePaths: [PRIVATE_SCOPE_FILE],
    conversationId: undefined,
    connectedAtMs: FIXTURE_NOW_MS,
    explicitConnection: false,
  };
}

function fixtureQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: FIXTURE_QUERY_TEXT,
    caseSensitive: false,
    maxResults: 20,
    emittedAtMs: FIXTURE_NOW_MS,
  };
}

function fixtureInput(readBudgetBlocked = false): OrchestratorInput {
  return {
    scope: fixtureScope(),
    query: fixtureQuery(),
    workspaceRoot: FIXTURE_ROOT,
    ...(readBudgetBlocked
      ? {
          budget: {
            ...DEFAULT_EXPLORATION_BUDGET,
            filesReadMax: 0,
            excerptBytesMax: 0,
          },
        }
      : {}),
  };
}

function fixtureWorkspace(): WorkspaceInfo {
  return {
    root: FIXTURE_ROOT,
    selectedRoot: FIXTURE_ROOT,
    name: "connected-context-log-fixture",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: [PRIVATE_SCOPE_PATH],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function fixtureDeps(
  activityLog: ServerLogSink,
  correlationId: string | undefined,
): OrchestratorDeps {
  return {
    answerer: ANSWERER_NOT_USED,
    correlationId,
    activityLog,
    nowMs: () => FIXTURE_NOW_MS,
    fs: memFs(FIXTURE_ROOT, {
      [PRIVATE_SCOPE_FILE]: "export function PrivateCustomerHandler(): string { return 'ok'; }\n",
    }),
    detectWorkspace: fixtureWorkspace,
    gitFileHistoryEvidence: NO_GIT_HISTORY,
  };
}

async function budgetStartedEvent(
  budget: Readonly<Record<string, unknown>>,
): Promise<ServerLogEvent> {
  const activityLog = createBufferedServerLogSink();
  const abort = new AbortController();
  abort.abort();
  await expect(
    retrieveConnectedContextPack(
      { ...fixtureInput(), budget: budget as unknown as ExplorationBudget },
      { ...fixtureDeps(activityLog, CORRELATION_ID), signal: abort.signal },
    ),
  ).rejects.toBeInstanceOf(CancelledError);
  const [started] = lifecycleEvents(activityLog, "search.connected-context.failed");
  expectBodyFree(activityLog);
  return started;
}

function privateFixtureValues(): readonly string[] {
  return [
    FIXTURE_QUERY_TEXT,
    FIXTURE_ROOT,
    fixtureScope().scopeId,
    PRIVATE_SCOPE_PATH,
    PRIVATE_SCOPE_FILE,
  ];
}

function parsePersistedLogLines(raw: string): readonly Readonly<Record<string, unknown>>[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
}

function producerLogLines(raw: string): readonly Readonly<Record<string, unknown>>[] {
  return parsePersistedLogLines(raw).filter(
    (line) => !ACTIVITY_LOG_STORAGE_OPERATIONS.has(String(line.op)),
  );
}

function advancingClock(): () => number {
  let current = FIXTURE_NOW_MS;
  return (): number => {
    const value = current;
    current += 7;
    return value;
  };
}

function expectSha256(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new TypeError("expected a SHA-256 string");
  }
  expect(value).toMatch(/^[a-f0-9]{64}$/u);
}

function expectAnchoredFrames(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new TypeError("expected anchored stack frames");
  }
  expect(value.length).toBeGreaterThan(0);
  for (const frame of value) {
    expect(frame).toMatch(
      /^(?:packages\/keiko-[a-z0-9-]+\/(?:dist|src)|(?:dist|src)\/cli)\/[A-Za-z0-9_./-]+\.(?:js|ts):\d+:\d+$/u,
    );
  }
}

function expectNonNegativeNumberFields(
  fields: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[],
): void {
  for (const name of names) {
    const value = fields?.[name];
    expect(typeof value).toBe("number");
    if (typeof value !== "number") {
      throw new TypeError(`expected ${name} to be a number`);
    }
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

function nestedExtra(
  fields: Readonly<Record<string, unknown>> | undefined,
  name: string,
): Readonly<Record<string, unknown>> {
  const value = fields?.[name];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  const mapping = COMPLETION_FIELD_GROUPS[name];
  if (mapping === undefined) throw new TypeError(`expected ${name} activity object`);
  return Object.fromEntries(
    Object.entries(mapping)
      .filter(([, fieldName]) => fields?.[fieldName] !== undefined)
      .map(([projectedName, fieldName]) => [projectedName, fields?.[fieldName]]),
  );
}

const COMPLETION_FIELD_GROUPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  usage: {
    searchCalls: "usageSearchCalls",
    filesRead: "usageFilesRead",
    excerptBytes: "usageExcerptBytes",
    modelInputTokens: "usageModelInputTokens",
    modelOutputTokens: "usageModelOutputTokens",
    elapsedMs: "usageElapsedMs",
    rerankCalls: "usageRerankCalls",
  },
  selectionCounts: { selectedFileCount: "selectedFileCount", omittedCount: "omittedCount" },
  uncertainty: {
    count: "uncertaintyCount",
    scopeIncompleteUncertaintyCount: "scopeIncompleteUncertaintyCount",
    budgetClippedUncertaintyCount: "budgetClippedUncertaintyCount",
    toolUnavailableUncertaintyCount: "toolUnavailableUncertaintyCount",
    unsupportedClaimUncertaintyCount: "unsupportedClaimUncertaintyCount",
    entailmentUnavailableUncertaintyCount: "entailmentUnavailableUncertaintyCount",
  },
  coverage: {
    coverageStatus: "coverageStatus",
    coverageReasons: "coverageReasons",
    coverageFilesDiscovered: "coverageFilesDiscovered",
    coverageFilesScanned: "coverageFilesScanned",
    coverageFilesSkipped: "coverageFilesSkipped",
    coverageDepthPruned: "coverageDepthPruned",
    coverageMaxFilesPruned: "coverageMaxFilesPruned",
  },
  retrievalStatus: {
    readBudgetBlocked: "retrievalReadBudgetBlocked",
    elapsedBudgetBlocked: "retrievalElapsedBudgetBlocked",
    workspaceIndexProviderStatus: "retrievalWorkspaceIndexProviderStatus",
  },
  structural: {
    contextCount: "structuralContextCount",
    candidateInventoryBuildCount: "structuralCandidateInventoryBuildCount",
    candidateFileCount: "structuralCandidateFileCount",
    candidateDirectoryCount: "structuralCandidateDirectoryCount",
    codeIndexBuildCount: "structuralCodeIndexBuildCount",
    symbolGraphBuildCount: "structuralSymbolGraphBuildCount",
    importGraphBuildCount: "structuralImportGraphBuildCount",
    endpointGraphBuildCount: "structuralEndpointGraphBuildCount",
    fileSearchCount: "structuralFileSearchCount",
    textSearchCount: "structuralTextSearchCount",
  },
  workspaceIndex: {
    providerStatus: "indexProviderStatus",
    searchMode: "indexSearchMode",
    loadStatus: "indexLoadStatus",
    saveStatus: "indexSaveStatus",
    indexedRecords: "indexIndexedRecords",
    reusedRecords: "indexReusedRecords",
    staleRecords: "indexStaleRecords",
    searchCount: "indexSearchCount",
    reportCount: "indexReportCount",
    fallbackSearchCount: "indexFallbackSearchCount",
    bypassedSearchCount: "indexBypassedSearchCount",
    loadFailures: "indexLoadFailures",
    saveFailures: "indexSaveFailures",
  },
  workspaceIo: {
    readDirCalls: "workspaceIoReadDirCalls",
    readDirEntries: "workspaceIoReadDirEntries",
    statCalls: "workspaceIoStatCalls",
    realPathCalls: "workspaceIoRealPathCalls",
    existsCalls: "workspaceIoExistsCalls",
    contentReadCalls: "workspaceIoContentReadCalls",
    contentReadBytes: "workspaceIoContentReadBytes",
  },
};

function lifecycleEvents(
  activityLog: BufferedServerLogSink,
  terminalOp:
    | "search.connected-context.completed"
    | "search.connected-context.failed"
    | "search.connected-context.clarification-needed",
): readonly [ServerLogEvent, ServerLogEvent] {
  expect(activityLog.events).toHaveLength(
    terminalOp === "search.connected-context.completed" ? 4 : 2,
  );
  const started = activityLog.events[0];
  const terminal = activityLog.events.at(-1);
  if (started === undefined || terminal === undefined) {
    throw new Error("expected connected-context start and terminal activity events");
  }
  expect(started.op).toBe("search.connected-context.started");
  expect(terminal.op).toBe(terminalOp);
  expect(terminal.correlationId).toBe(started.correlationId);
  if (terminalOp === "search.connected-context.completed") {
    const details = activityLog.events[1];
    expect(details?.op).toBe("search.connected-context.completion-details");
    expect(details?.correlationId).toBe(started.correlationId);
    const sourceDetails = activityLog.events[2];
    expect(sourceDetails?.op).toBe("search.connected-context.source-details");
    expect(sourceDetails?.correlationId).toBe(started.correlationId);
    expect(
      activityLogEventRegistration(
        sourceDetails as unknown as Readonly<Record<PropertyKey, unknown>>,
      ),
    ).toBeDefined();
    expect(
      activityLogEventRegistration(details as unknown as Readonly<Record<PropertyKey, unknown>>),
    ).toBeDefined();
  }
  expect(
    activityLogEventRegistration(started as unknown as Readonly<Record<PropertyKey, unknown>>),
  ).toBeDefined();
  expect(
    activityLogEventRegistration(terminal as unknown as Readonly<Record<PropertyKey, unknown>>),
  ).toBeDefined();
  return [started, terminal];
}

function completionDetailsEvent(activityLog: BufferedServerLogSink): ServerLogEvent {
  const details = activityLog.events.find(
    (event) => event.op === "search.connected-context.completion-details",
  );
  if (details === undefined) throw new Error("expected connected-context completion details");
  return details;
}

function expectedRequestExtra(input: OrchestratorInput): Readonly<Record<string, unknown>> {
  const budget = input.budget ?? DEFAULT_EXPLORATION_BUDGET;
  return {
    queryKind: input.query.kind,
    caseSensitive: input.query.caseSensitive,
    maxResults: input.query.maxResults,
    searchCallsMax: budget.searchCallsMax,
    ...(budget.filesReadMax === null ? {} : { filesReadMax: budget.filesReadMax }),
    filesReadBounded: budget.filesReadMax !== null,
    excerptBytesMax: budget.excerptBytesMax,
    modelInputTokensMax: budget.modelInputTokensMax,
    modelOutputTokensMax: budget.modelOutputTokensMax,
    ...(budget.elapsedMsMax === null ? {} : { elapsedMsMax: budget.elapsedMsMax }),
    elapsedMsBounded: budget.elapsedMsMax !== null,
    rerankCallsMax: budget.rerankCallsMax,
  };
}

function expectedCoverageExtra(output: RetrievalOnlyOutput): Readonly<Record<string, unknown>> {
  const coverage = output.pack.diagnostics?.coverage;
  if (coverage === undefined) {
    throw new Error("fixture must exercise repository-search coverage diagnostics");
  }
  return {
    coverageStatus: coverage.incomplete ? "incomplete" : "complete",
    coverageReasons: coverage.reasons,
    coverageFilesDiscovered: coverage.filesDiscovered,
    coverageFilesScanned: coverage.filesScanned,
    coverageFilesSkipped: coverage.filesSkipped,
    coverageDepthPruned: coverage.depthPrunedByDiscovery,
    coverageMaxFilesPruned: coverage.maxFilesPrunedByDiscovery,
  };
}

function expectedExtra(
  output: RetrievalOnlyOutput,
  readBudgetBlocked: boolean,
  elapsedBudgetBlocked = false,
): Readonly<Record<string, unknown>> {
  const retrievalBlocked = readBudgetBlocked || elapsedBudgetBlocked;
  const coverage = retrievalBlocked
    ? { coverageStatus: "not-reported", coverageReasons: [] }
    : expectedCoverageExtra(output);
  return {
    activityDetailStatus: "complete",
    plannedRingCount: output.plan.rings.length,
    usageSearchCalls: output.pack.usage.searchCalls,
    usageFilesRead: output.pack.usage.filesRead,
    usageExcerptBytes: output.pack.usage.excerptBytes,
    usageModelInputTokens: output.pack.usage.modelInputTokens,
    usageModelOutputTokens: output.pack.usage.modelOutputTokens,
    usageElapsedMs: output.pack.usage.elapsedMs,
    usageRerankCalls: output.pack.usage.rerankCalls,
    selectedFileCount: output.pack.files.length,
    omittedCount: output.pack.omitted.length,
    uncertaintyCount: output.pack.uncertainty.length,
    scopeIncompleteUncertaintyCount: output.pack.uncertainty.filter(
      (marker) => marker.kind === "scope-incomplete",
    ).length,
    toolUnavailableUncertaintyCount: output.pack.uncertainty.filter(
      (marker) => marker.kind === "tool-unavailable",
    ).length,
    budgetClippedUncertaintyCount: output.pack.uncertainty.filter(
      (marker) => marker.kind === "budget-clipped",
    ).length,
    ...coverage,
    retrievalReadBudgetBlocked: readBudgetBlocked,
    retrievalElapsedBudgetBlocked: elapsedBudgetBlocked,
    retrievalWorkspaceIndexProviderStatus: "not-evaluated",
    completeness: "complete",
    loss: "none",
  };
}

function expectBodyFree(activityLog: BufferedServerLogSink): void {
  const serialized = JSON.stringify(activityLog.events);
  const persisted = activityLog.lines().join("\n");
  for (const secret of privateFixtureValues()) {
    expect(serialized).not.toContain(secret);
    expect(persisted).not.toContain(secret);
  }
}

function expectCommonExtra(
  started: ServerLogEvent,
  terminal: ServerLogEvent,
  input: OrchestratorInput,
): void {
  expect(started.extra).toMatchObject({
    scopeKind: input.scope.kind,
    relativePathCount: input.scope.relativePaths.length,
    explicitConnection: input.scope.explicitConnection === true,
    inputStatus: "valid",
    completeness: "complete",
    loss: "none",
    ...expectedRequestExtra(input),
  });
  expectSha256(started.extra?.scopeIdentitySha256);
  expectSha256(started.extra?.queryIdentitySha256);
  expect(started.extra?.queryIdentitySha256).not.toBe(started.extra?.scopeIdentitySha256);
  expect(terminal.extra).toMatchObject({
    scopeIdentitySha256: started.extra?.scopeIdentitySha256,
    queryIdentitySha256: started.extra?.queryIdentitySha256,
    completeness: "complete",
    loss: "none",
  });
}

function expectZeroStructuralWork(event: ServerLogEvent): void {
  expect(nestedExtra(event.extra, "structural")).toMatchObject({
    contextCount: 0,
    candidateInventoryBuildCount: 0,
    textSearchCount: 0,
  });
}

const WORKSPACE_INDEX_COUNTER_FIELDS = [
  "searchCount",
  "reportCount",
  "fallbackSearchCount",
  "bypassedSearchCount",
  "indexedRecords",
  "reusedRecords",
  "staleRecords",
  "loadFailures",
  "saveFailures",
] as const;

function expectWorkspaceIndexCounters(event: Readonly<Record<string, unknown>>): void {
  expectNonNegativeNumberFields(
    nestedExtra(event, "workspaceIndex"),
    WORKSPACE_INDEX_COUNTER_FIELDS,
  );
}

const WORKSPACE_IO_COUNTER_FIELDS = [
  "readDirCalls",
  "readDirEntries",
  "statCalls",
  "realPathCalls",
  "existsCalls",
  "contentReadCalls",
  "contentReadBytes",
] as const;

function expectWorkspaceIoCounters(event: Readonly<Record<string, unknown>>): void {
  const workspaceIo = nestedExtra(event, "workspaceIo");
  const fields =
    "readDirCalls" in workspaceIo
      ? WORKSPACE_IO_COUNTER_FIELDS
      : (["contentReadCalls", "contentReadBytes"] as const);
  expectNonNegativeNumberFields(workspaceIo, fields);
}

function emptyExpectedWorkspaceIoActivity(): Readonly<Record<string, number>> {
  return Object.fromEntries(WORKSPACE_IO_COUNTER_FIELDS.map((field) => [field, 0]));
}

function admissionOnlyExpectedWorkspaceIoActivity(): Readonly<Record<string, number>> {
  return { ...emptyExpectedWorkspaceIoActivity(), realPathCalls: 1 };
}

describe("retrieveConnectedContextPack activity log", () => {
  describe.each([
    ["filesReadMax", "filesReadBounded"],
    ["elapsedMsMax", "elapsedMsBounded"],
  ] as const)("request budget evidence for %s", (cap, boundedFlag) => {
    it.each([
      { label: "missing", value: undefined, valid: false, bounded: false },
      { label: "undefined", value: undefined, valid: false, bounded: false },
      { label: "NaN", value: Number.NaN, valid: false, bounded: false },
      { label: "infinite", value: Infinity, valid: false, bounded: false },
      { label: "negative", value: -1, valid: false, bounded: false },
      { label: "fractional", value: 0.5, valid: false, bounded: false },
      { label: "string", value: "100", valid: false, bounded: false },
      { label: "unbounded", value: null, valid: true, bounded: false },
      { label: "zero", value: 0, valid: true, bounded: true },
      { label: "finite", value: 100, valid: true, bounded: true },
    ])("records the exact $label cap state", async (entry) => {
      const budget: Record<string, unknown> = { ...DEFAULT_EXPLORATION_BUDGET, [cap]: entry.value };
      if (entry.label === "missing") Reflect.deleteProperty(budget, cap);
      const started = await budgetStartedEvent(budget);
      expect(started.extra).toMatchObject({
        inputStatus: entry.valid ? "valid" : "invalid",
        [boundedFlag]: entry.bounded,
      });
      if (entry.bounded) expect(started.extra?.[cap]).toBe(entry.value);
      else expect(started.extra).not.toHaveProperty(cap);
      const registration = activityLogEventRegistration(started);
      expect(registration?.fields.filesReadBounded?.required).toBe(true);
      expect(registration?.fields.elapsedMsBounded?.required).toBe(true);
    });
  });

  it.each([undefined, null, 0, 100])("persists request budget state for %s", async (value) => {
    const event = await budgetStartedEvent({
      ...DEFAULT_EXPLORATION_BUDGET,
      filesReadMax: value,
      elapsedMsMax: value,
    });
    const line = expectActivityLogProof(
      "search.connected-context.started.line",
      formatActivityLogProofLine(event),
    );
    expect(line).toMatchObject({ correlationId: CORRELATION_ID, ...event.extra });
  });

  it("records unavailable directory streaming before any legacy array enumeration", async () => {
    const activityLog = createBufferedServerLogSink();
    const fs = { ...memFs(FIXTURE_ROOT, { "fact.txt": "PrivateCustomerHandler" }) };
    delete fs.iterateDirectory;
    const readDir = vi.spyOn(fs, "readDir");
    const base = fixtureInput();
    const input: OrchestratorInput = {
      ...base,
      scope: { ...base.scope, kind: "workspace-root", relativePaths: [], explicitConnection: true },
      query: { ...base.query, text: "Where is PrivateCustomerHandler defined?" },
    };
    await expect(
      retrieveConnectedContextPack(input, { ...fixtureDeps(activityLog, CORRELATION_ID), fs }),
    ).rejects.toBeInstanceOf(WorkspaceReadError);
    expect(readDir).not.toHaveBeenCalled();
    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(failed).toMatchObject({
      correlationId: CORRELATION_ID,
      extra: {
        failureKind: "WORKSPACE_READ_FAILED",
        retrievalPhase: "ring-retrieval",
        workspaceIoReadDirCalls: 0,
        workspaceIoContentReadCalls: 0,
      },
    });
    expectBodyFree(activityLog);
    expectActivityLogProof(
      "search.connected-context.failed.line",
      formatActivityLogProofLine(failed),
    );
  });

  it("preserves correlated complete scan evidence after literal content prefiltering", async () => {
    const activityLog = createBufferedServerLogSink();
    const target = "PRIVATE_LITERAL_TARGET";
    const input: OrchestratorInput = {
      ...fixtureInput(),
      scope: {
        ...fixtureScope(),
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
      },
      query: { ...fixtureQuery(), text: `Search for "${target}"` },
    };
    const output = await retrieveConnectedContextPack(input, {
      ...fixtureDeps(activityLog, CORRELATION_ID),
      fs: memFs(FIXTURE_ROOT, {
        [PRIVATE_SCOPE_FILE]: `export const value = "${target}";\n`,
        [`${PRIVATE_SCOPE_PATH}/unmatched.ts`]: "export const unrelated = true;\n".repeat(200),
      }),
    });
    expect(output.pack.files.map((file) => file.scopePath)).toEqual([PRIVATE_SCOPE_FILE]);
    expect(output.pack.diagnostics?.coverage).toMatchObject({ incomplete: false, reasons: [] });
    expect(output.pack.diagnostics?.coverage?.filesScanned).toBeGreaterThanOrEqual(2);
    const [started, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
    expectCommonExtra(started, completed, input);
    expect(completed.correlationId).toBe(CORRELATION_ID);
    expect(completed.extra).toMatchObject(expectedCoverageExtra(output));
    expectBodyFree(activityLog);
    expect(JSON.stringify(activityLog.events)).not.toContain(target);
    expectActivityLogProof(
      "search.connected-context.completed.line",
      formatActivityLogProofLine(completed),
    );
  });

  it("logs actual selected excerpt observations without hypothetical source eviction", async () => {
    const activityLog = createBufferedServerLogSink();
    const profile = deriveContextProfile({
      maxInputTokens: 8,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const output = await retrieveConnectedContextPack(fixtureInput(), {
      ...fixtureDeps(activityLog, CORRELATION_ID),
      contextProfile: profile,
    });
    const observed = deriveGroundedContextAssembly(output.pack, profile);
    const completed = activityLog.events.find(
      (event) => event.op === "search.connected-context.completed",
    );
    expect(completed?.extra).toMatchObject({
      contextSelectedExcerptCount: output.pack.files.flatMap((file) => file.excerpts).length,
      contextSelectedExcerptEstimatedTokens: observed.totalEstimatedTokens,
      contextBudgetPressure: "exceeded",
      contextRecencyLayoutApplied: false,
    });
    expect(JSON.stringify(completed)).not.toContain(FIXTURE_ROOT);
    expect(JSON.stringify(completed)).not.toContain(FIXTURE_QUERY_TEXT);
  });

  it("persists the real producer lifecycle as body-free server-log lines", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-context-log-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const input = fixtureInput();
    try {
      const output = await retrieveConnectedContextPack(
        input,
        fixtureDeps(activityLog, CORRELATION_ID),
      );
      activityLog.close?.();

      const raw = readPersistedActivityLog(stateDir);
      const persisted = producerLogLines(raw);
      expect(persisted).toHaveLength(4);
      const [started, details, sourceDetails, completed] = persisted;
      if (started === undefined || details === undefined || completed === undefined) {
        throw new Error("expected persisted connected-context lifecycle lines");
      }
      expect(started).toMatchObject({
        category: "search",
        op: "search.connected-context.started",
        correlationId: CORRELATION_ID,
        scopeKind: input.scope.kind,
        relativePathCount: input.scope.relativePaths.length,
        ...expectedRequestExtra(input),
      });
      expect(completed).toMatchObject({
        category: "search",
        op: "search.connected-context.completed",
        correlationId: CORRELATION_ID,
        scopeIdentitySha256: started.scopeIdentitySha256,
        queryIdentitySha256: started.queryIdentitySha256,
        ...expectedCoverageExtra(output),
        selectedFileCount: output.pack.files.length,
        omittedCount: output.pack.omitted.length,
        retrievalIntent: output.plan.retrievalIntent,
        retrievalTargetDecision: output.plan.targetDecision?.kind,
        retrievalTargetCount: output.plan.targetDecision?.targets.length,
        retrievalAnchorCount: output.plan.anchors.length,
        retrievalReadBudgetBlocked: false,
        retrievalElapsedBudgetBlocked: false,
        retrievalWorkspaceIndexProviderStatus: "not-evaluated",
      });
      expect(details).toMatchObject({
        category: "search",
        op: "search.connected-context.completion-details",
        correlationId: CORRELATION_ID,
        scopeIdentitySha256: started.scopeIdentitySha256,
        queryIdentitySha256: started.queryIdentitySha256,
        activityDetailStatus: "complete",
        completeness: "complete",
        loss: "none",
      });
      expect(sourceDetails).toMatchObject({
        op: "search.connected-context.source-details",
        correlationId: CORRELATION_ID,
        scopeIdentitySha256: started.scopeIdentitySha256,
        queryIdentitySha256: started.queryIdentitySha256,
        activityDetailStatus: "complete",
        completeness: "complete",
        loss: "none",
      });
      expectSha256(started.scopeIdentitySha256);
      expectSha256(started.queryIdentitySha256);
      expectNonNegativeNumberFields(completed, ["durationMs"]);
      expectNonNegativeNumberFields(nestedExtra(details, "structural"), [
        "contextCount",
        "candidateInventoryBuildCount",
        "textSearchCount",
      ]);
      expectNonNegativeNumberFields(nestedExtra(completed, "usage"), [
        "searchCalls",
        "filesRead",
        "excerptBytes",
        "modelInputTokens",
        "modelOutputTokens",
        "elapsedMs",
        "rerankCalls",
      ]);
      expectNonNegativeNumberFields(nestedExtra(completed, "coverage"), [
        "coverageFilesDiscovered",
        "coverageFilesScanned",
        "coverageFilesSkipped",
        "coverageDepthPruned",
        "coverageMaxFilesPruned",
      ]);
      expectWorkspaceIndexCounters(details);
      expectWorkspaceIoCounters(details);
      const workspaceIndex = nestedExtra(details, "workspaceIndex");
      expect(workspaceIndex).toMatchObject({
        providerStatus: "not-evaluated",
        loadStatus: "not-attempted",
        saveStatus: "not-attempted",
      });
      expect(workspaceIndex.searchMode).toBe("live-scan");
      expect(workspaceIndex.reportCount).toBe(0);
      expect(workspaceIndex.fallbackSearchCount).toBe(0);
      expect(workspaceIndex.bypassedSearchCount).toBeGreaterThan(0);
      expect(typeof nestedExtra(completed, "uncertainty").scopeIncompleteUncertaintyCount).toBe(
        "number",
      );
      expect(nestedExtra(completed, "selectionCounts")).toEqual({
        selectedFileCount: output.pack.files.length,
        omittedCount: output.pack.omitted.length,
      });
      expect(nestedExtra(completed, "retrievalStatus")).toEqual({
        readBudgetBlocked: false,
        elapsedBudgetBlocked: false,
        workspaceIndexProviderStatus: "not-evaluated",
      });
      expect(completed).not.toHaveProperty("_truncatedFieldCount");
      expect(details).not.toHaveProperty("_truncatedFieldCount");
      for (const secret of privateFixtureValues()) expect(raw).not.toContain(secret);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["absent", "ready", "failing"] as const)(
    "reports intentional uncapped index bypass with a %s provider",
    async (provider) => {
      const activityLog = createBufferedServerLogSink();
      const loadSnapshot = vi.fn(() =>
        provider === "failing"
          ? Promise.reject(new TypeError("private index read failure"))
          : Promise.resolve(undefined),
      );
      const saveSnapshot = vi.fn(() => Promise.resolve());
      await retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        workspaceIndexForRoot: () =>
          provider === "absent" ? undefined : { loadSnapshot, saveSnapshot },
      });
      expect(loadSnapshot).not.toHaveBeenCalled();
      expect(saveSnapshot).not.toHaveBeenCalled();
      const [, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
      const index = nestedExtra(completionDetailsEvent(activityLog).extra, "workspaceIndex");
      expect(index).toMatchObject({
        providerStatus: "not-evaluated",
        searchMode: "live-scan",
        reportCount: 0,
        fallbackSearchCount: 0,
        loadFailures: 0,
        saveFailures: 0,
      });
      expect(index.bypassedSearchCount).toBeGreaterThan(0);
      expect(index.bypassedSearchCount).toBe(index.searchCount);
      expect(nestedExtra(completed.extra, "retrievalStatus")).toMatchObject({
        workspaceIndexProviderStatus: index.providerStatus,
      });
      const registration = activityLogEventRegistration(completionDetailsEvent(activityLog));
      expect(registration).toBeDefined();
      expect(Object.keys(registration?.fields ?? {})).toHaveLength(44);
      expect(Object.keys(registration?.fields ?? {}).length).toBeLessThanOrEqual(
        MAX_LOG_FIELD_COUNT,
      );
      expectBodyFree(activityLog);
    },
  );

  it("persists uncapped live scans and fresh reads with an injected index", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-context-index-log-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const workspaceIndex = createWorkspaceIndex();
    const files: Record<string, string> = {
      [PRIVATE_SCOPE_FILE]: "export function PrivateCustomerHandler(): string { return 'ok'; }\n",
    };
    const fs = memFs(FIXTURE_ROOT, files);
    try {
      await retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, `${CORRELATION_ID}-cold`),
        fs,
        workspaceIndexForRoot: () => workspaceIndex,
      });
      await retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, `${CORRELATION_ID}-warm`),
        fs,
        workspaceIndexForRoot: () => workspaceIndex,
      });
      files[PRIVATE_SCOPE_FILE] =
        "export function PrivateCustomerHandler(): string { return 'changed'; }\n";
      await retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, `${CORRELATION_ID}-stale`),
        fs,
        workspaceIndexForRoot: () => workspaceIndex,
      });
      activityLog.close?.();

      const raw = readPersistedActivityLog(stateDir);
      const completedDetails = parsePersistedLogLines(raw).filter(
        (entry) => entry.op === "search.connected-context.completion-details",
      );
      expect(completedDetails).toHaveLength(3);
      const [cold, warm, stale] = completedDetails;
      if (cold === undefined || warm === undefined || stale === undefined) {
        throw new Error("expected cold, warm, and stale connected-context completion lines");
      }
      expect(cold.correlationId).toBe(`${CORRELATION_ID}-cold`);
      expect(warm.correlationId).toBe(`${CORRELATION_ID}-warm`);
      expectWorkspaceIndexCounters(cold);
      expectWorkspaceIndexCounters(warm);
      for (const line of [cold, warm, stale]) {
        expectWorkspaceIndexCounters(line);
        expect(nestedExtra(line, "workspaceIndex")).toMatchObject({
          providerStatus: "not-evaluated",
          searchMode: "live-scan",
          loadStatus: "not-attempted",
          saveStatus: "not-attempted",
          indexedRecords: 0,
          reusedRecords: 0,
          staleRecords: 0,
          loadFailures: 0,
          saveFailures: 0,
          fallbackSearchCount: 0,
        });
        expect(nestedExtra(line, "workspaceIndex").bypassedSearchCount).toBeGreaterThan(0);
        expect(line).not.toHaveProperty("_truncatedFieldCount");
        expect(nestedExtra(line, "workspaceIo").contentReadCalls).toBeGreaterThan(0);
      }
      for (const secret of privateFixtureValues()) expect(raw).not.toContain(secret);
      const completedLine = raw
        .split("\n")
        .find((line) => line.includes('"op":"search.connected-context.completion-details"'));
      if (completedLine === undefined) throw new Error("Missing persisted index diagnostics");
      expectActivityLogProof("search.connected-context.completion-details.line", completedLine);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps uncapped source coverage independent of an unavailable index store", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-context-index-failure-log-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const workspaceIndex: WorkspaceIndex = {
      loadSnapshot: (): Promise<never> =>
        Promise.reject(new Error(`private index load failure: ${FIXTURE_ROOT}`)),
      saveSnapshot: (): Promise<never> =>
        Promise.reject(new Error(`private index save failure: ${PRIVATE_SCOPE_FILE}`)),
    };
    try {
      const output = await retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        workspaceIndexForRoot: () => workspaceIndex,
      });
      expect(output.pack.files.length).toBeGreaterThan(0);
      activityLog.close?.();

      const raw = readPersistedActivityLog(stateDir);
      const completedDetails = parsePersistedLogLines(raw).find(
        (entry) => entry.op === "search.connected-context.completion-details",
      );
      if (completedDetails === undefined) {
        throw new Error("expected connected-context completion details");
      }
      expectWorkspaceIndexCounters(completedDetails);
      expect(nestedExtra(completedDetails, "workspaceIndex")).toMatchObject({
        providerStatus: "not-evaluated",
        searchMode: "live-scan",
        loadStatus: "not-attempted",
        saveStatus: "not-attempted",
        loadFailures: 0,
        saveFailures: 0,
      });
      for (const secret of privateFixtureValues()) expect(raw).not.toContain(secret);
      expect(raw).not.toContain("private index");
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists anchored frames and a body-free cause chain from the real failure producer", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-context-failure-log-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const input = fixtureInput();
    const failure = new TypeError(`private workspace unavailable: ${FIXTURE_ROOT}`, {
      cause: new RangeError("private nested failure"),
    });
    try {
      await expect(
        retrieveConnectedContextPack(input, {
          ...fixtureDeps(activityLog, CORRELATION_ID),
          detectWorkspace: (): never => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      activityLog.close?.();

      const raw = readPersistedActivityLog(stateDir);
      const persisted = producerLogLines(raw);
      expect(persisted).toHaveLength(2);
      expect(persisted[1]).toMatchObject({
        op: "search.connected-context.failed",
        correlationId: CORRELATION_ID,
        errorKind: "internal",
        causeChain: ["RangeError"],
        outcome: "failed",
        retrievalPhase: "workspace-detection",
      });
      expectAnchoredFrames(persisted[1]?.frames);
      expect(nestedExtra(persisted[1], "workspaceIndex")).toMatchObject({
        providerStatus: "not-evaluated",
        searchMode: "not-evaluated",
      });
      expectWorkspaceIndexCounters(persisted[1] ?? {});
      expectWorkspaceIoCounters(persisted[1] ?? {});
      for (const secret of privateFixtureValues()) expect(raw).not.toContain(secret);
      expect(raw).not.toContain("private nested failure");
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("emits a body-free start/completion lifecycle with request-work diagnostics", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const output = await retrieveConnectedContextPack(
      input,
      fixtureDeps(activityLog, CORRELATION_ID),
    );

    const [started, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
    const details = completionDetailsEvent(activityLog);
    expect(completed).toMatchObject({
      category: "search",
      op: "search.connected-context.completed",
      correlationId: CORRELATION_ID,
    });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.extra).toMatchObject({
      ...expectedExtra(output, false),
    });
    expectNonNegativeNumberFields(nestedExtra(details.extra, "structural"), [
      "contextCount",
      "candidateInventoryBuildCount",
      "textSearchCount",
    ]);
    expectNonNegativeNumberFields(nestedExtra(completed.extra, "usage"), [
      "searchCalls",
      "filesRead",
      "excerptBytes",
      "modelInputTokens",
      "modelOutputTokens",
      "elapsedMs",
      "rerankCalls",
    ]);
    expectNonNegativeNumberFields(nestedExtra(completed.extra, "coverage"), [
      "coverageFilesDiscovered",
      "coverageFilesScanned",
      "coverageFilesSkipped",
      "coverageDepthPruned",
      "coverageMaxFilesPruned",
    ]);
    expectNonNegativeNumberFields(nestedExtra(completed.extra, "uncertainty"), [
      "count",
      "scopeIncompleteUncertaintyCount",
      "budgetClippedUncertaintyCount",
      "toolUnavailableUncertaintyCount",
      "unsupportedClaimUncertaintyCount",
      "entailmentUnavailableUncertaintyCount",
    ]);
    expectWorkspaceIndexCounters(details.extra ?? {});
    expectWorkspaceIoCounters(details.extra ?? {});
    expect(details).toMatchObject({
      category: "search",
      op: "search.connected-context.completion-details",
      correlationId: completed.correlationId,
      extra: {
        scopeIdentitySha256: started.extra?.scopeIdentitySha256,
        queryIdentitySha256: started.extra?.queryIdentitySha256,
        activityDetailStatus: "complete",
        completeness: "complete",
        loss: "none",
      },
    });
    expectCommonExtra(started, completed, input);
    expectBodyFree(activityLog);
  });

  it("binds explicit-connection semantics into the body-free scope identity", async () => {
    const implicitLog = createBufferedServerLogSink();
    const explicitLog = createBufferedServerLogSink();
    const implicitInput = fixtureInput(true);
    const explicitInput: OrchestratorInput = {
      ...implicitInput,
      scope: { ...implicitInput.scope, explicitConnection: true },
    };

    await retrieveConnectedContextPack(
      implicitInput,
      fixtureDeps(implicitLog, `${CORRELATION_ID}-implicit`),
    );
    await retrieveConnectedContextPack(
      explicitInput,
      fixtureDeps(explicitLog, `${CORRELATION_ID}-explicit`),
    );

    const [implicitStarted] = lifecycleEvents(implicitLog, "search.connected-context.completed");
    const [explicitStarted] = lifecycleEvents(explicitLog, "search.connected-context.completed");
    expect(implicitStarted.extra?.explicitConnection).toBe(false);
    expect(explicitStarted.extra?.explicitConnection).toBe(true);
    expect(explicitStarted.extra?.scopeIdentitySha256).not.toBe(
      implicitStarted.extra?.scopeIdentitySha256,
    );
    expectBodyFree(implicitLog);
    expectBodyFree(explicitLog);
  });

  it("narrows the request-scoped filesystem port to read-only retrieval capabilities", async () => {
    const activityLog = createBufferedServerLogSink();
    const deps = fixtureDeps(activityLog, CORRELATION_ID);
    const sourceFs = deps.fs;
    if (sourceFs === undefined) throw new Error("fixture filesystem is required");
    const makeDir = vi.fn();
    const writeFileUtf8 = vi.fn();
    const writeCapableFs = { ...sourceFs, makeDir, writeFileUtf8 };

    await retrieveConnectedContextPack(fixtureInput(), {
      ...deps,
      fs: writeCapableFs,
      detectWorkspace: (_root, requestFs): WorkspaceInfo => {
        expect("makeDir" in requestFs).toBe(false);
        expect("writeFileUtf8" in requestFs).toBe(false);
        return fixtureWorkspace();
      },
    });

    expect(makeDir).not.toHaveBeenCalled();
    expect(writeFileUtf8).not.toHaveBeenCalled();
    expectBodyFree(activityLog);
  });

  it("ignores a throwing unused optional filesystem projection", async () => {
    const activityLog = createBufferedServerLogSink();
    const deps = fixtureDeps(activityLog, CORRELATION_ID);
    const sourceFs = deps.fs;
    if (sourceFs === undefined) throw new Error("fixture filesystem is required");
    const hostileFs = new Proxy(sourceFs, {
      get: (target, property, receiver): unknown => {
        if (property === "readFileRange") throw new Error("private optional projection");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const output = await retrieveConnectedContextPack(fixtureInput(), { ...deps, fs: hostileFs });

    expect(output.pack.files.length).toBeGreaterThan(0);
    lifecycleEvents(activityLog, "search.connected-context.completed");
    expectBodyFree(activityLog);
    expect(activityLog.lines().join("\n")).not.toContain("private optional projection");
  });

  it("emits a completion with zero structural work for a blocked read budget", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput(true);
    const output = await retrieveConnectedContextPack(input, fixtureDeps(activityLog, undefined));

    const [started, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
    const details = completionDetailsEvent(activityLog);
    expect(completed).toMatchObject({
      category: "search",
      op: "search.connected-context.completed",
      correlationId: UNKNOWN_CORRELATION_ID,
    });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.extra).toMatchObject({
      ...expectedExtra(output, true),
    });
    expect(details.extra).toMatchObject({
      structuralContextCount: 0,
      structuralCandidateInventoryBuildCount: 0,
      indexProviderStatus: "not-evaluated",
      indexSearchMode: "not-evaluated",
      indexLoadStatus: "not-attempted",
      indexSaveStatus: "not-attempted",
    });
    expectWorkspaceIndexCounters(details.extra ?? {});
    expectWorkspaceIoCounters(details.extra ?? {});
    expect(nestedExtra(details.extra, "workspaceIo")).toEqual(
      admissionOnlyExpectedWorkspaceIoActivity(),
    );
    expectCommonExtra(started, completed, input);
    expectBodyFree(activityLog);
  });

  it("distinguishes elapsed preflight exhaustion from a blocked read budget", async () => {
    const activityLog = createBufferedServerLogSink();
    const input: OrchestratorInput = {
      ...fixtureInput(),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 0 },
    };
    const output = await retrieveConnectedContextPack(
      input,
      fixtureDeps(activityLog, CORRELATION_ID),
    );

    const [started, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
    const details = completionDetailsEvent(activityLog);
    expect(completed.extra).toMatchObject({ ...expectedExtra(output, false, true) });
    expect(nestedExtra(completed.extra, "retrievalStatus")).toEqual({
      readBudgetBlocked: false,
      elapsedBudgetBlocked: true,
      workspaceIndexProviderStatus: "not-evaluated",
    });
    expect(nestedExtra(details.extra, "workspaceIo")).toEqual(
      admissionOnlyExpectedWorkspaceIoActivity(),
    );
    expectCommonExtra(started, completed, input);
    expectBodyFree(activityLog);
  });

  it("does not report a live fallback when the request stops before repository scanning", async () => {
    const activityLog = createBufferedServerLogSink();
    const elapsedMsMax = 10;
    let planRecorded = false;
    let callsAfterPlan = 0;
    const nowMs = (): number => {
      if (!planRecorded) return FIXTURE_NOW_MS;
      callsAfterPlan += 1;
      return callsAfterPlan <= 4 ? FIXTURE_NOW_MS : FIXTURE_NOW_MS + elapsedMsMax;
    };

    await retrieveConnectedContextPack(
      {
        ...fixtureInput(),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax },
      },
      {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        nowMs,
        recordPlan: (): void => {
          planRecorded = true;
        },
      },
    );

    lifecycleEvents(activityLog, "search.connected-context.completed");
    const details = completionDetailsEvent(activityLog);
    const workspaceIndex = nestedExtra(details.extra, "workspaceIndex");
    expect(workspaceIndex).toMatchObject({
      providerStatus: "not-evaluated",
      searchMode: "unused",
      reportCount: 0,
      fallbackSearchCount: 0,
    });
    expect(workspaceIndex.searchCount).toBe(0);
    expect(nestedExtra(details.extra, "workspaceIo")).toMatchObject({
      readDirCalls: 0,
      contentReadCalls: 0,
      contentReadBytes: 0,
    });
    expectBodyFree(activityLog);
  });

  it("emits one structured failed terminal event and rethrows the original error", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const failure = new TypeError(`private workspace unavailable: ${FIXTURE_ROOT}`, {
      cause: new RangeError("private nested failure"),
    });
    const deps = {
      ...fixtureDeps(activityLog, CORRELATION_ID),
      detectWorkspace: (): never => {
        throw failure;
      },
    };

    await expect(retrieveConnectedContextPack(input, deps)).rejects.toBe(failure);

    const [started, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(failed).toMatchObject({
      level: "error",
      category: "search",
      correlationId: CORRELATION_ID,
      errorKind: "internal",
      extra: {
        outcome: "failed",
        retrievalPhase: "workspace-detection",
      },
    });
    expectNonNegativeNumberFields(failed.extra, ["plannedRingCount"]);
    expect(failed.extra?.causeChain).toEqual(["RangeError"]);
    expectAnchoredFrames(failed.extra?.frames);
    expectZeroStructuralWork(failed);
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual(
      admissionOnlyExpectedWorkspaceIoActivity(),
    );
    expect(failed.durationMs).toBeGreaterThanOrEqual(0);
    expectCommonExtra(started, failed, input);
    expectBodyFree(activityLog);
  });

  it("counts an injected canonical-root operation once and retains it on failure", async () => {
    const activityLog = createBufferedServerLogSink();
    const deps = fixtureDeps(activityLog, CORRELATION_ID);
    const sourceFs = deps.fs;
    if (sourceFs === undefined) throw new Error("fixture filesystem is required");
    const canonicalWorkspaceRoot = vi.fn((root: string): string => root);
    const failure = new Error("private failure after canonicalization");

    await expect(
      retrieveConnectedContextPack(fixtureInput(), {
        ...deps,
        fs: { ...sourceFs, canonicalWorkspaceRoot },
        detectWorkspace: (root, requestFs): never => {
          requestFs.canonicalWorkspaceRoot?.(root);
          requestFs.canonicalWorkspaceRoot?.(root);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(canonicalWorkspaceRoot).toHaveBeenCalledTimes(1);
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
      realPathCalls: 1,
    });
    expectBodyFree(activityLog);
    expect(activityLog.lines().join("\n")).not.toContain("private failure");
  });

  it("counts exact descriptor bytes without re-encoding its UTF-8 projection", async () => {
    const activityLog = createBufferedServerLogSink();
    const deps = fixtureDeps(activityLog, CORRELATION_ID);
    const sourceFs = deps.fs;
    if (sourceFs === undefined) throw new Error("fixture filesystem is required");
    const failure = new Error("stop after descriptor observation");

    await expect(
      retrieveConnectedContextPack(fixtureInput(), {
        ...deps,
        fs: {
          ...sourceFs,
          readFileUtf8SameDescriptor: () => ({
            rawText: "\uFFFD",
            sizeBytes: 1,
            stat: {
              size: 1,
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
            },
          }),
        },
        detectWorkspace: (_root, requestFs): never => {
          requestFs.readFileUtf8SameDescriptor?.("unused", 1, "reject", UNUSED_EXPECTED_STAT);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
      realPathCalls: 1,
      contentReadCalls: 1,
      contentReadBytes: 1,
    });
    expectBodyFree(activityLog);
  });

  it("rejects hostile numeric projections instead of serializing them as I/O counters", async () => {
    const activityLog = createBufferedServerLogSink();
    const deps = fixtureDeps(activityLog, CORRELATION_ID);
    const sourceFs = deps.fs;
    if (sourceFs === undefined) throw new Error("fixture filesystem is required");
    const privateProjection = "private-workspace-byte-count";
    const descriptor = {
      rawText: "x",
      sizeBytes: 1,
      stat: {
        size: 1,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
    };
    let sizeReads = 0;
    Object.defineProperty(descriptor, "sizeBytes", {
      get: (): unknown => {
        sizeReads += 1;
        return sizeReads === 1 ? 1 : privateProjection;
      },
    });
    const hostileEntries = new Proxy([], {
      get: (target, property, receiver): unknown =>
        property === "length" ? privateProjection : Reflect.get(target, property, receiver),
    });
    const failure = new Error("stop after hostile numeric observation");

    await expect(
      retrieveConnectedContextPack(fixtureInput(), {
        ...deps,
        fs: {
          ...sourceFs,
          readDir: () => hostileEntries,
          readFileUtf8SameDescriptor: () => descriptor,
        },
        detectWorkspace: (_root, requestFs): never => {
          requestFs.readDir("unused");
          requestFs.readFileUtf8SameDescriptor?.("unused", 1, "reject", UNUSED_EXPECTED_STAT);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(sizeReads).toBe(1);
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
      realPathCalls: 1,
      readDirCalls: 1,
      contentReadCalls: 1,
      contentReadBytes: 1,
    });
    expect(activityLog.lines().join("\n")).not.toContain(privateProjection);
  });

  it("counts opening a content reader even before its first range read", async () => {
    const activityLog = createBufferedServerLogSink();
    const deps = fixtureDeps(activityLog, CORRELATION_ID);
    const sourceFs = deps.fs;
    if (sourceFs === undefined) throw new Error("fixture filesystem is required");
    const failure = new Error("stop after reader observation");

    await expect(
      retrieveConnectedContextPack(fixtureInput(), {
        ...deps,
        fs: {
          ...sourceFs,
          openFileReader: (): Promise<{
            readonly close: () => Promise<void>;
            readonly readRange: () => Promise<Uint8Array>;
          }> =>
            Promise.resolve({
              close: (): Promise<void> => Promise.resolve(),
              readRange: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
            }),
        },
        detectWorkspace: (_root, requestFs): never => {
          void requestFs.openFileReader?.("unused", "reject", UNUSED_EXPECTED_STAT);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
      realPathCalls: 1,
      contentReadCalls: 1,
    });
    expectBodyFree(activityLog);
  });

  it("emits one warning terminal event when already cancelled", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const abort = new AbortController();
    abort.abort();

    await expect(
      retrieveConnectedContextPack(input, {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "CancelledError" });

    const [started, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(failed).toMatchObject({
      level: "warn",
      errorKind: "cancelled",
      extra: {
        outcome: "cancelled",
        retrievalPhase: "request-validation",
        plannedRingCount: 0,
      },
    });
    expectZeroStructuralWork(failed);
    expectCommonExtra(started, failed, input);
    expectBodyFree(activityLog);
  });

  it("reports partial structural work when pack assembly fails", async () => {
    const activityLog = createBufferedServerLogSink();
    const input = fixtureInput();
    const failure = new TypeError("reranker failed after retrieval");
    const reranker: RerankerSeam = {
      name: "failing-log-fixture-reranker",
      isAvailable: (): Promise<{ readonly available: true; readonly modelLabel: string }> =>
        Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: (): Promise<never> => Promise.reject(failure),
    };

    await expect(
      retrieveConnectedContextPack(input, {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        contextPackReranker: reranker,
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(failed.extra).toMatchObject({
      outcome: "failed",
      retrievalPhase: "pack-assembly",
    });
    const structural = nestedExtra(failed.extra, "structural");
    expectNonNegativeNumberFields(structural, [
      "contextCount",
      "candidateInventoryBuildCount",
      "codeIndexBuildCount",
    ]);
    expect(structural.contextCount).toBeGreaterThan(0);
    expect(structural.candidateInventoryBuildCount).toBeGreaterThan(0);
    expectWorkspaceIndexCounters(failed.extra ?? {});
    expectWorkspaceIoCounters(failed.extra ?? {});
    expect(nestedExtra(failed.extra, "workspaceIndex").searchCount).toBeGreaterThan(0);
    expect(nestedExtra(failed.extra, "workspaceIndex")).toMatchObject({
      providerStatus: "not-evaluated",
      searchMode: "live-scan",
      fallbackSearchCount: 0,
    });
    expect(nestedExtra(failed.extra, "workspaceIndex").bypassedSearchCount).toBeGreaterThan(0);
    const registration = activityLogEventRegistration(failed);
    expect(Object.keys(registration?.fields ?? {})).toHaveLength(44);
    expect(Object.keys(registration?.fields ?? {}).length).toBeLessThanOrEqual(MAX_LOG_FIELD_COUNT);
    expectActivityLogProof(
      "search.connected-context.failed.line",
      formatActivityLogProofLine(failed),
    );
    expectBodyFree(activityLog);
  });

  it("keeps a cached retrieval successful when completion diagnostics are hostile", async () => {
    resetServerLogFailureNotices();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const activityLog = createBufferedServerLogSink();
    const projectionFailure = new TypeError("hostile cached-pack activity projection");
    const hostilePack = new Proxy({} as ConnectedContextPack, {
      get: (target, property, receiver): unknown => {
        if (property === "usage") throw projectionFailure;
        return Reflect.get(target, property, receiver);
      },
    });
    let cacheReads = 0;
    const microIndex: MicroIndex = {
      get: (): ConnectedContextPack => {
        cacheReads += 1;
        return hostilePack;
      },
      set: (): void => undefined,
      delete: (): void => undefined,
      clear: (): void => undefined,
      size: (): number => 1,
    };

    try {
      const output = await retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        microIndex,
      });

      expect(cacheReads).toBeGreaterThan(0);
      expect(output.pack).toBe(hostilePack);
      const [, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
      expect(completed.extra).toMatchObject({ activityDetailStatus: "unavailable" });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain(projectionFailure.message);
    } finally {
      resetServerLogFailureNotices();
      stderr.mockRestore();
    }
  });

  it("classifies a proxied cancellation without replacing the original failure", async () => {
    const activityLog = createBufferedServerLogSink();
    const cancellation = new CancelledError("private proxied cancellation");
    const hostileCancellation = new Proxy(cancellation, {
      getPrototypeOf: (): never => {
        throw new TypeError("hostile cancellation prototype");
      },
    });

    await expect(
      retrieveConnectedContextPack(fixtureInput(), {
        ...fixtureDeps(activityLog, CORRELATION_ID),
        detectWorkspace: (): never => {
          throw hostileCancellation;
        },
      }),
    ).rejects.toBe(hostileCancellation);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(failed).toMatchObject({
      level: "warn",
      errorKind: "cancelled",
      extra: {
        activityDetailStatus: "complete",
        outcome: "cancelled",
        retrievalPhase: "workspace-detection",
      },
    });
    expectBodyFree(activityLog);
  });

  it("does not let a throwing activity sink change retrieval semantics", async () => {
    resetServerLogFailureNotices();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const input = fixtureInput();
    try {
      const fallbackBuffer = createBufferedServerLogSink();
      const output = await retrieveConnectedContextPack(input, {
        ...fixtureDeps(fallbackBuffer, CORRELATION_ID),
        activityLog: {
          write: (): never => {
            throw new Error("activity sink unavailable");
          },
        },
      });

      expect(output.pack.files.length).toBeGreaterThan(0);
      expect(stderr).toHaveBeenCalled();
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain("activity sink unavailable");
    } finally {
      resetServerLogFailureNotices();
      stderr.mockRestore();
    }
  });

  it("reports activity setup failures independently without changing retrieval semantics", async () => {
    resetServerLogFailureNotices();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const input = fixtureInput();
    const deps = fixtureDeps(createBufferedServerLogSink(), CORRELATION_ID);
    Object.defineProperty(deps, "activityLog", {
      configurable: true,
      get: (): never => {
        throw new TypeError(`private activity setup failure: ${FIXTURE_ROOT}`);
      },
    });

    try {
      const output = await retrieveConnectedContextPack(input, deps);
      expect(output.pack.files.length).toBeGreaterThan(0);
      expect(stderr).toHaveBeenCalledTimes(1);
      const notice = JSON.parse(String(stderr.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(notice).toMatchObject({
        category: "diagnostic",
        op: "server-log.write-failed",
        failedOp: "search.connected-context.started",
        correlationId: CORRELATION_ID,
        errorKind: "internal",
      });
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain(FIXTURE_ROOT);
    } finally {
      resetServerLogFailureNotices();
      stderr.mockRestore();
    }
  });

  it("keeps logical elapsed time identical when activity setup fails on an advancing clock", async () => {
    resetServerLogFailureNotices();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const input = fixtureInput();
    const baselineDeps = {
      ...fixtureDeps(createBufferedServerLogSink(), CORRELATION_ID),
      nowMs: advancingClock(),
    };
    const failingDeps = {
      ...fixtureDeps(createBufferedServerLogSink(), CORRELATION_ID),
      nowMs: advancingClock(),
    };
    Object.defineProperty(failingDeps, "activityLog", {
      configurable: true,
      get: (): never => {
        throw new TypeError("activity setup failure");
      },
    });

    try {
      const baseline = await retrieveConnectedContextPack(input, baselineDeps);
      const fallback = await retrieveConnectedContextPack(input, failingDeps);
      expect(fallback.elapsedMs).toBe(baseline.elapsedMs);
      expect(fallback.elapsedMs).toBeGreaterThan(0);
    } finally {
      resetServerLogFailureNotices();
      stderr.mockRestore();
    }
  });

  it("logs malformed scope input without dereferencing unvalidated fields", async () => {
    const activityLog = createBufferedServerLogSink();
    const realPath = vi.fn((): never => {
      throw new TypeError("Invalid scope must not reach filesystem resolution");
    });
    const detectWorkspace = vi.fn(fixtureWorkspace);
    const malformed = {
      ...fixtureInput(),
      scope: { ...fixtureScope(), relativePaths: undefined },
    } as unknown as OrchestratorInput;

    const retrieval = retrieveConnectedContextPack(malformed, {
      ...fixtureDeps(activityLog, CORRELATION_ID),
      fs: { ...memFs(FIXTURE_ROOT, {}), realPath },
      detectWorkspace,
    });
    await expect(retrieval).rejects.toBeInstanceOf(ClarificationNeededError);
    await expect(retrieval).rejects.toMatchObject({ clarification: { reason: "scope-invalid" } });
    expect(realPath).not.toHaveBeenCalled();
    expect(detectWorkspace).not.toHaveBeenCalled();

    const [started, clarified] = lifecycleEvents(
      activityLog,
      "search.connected-context.clarification-needed",
    );
    expect(started.extra).toMatchObject({ scopeKind: "files", relativePathCount: 0 });
    expect(clarified.extra).toMatchObject({
      clarificationReason: "scope-invalid",
      anchorCount: 0,
      plannedRingCount: 0,
      completeness: "complete",
      loss: "none",
    });
    expectBodyFree(activityLog);
    expect(clarified.correlationId).toBe(CORRELATION_ID);
    expectActivityLogProof(
      "search.connected-context.clarification-needed.line",
      formatActivityLogProofLine(clarified),
    );
  });
});
