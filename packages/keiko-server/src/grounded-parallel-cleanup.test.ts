import { afterEach, describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  failedWalk: number,
): {
  fs: WorkspaceFs;
  failure: WorkspaceReadError;
  closing: Promise<void>;
  releaseClose: () => void;
  state: { rootWalks: number; siblingClosed: boolean; siblingEntries: number };
} {
  const canonicalRoot = nodeWorkspaceFs.realPath(root);
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new TypeError("Physical directory iteration is required.");
  const state = { rootWalks: 0, siblingClosed: false, siblingEntries: 0 };
  const failure = new WorkspaceReadError("controlled directory read failure", ".");
  let started = (): void => undefined;
  let closing = (): void => undefined;
  let releaseClose = (): void => undefined;
  const siblingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const siblingClosing = new Promise<void>((resolve) => {
    closing = resolve;
  });
  const closePermission = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const siblingWalk = failedWalk === 2 ? 3 : 2;
  const fs: WorkspaceFs = {
    ...nodeWorkspaceFs,
    iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
      const walk = path === canonicalRoot ? ++state.rootWalks : 0;
      if (walk === failedWalk) {
        await siblingStarted;
        throw failure;
      }
      try {
        for await (const entry of iterate(path)) {
          if (walk === siblingWalk) {
            state.siblingEntries += 1;
            if (state.siblingEntries === 1) {
              started();
              // Let the rejected sibling propagate through promise continuations before the
              // admitted directory read returns; no duration or machine-speed assumption.
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
          yield entry;
        }
      } finally {
        if (walk === siblingWalk) {
          closing();
          await closePermission;
          state.siblingClosed = true;
        }
      }
    },
  };
  return { fs, failure, closing: siblingClosing, releaseClose, state };
}

describe("parallel retrieval failure cleanup", () => {
  it.each([2, 3])(
    "closes the sibling iterator before propagating auxiliary walk %i failure",
    async (failedWalk) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-parallel-cleanup-"));
      roots.push(root);
      writeFileSync(
        join(root, "ParallelCleanupProbe.ts"),
        "export const ParallelCleanupProbe = 73;\n",
      );
      writeFileSync(join(root, "ADR-123456.md"), "Recorded interval 730 hours.\n");
      for (let index = 0; index < 10; index += 1)
        writeFileSync(join(root, `noise-${String(index)}.txt`), "Unrelated ordinary text.\n");
      const controlled = interruptedWalkFs(root, failedWalk);
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
        expect(controlled.state.siblingClosed).toBe(false);
        expect(activityLog.events.filter((event) => event.op.endsWith(".failed"))).toEqual([]);
        controlled.releaseClose();
        expect(await pending).toBe(controlled.failure);
        expect(controlled.state.rootWalks).toBe(3);
        expect(controlled.state.siblingClosed).toBe(true);
        expect(controlled.state.siblingEntries).toBeLessThanOrEqual(1);
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
