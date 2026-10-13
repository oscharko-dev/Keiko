import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { listSupportIncidents } from "@oscharko-dev/keiko-activity-log";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { CancelledError, ERROR_CODES } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";
import { causeChain, createFileServerLogSink } from "./observability/index.js";
import {
  expectRegisteredActivityLogLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  drainSupportIncidentCandidates,
  setSupportIncidentTriggerForTests,
} from "../../../tests/support/activity-log-test-support.js";

const TARGET = "src/selected.ts";
const CORRELATION = "selected-descriptor-cancellation";
let directory = "";
let root = "";
let stateDir = "";

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-selected-cancel-")));
  root = join(directory, "workspace");
  stateDir = join(directory, "state");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, TARGET), "export const selectedValue = 73;\n");
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  setSupportIncidentTriggerForTests(true);
});
afterEach(() => {
  drainSupportIncidentCandidates();
  setSupportIncidentTriggerForTests(false);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function request(): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "selected-cancel",
      workspaceRoot: root,
      kind: "files",
      relativePaths: [TARGET],
      connectedAtMs: 1,
      explicitConnection: true,
      conversationId: undefined,
    },
    query: {
      kind: "natural-language",
      text: `Explain ${TARGET}.`,
      caseSensitive: false,
      maxResults: 20,
      emittedAtMs: 1,
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 1_000 },
  };
}

function nativeReader(failure = false): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly reads: () => number;
  readonly closes: () => number;
} {
  const entered = deferred();
  const released = deferred();
  const originalOpen = fs.promises.open;
  let reads = 0;
  let closes = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (String(path) !== join(root, TARGET)) return handle;
    const originalRead = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      reads += 1;
      const result = await originalRead(...args);
      entered.resolve();
      // Hold genuine descriptor delivery to control stop ordering, not native OS latency.
      await released.promise;
      if (failure) throw Object.assign(new Error("PRIVATE_NATIVE_IO_FAILURE"), { code: "EIO" });
      return result;
    });
    const originalClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closes += 1;
      await originalClose();
    });
    return handle;
  });
  syncBuiltinESMExports();
  return {
    entered: entered.promise,
    release: released.resolve,
    reads: () => reads,
    closes: () => closes,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function stoppedRetrieval(mode: "abort" | "timeout" | "io-failure"): Promise<{
  readonly error: unknown;
  readonly raw: string;
  readonly record: Record<string, unknown>;
}> {
  const controller = new AbortController();
  const reader = nativeReader(mode === "io-failure");
  let now = 1;
  const log = createFileServerLogSink(stateDir, { level: "debug" });
  const pending = retrieveConnectedContextPack(request(), {
    signal: controller.signal,
    fs: nodeWorkspaceFs,
    activityLog: log,
    correlationId: CORRELATION,
    nowMs: () => now,
    answerer: { answer: () => Promise.resolve("not invoked") },
  }).catch((error: unknown) => error);
  try {
    await reader.entered;
    if (mode === "abort") controller.abort();
    else if (mode === "timeout") now = 1_002;
    reader.release();
    const error: unknown = await pending;
    await vi.waitFor(() => {
      expect(reader.closes()).toBe(1);
    });
    expect(reader.reads()).toBe(1);
    log.close?.();
    drainSupportIncidentCandidates();
    const raw = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(raw, "search.connected-context.failed");
    expect(lines).toHaveLength(1);
    const record = expectRegisteredActivityLogLine(
      "search.connected-context.failed",
      lines[0] ?? "",
    );
    expect(analyzeLogText(raw).evidence.classification).toBe("supported");
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("PRIVATE_NATIVE_IO_FAILURE");
    return { error, raw, record };
  } finally {
    reader.release();
    log.close?.();
  }
}

describe("selected native descriptor cancellation at the admission owner", () => {
  it("records a caller abort as cancellation without creating a registered-failure incident", async () => {
    const result = await stoppedRetrieval("abort");
    expect(result.error).toBeInstanceOf(CancelledError);
    expect(result.record).toMatchObject({
      level: "warn",
      errorKind: "cancelled",
      outcome: "cancelled",
      failureKind: ERROR_CODES.CANCELLED,
    });
    expect(listSupportIncidents(stateDir)).toEqual([]);
    expect(result.error).toMatchObject({ cause: { reason: "aborted" } });
    expect(result.record.causeChain).toEqual(causeChain(result.error));
  });

  it.each(["timeout", "io-failure"] as const)(
    "keeps %s distinct from intentional cancellation",
    async (mode) => {
      const result = await stoppedRetrieval(mode);
      expect(result.error).not.toBeInstanceOf(CancelledError);
      expect(result.record).toMatchObject({ level: "error", outcome: "failed" });
      expect(result.record.errorKind).not.toBe("cancelled");
      if (mode === "timeout") expect(result.error).toMatchObject({ reason: "timeout" });
      else expect(result.error).toMatchObject({ reason: "io-error" });
      expect(listSupportIncidents(stateDir)).toHaveLength(1);
    },
  );

  it("preserves healthy selected-file admission through the same native reader", async () => {
    const reader = nativeReader();
    reader.release();
    const result = await retrieveConnectedContextPack(request(), {
      correlationId: "selected-descriptor-healthy",
      fs: nodeWorkspaceFs,
      nowMs: () => 1,
      answerer: { answer: () => Promise.resolve("not invoked") },
    });
    expect(result.pack.files.some((file) => file.scopePath === TARGET)).toBe(true);
    expect(
      result.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.content)
        .join("\n"),
    ).toContain("selectedValue = 73");
    expect(reader.reads()).toBeGreaterThan(0);
    expect(reader.closes()).toBe(reader.reads());
  });
});
