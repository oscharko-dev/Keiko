import { afterEach, describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFileServerLogSink } from "./observability/index.js";
import {
  readPersistedActivityLog,
  expectActivityLogProof,
} from "../../../tests/support/activity-log-proof.js";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { join } from "node:path";
import {
  WorkspaceReadError,
  type WorkspaceDirEntry,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(root: string): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "parallel-cleanup",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 0,
      explicitConnection: true,
      conversationId: undefined,
    },
    query: {
      kind: "natural-language",
      caseSensitive: false,
      maxResults: 20,
      emittedAtMs: 0,
      text: "Explain the relationship between ParallelCleanupProbe and ADR-123456.",
    },
  };
}

function interruptedWalkFs(
  root: string,
  failAfterEntry: boolean,
): {
  fs: WorkspaceFs;
  failure: WorkspaceReadError;
  closing: Promise<void>;
  releaseClose: () => void;
  state: { rootWalks: number; sharedClosed: boolean; sharedEntries: number };
} {
  const canonicalRoot = nodeWorkspaceFs.realPath(root);
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new TypeError("Physical directory iteration is required.");
  const state = { rootWalks: 0, sharedClosed: false, sharedEntries: 0 };
  const failure = new WorkspaceReadError("controlled directory read failure", ".");
  const closing = deferredVoid();
  const closePermission = deferredVoid();
  const fs: WorkspaceFs = {
    ...nodeWorkspaceFs,
    iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
      const walk = path === canonicalRoot ? ++state.rootWalks : 0;
      if (walk !== 2) {
        yield* iterate(path);
        return;
      }
      try {
        if (failAfterEntry) {
          state.sharedEntries += 1;
          yield {
            name: "ParallelCleanupProbe.ts",
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
          };
        }
        throw failure;
      } finally {
        closing.resolve();
        await closePermission.promise;
        state.sharedClosed = true;
      }
    },
  };
  return { fs, failure, closing: closing.promise, releaseClose: closePermission.resolve, state };
}

describe("shared filename traversal failure cleanup", () => {
  it.each([false, true])(
    "closes the shared symbol/document iterator before propagating failure (entry yielded: %s)",
    async (failAfterEntry) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-parallel-cleanup-"));
      roots.push(root);
      writeFileSync(
        join(root, "ParallelCleanupProbe.ts"),
        "export const ParallelCleanupProbe = 73;\n",
      );
      writeFileSync(join(root, "ADR-123456.md"), "Recorded interval 730 hours.\n");
      for (let index = 0; index < 10; index += 1)
        writeFileSync(join(root, `noise-${String(index)}.txt`), "Unrelated ordinary text.\n");
      const controlled = interruptedWalkFs(root, failAfterEntry);
      const caller = new AbortController();
      const activityLog = createBufferedServerLogSink();
      let settled = false;
      const pending = retrieveConnectedContextPack(request(root), {
        correlationId: "parallel-cleanup-regression",
        activityLog,
        fs: controlled.fs,
        signal: caller.signal,
        nowMs: () => 0,
        detectWorkspace: () => ({
          root,
          selectedRoot: root,
          name: "cleanup fixture",
          version: "0",
          testFramework: "vitest",
          sourceDirs: [],
          testDirs: [],
          languages: ["typescript"],
          ignoreLines: [],
        }),
        answerer: { answer: () => Promise.reject(new Error("No model may be called.")) },
      }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await controlled.closing;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(controlled.state.sharedClosed).toBe(false);
        expect(activityLog.events.filter((event) => event.op.endsWith(".failed"))).toEqual([]);
        controlled.releaseClose();
        expect(await pending).toBe(controlled.failure);
        expect(controlled.state.rootWalks).toBe(2);
        expect(controlled.state.sharedClosed).toBe(true);
        expect(controlled.state.sharedEntries).toBeLessThanOrEqual(1);
        expect(caller.signal.aborted).toBe(false);
        expect(
          activityLog.events.filter((event) => event.op === "search.connected-context.failed"),
        ).toMatchObject([
          {
            correlationId: "parallel-cleanup-regression",
            errorKind: "internal",
            extra: { outcome: "failed" },
          },
        ]);
      } finally {
        controlled.releaseClose();
        await pending;
      }
    },
  );
});

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function* settledFixtureEntries(
  entries: AsyncIterable<WorkspaceDirEntry>,
  settlements: Promise<void>[],
): AsyncIterable<WorkspaceDirEntry> {
  const settled = deferredVoid();
  settlements.push(settled.promise);
  try {
    yield* entries;
  } finally {
    settled.resolve();
  }
}

function stalledDirectoryFs(): {
  fs: WorkspaceFs;
  entered: Promise<void>;
  released: Promise<void>;
  release: () => void;
  settle: () => Promise<void>;
  failure: Error;
  state: { closed: boolean };
} {
  const entered = deferredVoid();
  const read = deferredVoid();
  const released = deferredVoid();
  const failure = new TypeError("PRIVATE_DIRECTORY_CLEANUP_DETAIL");
  const state = { closed: false };
  const settlements: Promise<void>[] = [];
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new TypeError("Physical directory iteration is required.");
  let walks = 0;
  const controlledEntries = async function* (path: string): AsyncIterable<WorkspaceDirEntry> {
    walks += 1;
    if (walks !== 2) {
      yield* iterate.call(nodeWorkspaceFs, path);
      return;
    }
    try {
      entered.resolve();
      await read.promise;
      yield { name: "late.txt", isFile: true, isDirectory: false, isSymbolicLink: false };
    } finally {
      state.closed = true;
      released.resolve();
      await Promise.reject(failure);
    }
  };
  return {
    fs: {
      ...nodeWorkspaceFs,
      iterateDirectory: (path): AsyncIterable<WorkspaceDirEntry> =>
        settledFixtureEntries(controlledEntries(path), settlements),
    },
    entered: entered.promise,
    released: released.promise,
    release: read.resolve,
    settle: async (): Promise<void> => {
      for (const settled of settlements) await settled;
    },
    failure,
    state,
  };
}

it.each(["buffered", "persisted"])(
  "returns user cancellation promptly and records a later physical cleanup failure (%s)",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-stalled-cleanup-"));
    roots.push(root);
    writeFileSync(
      join(root, "ParallelCleanupProbe.ts"),
      "export const ParallelCleanupProbe = 73;\n",
    );
    writeFileSync(join(root, "ADR-123456.md"), "Recorded interval 730 hours.\n");
    const controlled = stalledDirectoryFs();
    const logRoot = mkdtempSync(join(tmpdir(), "keiko-stalled-cleanup-log-"));
    roots.push(logRoot);
    const persisted =
      mode === "persisted" ? createFileServerLogSink(logRoot, { level: "debug" }) : undefined;
    const caller = new AbortController();
    const activityLog = createBufferedServerLogSink();
    const cleanupEmitted = deferredVoid();
    let outcome: unknown;
    const pending = retrieveConnectedContextPack(request(root), {
      correlationId: "stalled-cleanup-regression",
      activityLog: {
        write: (event): void => {
          activityLog.write(event);
          persisted?.write(event);
          if (event.extra?.retrievalPhase === "directory-cleanup") cleanupEmitted.resolve();
        },
      },
      fs: controlled.fs,
      signal: caller.signal,
      nowMs: () => 0,
      detectWorkspace: () => ({
        root,
        selectedRoot: root,
        name: "cleanup fixture",
        version: "0",
        testFramework: "vitest",
        sourceDirs: [],
        testDirs: [],
        languages: ["typescript"],
        ignoreLines: [],
      }),
      answerer: { answer: () => Promise.reject(new Error("No model may be called.")) },
    }).catch((error: unknown) => {
      outcome = error;
    });
    try {
      await controlled.entered;
      caller.abort();
      await nextTurn();
      expect(outcome).toBeInstanceOf(CancelledError);
      expect(controlled.state.closed).toBe(false);
      expect(
        activityLog.events.filter((event) => event.extra?.retrievalPhase === "directory-cleanup"),
      ).toEqual([]);
      const cancellation = outcome;
      controlled.release();
      await controlled.released;
      await controlled.settle();
      await cleanupEmitted.promise;
      expect(outcome).toBe(cancellation);
      expect(
        activityLog.events.filter((event) => event.extra?.retrievalPhase === "directory-cleanup"),
      ).toMatchObject([
        {
          op: "search.connected-context.failed",
          correlationId: "stalled-cleanup-regression",
          errorKind: "internal",
          extra: { outcome: "failed", completeness: "complete", loss: "none" },
        },
      ]);
      expect(JSON.stringify(activityLog.events)).not.toContain("PRIVATE_DIRECTORY_CLEANUP_DETAIL");
      expect(JSON.stringify(activityLog.events)).not.toContain(root);
      if (persisted !== undefined) {
        persisted.close?.();
        const raw = readPersistedActivityLog(logRoot);
        const cleanupLine = raw
          .split("\n")
          .find((line) => line.includes('"retrievalPhase":"directory-cleanup"'));
        expect(cleanupLine).toBeDefined();
        const proof = expectActivityLogProof(
          "search.connected-context.failed.line",
          cleanupLine ?? "",
        );
        expect(proof).toMatchObject({
          correlationId: "stalled-cleanup-regression",
          retrievalPhase: "directory-cleanup",
          outcome: "failed",
          errorKind: "internal",
        });
        expect(raw).not.toContain("PRIVATE_DIRECTORY_CLEANUP_DETAIL");
        expect(raw).not.toContain(root);
      }
    } finally {
      controlled.release();
      await pending;
      await controlled.settle();
      await cleanupEmitted.promise;
      persisted?.close?.();
    }
  },
);

it.each(["buffered", "persisted"])(
  "records competing collector failures without logging paths or messages (%s)",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-collector-failure-"));
    roots.push(root);
    const logRoot = mkdtempSync(join(tmpdir(), "keiko-collector-failure-log-"));
    roots.push(logRoot);
    const activityLog = createBufferedServerLogSink();
    const persisted =
      mode === "persisted" ? createFileServerLogSink(logRoot, { level: "debug" }) : undefined;
    const primary = Object.assign(
      new Error("File processing failed.", { cause: new TypeError("PRIVATE_SCORING_DETAIL") }),
      { requestedPath: "private/customer/a.ts" },
    );
    const secondary = Object.assign(
      new Error("File processing failed.", { cause: new RangeError("PRIVATE_SECONDARY_DETAIL") }),
      { requestedPath: "private/customer/b.ts" },
    );
    const directory = new WorkspaceReadError("PRIVATE_DIRECTORY_DETAIL", "private/customer");
    const failure = new AggregateError(
      [primary, secondary, directory],
      "Search processing failed.",
      { cause: primary },
    );
    try {
      await expect(
        retrieveConnectedContextPack(request(root), {
          correlationId: "collector-failure-regression",
          activityLog: {
            write: (event): void => {
              activityLog.write(event);
              persisted?.write(event);
            },
          },
          detectWorkspace: () => {
            throw failure;
          },
          answerer: { answer: () => Promise.reject(new Error("No model may be called.")) },
        }),
      ).rejects.toBe(failure);
      assertCollectorFailureEvent(activityLog);
      if (persisted !== undefined) {
        persisted.close?.();
        const raw = readPersistedActivityLog(logRoot);
        const line = raw
          .split("\n")
          .find((value) => value.includes('"op":"search.connected-context.failed"'));
        const proof = expectActivityLogProof("search.connected-context.failed.line", line ?? "");
        expect(proof).toMatchObject({
          secondaryFailureCount: 2,
          secondaryFailureKinds: ["RangeError", "WorkspaceReadError"],
          causeChain: ["Error", "TypeError"],
        });
        expect(raw).not.toMatch(/PRIVATE_|private\/customer/u);
      }
    } finally {
      persisted?.close?.();
    }
  },
);

function assertCollectorFailureEvent(
  activityLog: ReturnType<typeof createBufferedServerLogSink>,
): void {
  const event = activityLog.events.find((entry) => entry.op === "search.connected-context.failed");
  expect(event?.extra).toMatchObject({
    secondaryFailureCount: 2,
    secondaryFailureKinds: ["RangeError", "WorkspaceReadError"],
    causeChain: ["Error", "TypeError"],
  });
  expect(event?.extra?.primaryFailureScopeDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(event?.extra?.frames).toEqual(
    expect.arrayContaining([expect.stringContaining("grounded-parallel-cleanup.test.ts:")]),
  );
  expect(JSON.stringify(activityLog.events)).not.toMatch(/PRIVATE_|private\/customer/u);
}
