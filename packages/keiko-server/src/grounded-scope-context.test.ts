import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileServerLogSink, type ServerLogSink } from "./observability/index.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceInfo, WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { KnownFitScopeContext } from "./grounded-scope-context.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const ROOT = "/scope-context-fixture";
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};
const FILE = { scopePath: "manual.txt", contentBytes: 100, lineCount: 2 };
function context(capacity: number): KnownFitScopeContext {
  return new KnownFitScopeContext(capacity, "scope", "query", 0);
}

const logCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of logCleanups.splice(0)) cleanup();
});

function capture(persisted: boolean): {
  log: ServerLogSink;
  completed: () => Readonly<Record<string, unknown>> | undefined;
} {
  if (!persisted) {
    const log = createBufferedServerLogSink();
    return {
      log,
      completed: (): Readonly<Record<string, unknown>> =>
        log.events
          .filter(
            (event) =>
              event.op === "search.connected-context.completed" ||
              event.op === "search.connected-context.completion-details",
          )
          .reduce<Readonly<Record<string, unknown>>>(
            (joined, event) => ({ ...joined, ...event.extra }),
            {},
          ),
    };
  }
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-known-fit-log-"));
  const log = createFileServerLogSink(stateDir, { level: "debug" });
  logCleanups.push(() => {
    log.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    log,
    completed: (): Readonly<Record<string, unknown>> => {
      log.close?.();
      const raw = readPersistedActivityLog(stateDir);
      expect(raw).not.toContain(ROOT);
      for (const line of raw.split("\n").filter(Boolean)) {
        const value: unknown = JSON.parse(line);
        if (
          typeof value === "object" &&
          value !== null &&
          "op" in value &&
          value.op === "search.connected-context.completion-details"
        ) {
          expect(value).toHaveProperty("correlationId", "known-fit-proof");
          return value;
        }
      }
      throw new Error("Missing persisted known-fit completion");
    },
  };
}

function request(
  text: string,
  capacity: number,
  elapsedMsMax: number | null,
): Parameters<typeof retrieveConnectedContextPack>[0] {
  return {
    workspaceRoot: ROOT,
    scope: {
      schemaVersion: "1",
      scopeId: "scope",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: { kind: "natural-language", text, maxResults: 1, caseSensitive: false, emittedAtMs: 0 },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: capacity, elapsedMsMax },
  };
}

async function retrieve(
  files: Readonly<Record<string, string>>,
  text: string,
  capacity = 8192,
  options: {
    persisted?: boolean;
    fs?: WorkspaceFs;
    nowMs?: () => number;
    elapsedMsMax?: number;
  } = {},
): Promise<{
  result: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  completed: Readonly<Record<string, unknown>> | undefined;
}> {
  const activity = capture(options.persisted === true);
  const result = await retrieveConnectedContextPack(
    request(text, capacity, options.elapsedMsMax ?? null),
    {
      correlationId: "known-fit-proof",
      activityLog: activity.log,
      fs: options.fs ?? memFs(ROOT, files),
      nowMs: options.nowMs ?? ((): number => 0),
      detectWorkspace: () => WORKSPACE,
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("Retrieval must not answer")),
      },
    },
  );
  return { result, completed: activity.completed() };
}

describe("known-fit scope admission", () => {
  it("accepts capacity equality and irreversibly clears evidence one byte beyond it", () => {
    const measured = context(8192);
    measured.observe(FILE);
    const exactCost = measured.observation().chargedBytes;
    const exact = context(exactCost);
    expect(exact.observe(FILE)).toBe(true);
    expect(exact.atoms()).toHaveLength(1);
    const below = context(exactCost - 1);
    expect(below.observe(FILE)).toBe(false);
    expect(below.atoms()).toEqual([]);
    expect(below.fileBytes().size).toBe(0);
    expect(below.observe({ ...FILE, scopePath: "small.txt", contentBytes: 1 })).toBe(false);
    expect(below.atoms()).toEqual([]);
    expect(below.observation()).toMatchObject({
      state: "overflow",
      observedFileCount: 1,
      retainedFileCount: 0,
    });
  });

  it("retains the same evidence set in either observation order", () => {
    const other = { ...FILE, scopePath: "other.txt" };
    const forward = context(8192);
    const reverse = context(8192);
    for (const file of [FILE, other]) forward.observe(file);
    for (const file of [other, FILE]) reverse.observe(file);
    expect(
      forward
        .atoms()
        .map((atom) => atom.stableId)
        .sort(),
    ).toEqual(
      reverse
        .atoms()
        .map((atom) => atom.stableId)
        .sort(),
    );
    expect(forward.observation()).toEqual(reverse.observation());
  });

  it("keeps fully observed contextual files when only lexical matches were capped", async () => {
    const { result, completed } = await retrieve(
      { "a.txt": "workflow step one\n", "b.txt": "workflow step two\n" },
      "Explain the workflow",
    );
    expect(result.pack.diagnostics?.coverage?.filesScanned).toBe(2);
    expect(result.pack.diagnostics?.coverage?.reasons).toContain("match-cap");
    expect(result.pack.files.map((file) => file.scopePath).sort()).toEqual(["a.txt", "b.txt"]);
    expect(completed).toMatchObject({
      scopeContextState: "applied",
      scopeContextObservedFileCount: 2,
      scopeContextRetainedFileCount: 2,
      scopeContextSelectedFileCount: 2,
    });
  });

  it("does not promote empty or blank files into certified contextual evidence", async () => {
    const { result, completed } = await retrieve(
      { "a.txt": "workflow step one\n", "empty.txt": "", "blank.txt": " \t\r\n" },
      "Explain the workflow",
    );
    expect(result.pack.files.map((file) => file.scopePath)).toEqual(["a.txt"]);
    expect(completed).toMatchObject({
      scopeContextObservedFileCount: 1,
      scopeContextRetainedFileCount: 1,
    });
  });

  it("records capacity overflow independently of selected evidence", async () => {
    const { completed } = await retrieve(
      { "a.txt": `workflow ${"x".repeat(2000)}` },
      "Explain the workflow",
      128,
    );
    expect(completed).toMatchObject({
      scopeContextState: "overflow",
      scopeContextObservedFileCount: 1,
      scopeContextRetainedFileCount: 0,
      scopeContextCapacityBytes: 128,
      scopeContextSelectedFileCount: 0,
    });
    expect(completed?.scopeContextChargedBytes).toBeGreaterThan(128);
  });

  it.each([
    "Why does the workflow fail with HTTP 503?",
    "Trace callers of workflow",
    "Show the history of workflow",
    'Find the exact literal "workflow"',
    "Explain WorkflowService",
  ])("records a refused enrichment gate for %s", async (question) => {
    const { completed } = await retrieve({ "a.txt": "workflow step one\n" }, question);
    expect(completed).toMatchObject({
      scopeContextState: "gate-refused",
      scopeContextSelectedFileCount: 0,
    });
  });
});

describe("persisted known-fit evidence", () => {
  it.each([
    { question: "Explain the workflow", capacity: 8192, state: "applied", retained: 1 },
    { question: "Explain the workflow", capacity: 128, state: "overflow", retained: 0 },
    {
      question: 'Find the exact literal "workflow"',
      capacity: 8192,
      state: "gate-refused",
      retained: 0,
    },
  ])(
    "records $state from the owning enrichment stage",
    async ({ question, capacity, state, retained }) => {
      const { completed } = await retrieve(
        { "a.txt": `workflow ${"x".repeat(500)}` },
        question,
        capacity,
        { persisted: true },
      );
      expect(completed).toMatchObject({
        scopeContextState: state,
        scopeContextRetainedFileCount: retained,
        scopeContextCapacityBytes: capacity,
      });
    },
  );
});

it.each([false, true])(
  "records the verified subset after a read failure (persisted=%s)",
  async (persisted) => {
    const files = { "a.txt": "workflow first step", "bad.txt": "workflow unavailable step" };
    const base = memFs(ROOT, files);
    const read = base.readFileBytes;
    if (read === undefined) throw new Error("Fixture lacks byte reader");
    const fs: WorkspaceFs = {
      ...base,
      readFileBytes: (path, limit): Promise<Uint8Array> =>
        path.endsWith("/bad.txt")
          ? Promise.reject(Object.assign(new Error("read unavailable"), { code: "EIO" }))
          : read(path, limit),
    };
    const { result, completed } = await retrieve(files, "Explain the workflow", 8192, {
      persisted,
      fs,
    });
    expect(result.pack.diagnostics?.coverage?.reasons).toContain("io-error");
    expect(completed).toMatchObject({
      scopeContextState: "applied",
      scopeContextObservedFileCount: 1,
      scopeContextRetainedFileCount: 1,
    });
  },
);

it.each([false, true])(
  "records an interrupted observation without claiming an applied scope (persisted=%s)",
  async (persisted) => {
    const files = { "a.txt": "workflow first step", "b.txt": "workflow next step" };
    const base = memFs(ROOT, files);
    const read = base.readFileBytes;
    if (read === undefined) throw new Error("Fixture lacks byte reader");
    let clock = 0;
    const fs: WorkspaceFs = {
      ...base,
      readFileBytes: (path, limit): Promise<Uint8Array> => {
        clock = 10;
        return read(path, limit);
      },
    };
    const { result, completed } = await retrieve(files, "Explain the workflow", 8192, {
      persisted,
      fs,
      nowMs: () => clock,
      elapsedMsMax: 1,
    });
    expect(result.pack.diagnostics?.coverage?.reasons).toContain("timeout");
    expect(completed).toMatchObject({
      scopeContextState: "incomplete-traversal",
      scopeContextRetainedFileCount: 0,
    });
  },
);
