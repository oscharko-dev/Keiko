import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  RepoSearchInvalidQueryError,
  symbolGraphAdapter,
  type WorkspaceDirEntry,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { createFileServerLogSink } from "./observability/index.js";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function request(root: string): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "terminal-cleanup",
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
      text: "Explain the relationship between TerminalCleanupProbe and ADR-123456.",
    },
  };
}

function controlledDirectoryFs(): {
  fs: WorkspaceFs;
  arm: () => void;
  entered: Promise<void>;
  returnQueued: Promise<void>;
  released: Promise<void>;
  release: () => void;
  state: { closed: boolean };
} {
  const entered = deferred();
  const returnQueued = deferred();
  const release = deferred();
  const released = deferred();
  const state = { closed: false };
  let armed = false;
  let stalled = false;
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new TypeError("Physical directory iteration is required.");
  return {
    arm: (): void => {
      armed = true;
    },
    entered: entered.promise,
    returnQueued: returnQueued.promise,
    released: released.promise,
    release: release.resolve,
    state,
    fs: {
      ...nodeWorkspaceFs,
      iterateDirectory: (path): AsyncIterable<WorkspaceDirEntry> => {
        let ownsStall = false;
        const entries = async function* (): AsyncGenerator<WorkspaceDirEntry> {
          if (!armed || stalled) {
            yield* iterate(path);
            return;
          }
          stalled = true;
          ownsStall = true;
          try {
            entered.resolve();
            await release.promise;
            yield { name: "late.txt", isFile: true, isDirectory: false, isSymbolicLink: false };
          } finally {
            state.closed = true;
            released.resolve();
            await Promise.reject(new TypeError("PRIVATE_TERMINAL_CLEANUP_DETAIL"));
          }
        };
        const iterator = entries();
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<WorkspaceDirEntry> => ({
            next: () => iterator.next(),
            return: (): Promise<IteratorResult<WorkspaceDirEntry>> => {
              if (ownsStall) returnQueued.resolve();
              return iterator.return(undefined);
            },
          }),
        };
      },
    },
  };
}

describe("terminal failure with a stalled physical directory read", () => {
  it.each(["buffered", "persisted"])(
    "returns the original non-cancellation error before queued cleanup finishes (%s)",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-terminal-cleanup-"));
      const logRoot = mkdtempSync(join(tmpdir(), "keiko-terminal-cleanup-log-"));
      writeFileSync(
        join(root, "TerminalCleanupProbe.ts"),
        "export const TerminalCleanupProbe = 73;\n",
      );
      writeFileSync(join(root, "ADR-123456.md"), "Recorded interval 730 hours.\n");
      const controlled = controlledDirectoryFs();
      const primary = new RepoSearchInvalidQueryError("PRIVATE_ADAPTER_FAILURE");
      let calls = 0;
      let lateConsumed = false;
      const adapter = vi
        .spyOn(symbolGraphAdapter, "lookup")
        .mockImplementation(async (scope, _query, _limits, fs) => {
          if (++calls === 1) {
            controlled.arm();
            const entries = fs.iterateDirectory?.(scope.workspace.root);
            if (entries === undefined) throw new TypeError("Controlled directory port missing.");
            for await (const entry of entries) lateConsumed ||= entry.name === "late.txt";
            return [];
          }
          await controlled.entered;
          throw primary;
        });
      const log = createBufferedServerLogSink();
      const persisted =
        mode === "persisted" ? createFileServerLogSink(logRoot, { level: "debug" }) : undefined;
      const cleanupEmitted = deferred();
      const caller = new AbortController();
      let outcome: unknown;
      const pending = retrieveConnectedContextPack(request(root), {
        fs: controlled.fs,
        signal: caller.signal,
        nowMs: () => 0,
        correlationId: "terminal-cleanup-regression",
        activityLog: {
          write: (event): void => {
            log.write(event);
            persisted?.write(event);
            if (event.extra?.retrievalPhase === "directory-cleanup") cleanupEmitted.resolve();
          },
        },
        detectWorkspace: () => ({
          root,
          selectedRoot: root,
          name: "fixture",
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
        await controlled.returnQueued;
        await nextTurn();
        expect(caller.signal.aborted).toBe(false);
        expect(controlled.state.closed).toBe(false);
        expect(lateConsumed).toBe(false);
        expect(outcome).toBe(primary);
        expect(
          log.events.filter((event) => event.op === "search.connected-context.failed"),
        ).toMatchObject([
          {
            correlationId: "terminal-cleanup-regression",
            extra: {
              outcome: "failed",
              retrievalPhase: "ring-retrieval",
              directoryCleanupPendingCount: 1,
            },
          },
        ]);
        expect(
          log.events.some((event) => event.extra?.retrievalPhase === "directory-cleanup"),
        ).toBe(false);
        controlled.release();
        await controlled.released;
        await cleanupEmitted.promise;
        expect(outcome).toBe(primary);
        expect(caller.signal.aborted).toBe(false);
        expect(lateConsumed).toBe(false);
        expect(
          log.events.filter((event) => event.extra?.retrievalPhase === "directory-cleanup"),
        ).toMatchObject([
          {
            op: "search.connected-context.failed",
            correlationId: "terminal-cleanup-regression",
            extra: { outcome: "failed", completeness: "complete", loss: "none" },
          },
        ]);
        expect(JSON.stringify(log.events)).not.toContain("PRIVATE_");
        if (persisted !== undefined) {
          persisted.close?.();
          const raw = readPersistedActivityLog(logRoot);
          const line = raw
            .split("\n")
            .find((entry) => entry.includes('"retrievalPhase":"directory-cleanup"'));
          expectActivityLogProof("search.connected-context.failed.line", line ?? "");
          expect(raw).not.toContain(root);
          expect(raw).not.toContain("PRIVATE_");
        }
      } finally {
        controlled.release();
        await pending;
        await controlled.released;
        await cleanupEmitted.promise;
        adapter.mockRestore();
        persisted?.close?.();
        rmSync(root, { recursive: true, force: true });
        rmSync(logRoot, { recursive: true, force: true });
      }
    },
  );
});
