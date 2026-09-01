// Activity-log contract for connected-context retrieval (#3347). Every invocation emits one start
// and exactly one body-free terminal line, including failure and cancellation paths.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type EvidenceAtom,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import type { MicroIndex, RerankerSeam } from "@oscharko-dev/keiko-workflows";

import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  retrieveConnectedContextPack,
  type GroundedAnswerer,
  type OrchestratorDeps,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import type { GitFileHistoryEvidenceProvider } from "./grounded-git-history-evidence.js";
import {
  createBufferedServerLogSink,
  createFileServerLogSink,
  resetServerLogFailureNotices,
  type BufferedServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
} from "./observability/index.js";

const FIXTURE_NOW_MS = 1_700_000_000_000;
const FIXTURE_ROOT = "/private/customer/connected-context-log-fixture";
const FIXTURE_QUERY_TEXT = "Trace PrivateCustomerHandler implementation";
const CORRELATION_ID = "connected-context-log-correlation-0001";
const PRIVATE_SCOPE_PATH = "private-source";
const PRIVATE_SCOPE_FILE = `${PRIVATE_SCOPE_PATH}/private-customer-handler.ts`;

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`expected ${name} activity object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function lifecycleEvents(
  activityLog: BufferedServerLogSink,
  terminalOp: "search.connected-context.completed" | "search.connected-context.failed",
): readonly [ServerLogEvent, ServerLogEvent] {
  expect(activityLog.events).toHaveLength(2);
  const [started, terminal] = activityLog.events;
  if (started === undefined || terminal === undefined) {
    throw new Error("expected connected-context start and terminal activity events");
  }
  expect(started.op).toBe("search.connected-context.started");
  expect(terminal.op).toBe(terminalOp);
  expect(terminal.correlationId).toBe(started.correlationId);
  return [started, terminal];
}

function expectedRequestExtra(input: OrchestratorInput): Readonly<Record<string, unknown>> {
  const budget = input.budget ?? DEFAULT_EXPLORATION_BUDGET;
  return {
    queryKind: input.query.kind,
    caseSensitive: input.query.caseSensitive,
    maxResults: input.query.maxResults,
    searchCallsMax: budget.searchCallsMax,
    filesReadMax: budget.filesReadMax,
    excerptBytesMax: budget.excerptBytesMax,
    modelInputTokensMax: budget.modelInputTokensMax,
    modelOutputTokensMax: budget.modelOutputTokensMax,
    elapsedMsMax: budget.elapsedMsMax,
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
  input: OrchestratorInput,
  output: RetrievalOnlyOutput,
  readBudgetBlocked: boolean,
  elapsedBudgetBlocked = false,
): Readonly<Record<string, unknown>> {
  const retrievalBlocked = readBudgetBlocked || elapsedBudgetBlocked;
  return {
    activityDetailStatus: "complete",
    scopeKind: input.scope.kind,
    relativePathCount: input.scope.relativePaths.length,
    explicitConnection: input.scope.explicitConnection === true,
    plannedRingCount: output.plan.rings.length,
    usage: {
      searchCalls: output.pack.usage.searchCalls,
      filesRead: output.pack.usage.filesRead,
      excerptBytes: output.pack.usage.excerptBytes,
      modelInputTokens: output.pack.usage.modelInputTokens,
      modelOutputTokens: output.pack.usage.modelOutputTokens,
      elapsedMs: output.pack.usage.elapsedMs,
      rerankCalls: output.pack.usage.rerankCalls,
    },
    selectionCounts: {
      selectedFileCount: output.pack.files.length,
      omittedCount: output.pack.omitted.length,
    },
    uncertainty: {
      count: output.pack.uncertainty.length,
      scopeIncompleteUncertaintyCount: output.pack.uncertainty.filter(
        (marker) => marker.kind === "scope-incomplete",
      ).length,
      toolUnavailableUncertaintyCount: output.pack.uncertainty.filter(
        (marker) => marker.kind === "tool-unavailable",
      ).length,
      budgetClippedUncertaintyCount: output.pack.uncertainty.filter(
        (marker) => marker.kind === "budget-clipped",
      ).length,
    },
    coverage: retrievalBlocked
      ? { coverageStatus: "not-reported", coverageReasons: [] }
      : expectedCoverageExtra(output),
    retrievalStatus: {
      readBudgetBlocked,
      elapsedBudgetBlocked,
      workspaceIndexProviderStatus: retrievalBlocked ? "not-evaluated" : "unavailable",
    },
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
    ...expectedRequestExtra(input),
  });
  expectSha256(started.extra?.scopeIdentitySha256);
  expectSha256(started.extra?.queryIdentitySha256);
  expect(started.extra?.queryIdentitySha256).not.toBe(started.extra?.scopeIdentitySha256);
  expect(terminal.extra).toMatchObject(started.extra ?? {});
}

function expectZeroStructuralWork(event: ServerLogEvent): void {
  expect(nestedExtra(event.extra, "structural")).toMatchObject({
    contextCount: 0,
    candidateInventoryBuildCount: 0,
    candidateFileCount: 0,
    candidateDirectoryCount: 0,
    codeIndexBuildCount: 0,
    symbolGraphBuildCount: 0,
    importGraphBuildCount: 0,
    endpointGraphBuildCount: 0,
    fileSearchCount: 0,
    textSearchCount: 0,
  });
}

const WORKSPACE_INDEX_COUNTER_FIELDS = [
  "searchCount",
  "reportCount",
  "fallbackSearchCount",
  "discoveredEntries",
  "retainedEntries",
  "indexedRecords",
  "reusedRecords",
  "staleRecords",
  "skippedEntries",
  "deletedEntries",
  "droppedRecords",
  "loadAttempts",
  "loadHits",
  "loadMisses",
  "loadFailures",
  "saveAttempts",
  "saveSuccesses",
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
  expectNonNegativeNumberFields(nestedExtra(event, "workspaceIo"), WORKSPACE_IO_COUNTER_FIELDS);
}

function emptyExpectedWorkspaceIoActivity(): Readonly<Record<string, number>> {
  return Object.fromEntries(WORKSPACE_IO_COUNTER_FIELDS.map((field) => [field, 0]));
}

describe("retrieveConnectedContextPack activity log", () => {
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

      const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const persisted = parsePersistedLogLines(raw);
      expect(persisted).toHaveLength(2);
      const [started, completed] = persisted;
      if (started === undefined || completed === undefined) {
        throw new Error("expected persisted connected-context start and completion lines");
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
        coverage: expectedCoverageExtra(output),
        selectionCounts: {
          selectedFileCount: output.pack.files.length,
          omittedCount: output.pack.omitted.length,
        },
        retrievalStatus: {
          readBudgetBlocked: false,
          elapsedBudgetBlocked: false,
          workspaceIndexProviderStatus: "unavailable",
        },
      });
      expectSha256(started.scopeIdentitySha256);
      expectSha256(started.queryIdentitySha256);
      expectNonNegativeNumberFields(completed, ["durationMs"]);
      expectNonNegativeNumberFields(nestedExtra(completed, "structural"), [
        "contextCount",
        "candidateInventoryBuildCount",
        "candidateFileCount",
        "candidateDirectoryCount",
        "codeIndexBuildCount",
        "symbolGraphBuildCount",
        "importGraphBuildCount",
        "endpointGraphBuildCount",
        "fileSearchCount",
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
      expectWorkspaceIndexCounters(completed);
      expectWorkspaceIoCounters(completed);
      const workspaceIndex = nestedExtra(completed, "workspaceIndex");
      expect(workspaceIndex).toMatchObject({
        providerStatus: "unavailable",
        loadStatus: "not-attempted",
        saveStatus: "not-attempted",
      });
      expect(workspaceIndex.searchMode).toBe("live-fallback");
      expect(workspaceIndex.reportCount).toBe(0);
      expect(workspaceIndex.fallbackSearchCount).toBeGreaterThan(0);
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
        workspaceIndexProviderStatus: "unavailable",
      });
      expect(completed).not.toHaveProperty("_truncatedFieldCount");
      for (const secret of privateFixtureValues()) expect(raw).not.toContain(secret);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists cold indexing, warm reuse, and stale reconciliation from the real index", async () => {
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

      const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const completed = parsePersistedLogLines(raw).filter(
        (entry) => entry.op === "search.connected-context.completed",
      );
      expect(completed).toHaveLength(3);
      const [cold, warm, stale] = completed;
      if (cold === undefined || warm === undefined || stale === undefined) {
        throw new Error("expected cold, warm, and stale connected-context completion lines");
      }
      expect(cold.correlationId).toBe(`${CORRELATION_ID}-cold`);
      expect(warm.correlationId).toBe(`${CORRELATION_ID}-warm`);
      expectWorkspaceIndexCounters(cold);
      expectWorkspaceIndexCounters(warm);
      expect(nestedExtra(cold, "workspaceIndex")).toMatchObject({
        providerStatus: "available",
        searchMode: "persistent-cold",
        loadStatus: "miss",
        saveStatus: "succeeded",
        reusedRecords: 0,
        loadFailures: 0,
        saveFailures: 0,
      });
      expect(nestedExtra(cold, "workspaceIndex").indexedRecords).toBeGreaterThan(0);
      expect(nestedExtra(warm, "workspaceIndex")).toMatchObject({
        providerStatus: "available",
        searchMode: "persistent-warm",
        loadStatus: "hit",
        loadFailures: 0,
        saveFailures: 0,
      });
      expect(nestedExtra(warm, "workspaceIndex").reusedRecords).toBeGreaterThan(0);
      expectWorkspaceIndexCounters(stale);
      expect(stale.correlationId).toBe(`${CORRELATION_ID}-stale`);
      expect(nestedExtra(stale, "workspaceIndex")).toMatchObject({
        providerStatus: "available",
        searchMode: "persistent-reconciled",
        loadFailures: 0,
        saveFailures: 0,
      });
      expect(nestedExtra(stale, "workspaceIndex").staleRecords).toBeGreaterThan(0);
      for (const secret of privateFixtureValues()) expect(raw).not.toContain(secret);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists fail-open workspace-index load and save failures as body-free counters", async () => {
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

      const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const completed = parsePersistedLogLines(raw).find(
        (entry) => entry.op === "search.connected-context.completed",
      );
      if (completed === undefined) throw new Error("expected connected-context completion line");
      expectWorkspaceIndexCounters(completed);
      expect(nestedExtra(completed, "workspaceIndex")).toMatchObject({
        providerStatus: "available",
        loadStatus: "failed",
        saveStatus: "failed",
      });
      expect(["request-local-cold", "request-local-warm", "request-local-reconciled"]).toContain(
        nestedExtra(completed, "workspaceIndex").searchMode,
      );
      expect(nestedExtra(completed, "workspaceIndex").loadFailures).toBeGreaterThan(0);
      expect(nestedExtra(completed, "workspaceIndex").saveFailures).toBeGreaterThan(0);
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

      const raw = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const persisted = parsePersistedLogLines(raw);
      expect(persisted).toHaveLength(2);
      expect(persisted[1]).toMatchObject({
        op: "search.connected-context.failed",
        correlationId: CORRELATION_ID,
        errorKind: "TypeError",
        causeChain: ["RangeError"],
        outcome: "failed",
        retrievalPhase: "workspace-detection",
      });
      expectAnchoredFrames(persisted[1]?.frames);
      expect(persisted[1]?.workspaceIndex).toMatchObject({
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
    expect(completed).toMatchObject({
      category: "search",
      op: "search.connected-context.completed",
      correlationId: CORRELATION_ID,
    });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.extra).toMatchObject({
      ...expectedExtra(input, output, false),
    });
    expectNonNegativeNumberFields(nestedExtra(completed.extra, "structural"), [
      "contextCount",
      "candidateInventoryBuildCount",
      "candidateFileCount",
      "candidateDirectoryCount",
      "codeIndexBuildCount",
      "symbolGraphBuildCount",
      "importGraphBuildCount",
      "endpointGraphBuildCount",
      "fileSearchCount",
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
      "noEvidenceUncertaintyCount",
      "staleEvidenceUncertaintyCount",
      "scopeIncompleteUncertaintyCount",
      "budgetClippedUncertaintyCount",
      "toolUnavailableUncertaintyCount",
      "lowConfidenceUncertaintyCount",
      "unsupportedCitationUncertaintyCount",
      "incompleteAnswerUncertaintyCount",
      "unsupportedClaimUncertaintyCount",
      "entailmentUnavailableUncertaintyCount",
    ]);
    expectWorkspaceIndexCounters(completed.extra ?? {});
    expectWorkspaceIoCounters(completed.extra ?? {});
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
    expect(completed).toMatchObject({
      category: "search",
      op: "search.connected-context.completed",
      correlationId: UNKNOWN_CORRELATION_ID,
    });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.extra).toMatchObject({
      ...expectedExtra(input, output, true),
      structural: { contextCount: 0, candidateInventoryBuildCount: 0 },
      workspaceIndex: {
        providerStatus: "not-evaluated",
        searchMode: "not-evaluated",
        loadStatus: "not-attempted",
        saveStatus: "not-attempted",
      },
    });
    expectWorkspaceIndexCounters(completed.extra ?? {});
    expectWorkspaceIoCounters(completed.extra ?? {});
    expect(nestedExtra(completed.extra, "workspaceIo")).toEqual(emptyExpectedWorkspaceIoActivity());
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
    expect(completed.extra).toMatchObject({ ...expectedExtra(input, output, false, true) });
    expect(nestedExtra(completed.extra, "retrievalStatus")).toEqual({
      readBudgetBlocked: false,
      elapsedBudgetBlocked: true,
      workspaceIndexProviderStatus: "not-evaluated",
    });
    expect(nestedExtra(completed.extra, "workspaceIo")).toEqual(emptyExpectedWorkspaceIoActivity());
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

    const [, completed] = lifecycleEvents(activityLog, "search.connected-context.completed");
    const workspaceIndex = nestedExtra(completed.extra, "workspaceIndex");
    expect(workspaceIndex).toMatchObject({
      providerStatus: "unavailable",
      searchMode: "unused",
      reportCount: 0,
      fallbackSearchCount: 0,
    });
    expect(workspaceIndex.searchCount).toBeGreaterThan(0);
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
      errorKind: "TypeError",
      extra: {
        outcome: "failed",
        retrievalPhase: "workspace-detection",
      },
    });
    expectNonNegativeNumberFields(failed.extra, ["plannedRingCount"]);
    expect(failed.extra?.causeChain).toEqual(["RangeError"]);
    expectAnchoredFrames(failed.extra?.frames);
    expectZeroStructuralWork(failed);
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual(emptyExpectedWorkspaceIoActivity());
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
          requestFs.readFileUtf8SameDescriptor?.("unused", 1, "reject");
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
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
          requestFs.readFileUtf8SameDescriptor?.("unused", 1, "reject");
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(sizeReads).toBe(1);
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
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
          void requestFs.openFileReader?.("unused", "reject");
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    const [, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(nestedExtra(failed.extra, "workspaceIo")).toEqual({
      ...emptyExpectedWorkspaceIoActivity(),
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
      errorKind: "GATEWAY_CANCELLED",
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
      errorKind: "GATEWAY_CANCELLED",
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
        errorKind: "TypeError",
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
    const malformed = {
      ...fixtureInput(),
      scope: { ...fixtureScope(), relativePaths: undefined },
    } as unknown as OrchestratorInput;

    await expect(
      retrieveConnectedContextPack(malformed, fixtureDeps(activityLog, CORRELATION_ID)),
    ).rejects.toBeInstanceOf(Error);

    const [started, failed] = lifecycleEvents(activityLog, "search.connected-context.failed");
    expect(started.extra).toMatchObject({ scopeKind: "files", relativePathCount: 0 });
    expect(failed.extra).toMatchObject({ retrievalPhase: "planning", plannedRingCount: 0 });
    expectBodyFree(activityLog);
  });
});
