import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import {
  createInMemoryWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndexStore,
} from "@oscharko-dev/keiko-workspace";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-grounded-index-guard-"));
  roots.push(root);
  for (let index = 0; index < 65; index += 1) {
    writeFileSync(
      join(root, `manual-${String(index).padStart(2, "0")}.html`),
      `<p>Vesper trip temperature is ${String(30 + index)} degrees.</p>\n`.repeat(100),
    );
  }
  return root;
}

async function retrieve(
  root: string,
  store: WorkspaceIndexStore,
  signal?: AbortSignal,
  activityLog: BufferedServerLogSink = createBufferedServerLogSink(),
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "grounded-index-guard",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: 0,
        explicitConnection: true,
      },
      query: {
        kind: "natural-language",
        text: "What is the Vesper trip temperature?",
        caseSensitive: false,
        maxResults: 200,
        emittedAtMs: 0,
      },
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 2, elapsedMsMax: null },
    },
    {
      correlationId: "grounded-index-guard",
      activityLog,
      signal,
      workspaceIndexForRoot: () => createWorkspaceIndex(store),
      answerer: { answer: (): Promise<string> => Promise.resolve("unused") },
    },
  );
}

describe("grounded index request cancellation forwarding", () => {
  it("reports actual live fallback when failed loading retains no index records", async () => {
    const log = createBufferedServerLogSink();
    const store: WorkspaceIndexStore = {
      loadSnapshot: () => Promise.reject(new TypeError("PRIVATE_INDEX_LOAD_FAILURE")),
      saveSnapshot: (): Promise<void> => Promise.resolve(),
    };
    const output = await retrieve(fixtureRoot(), store, undefined, log);
    expect(output.pack.files.length).toBeGreaterThan(0);
    const details = log.events.find(
      (event) => event.op === "search.connected-context.completion-details",
    );
    expect(details?.extra).toMatchObject({
      indexSearchMode: "live-fallback",
      indexLoadStatus: "failed",
      indexIndexedRecords: 0,
      indexReusedRecords: 0,
      indexSaveStatus: "not-attempted",
    });
    expect(details?.extra?.indexLoadFailures).toBeGreaterThan(0);
    expect(details?.extra?.indexReportCount).toBeGreaterThan(0);
    expect(log.lines().join("\n")).toContain('"indexSearchMode":"live-fallback"');
    expect(log.lines().join("\n")).not.toContain("PRIVATE_INDEX_LOAD_FAILURE");
  });

  it("preserves actual cold index work when only persistence fails", async () => {
    const base = createInMemoryWorkspaceIndexStore();
    const log = createBufferedServerLogSink();
    const store: WorkspaceIndexStore = {
      loadSnapshot: base.loadSnapshot,
      saveSnapshot: () => Promise.reject(new TypeError("PRIVATE_INDEX_SAVE_FAILURE")),
    };
    const output = await retrieve(fixtureRoot(), store, undefined, log);
    expect(output.pack.files.length).toBeGreaterThan(0);
    const details = log.events.find(
      (event) => event.op === "search.connected-context.completion-details",
    );
    expect(details?.extra).toMatchObject({
      indexSearchMode: "request-local-cold",
      indexLoadStatus: "miss",
      indexSaveStatus: "failed",
      indexReusedRecords: 0,
    });
    expect(details?.extra?.indexIndexedRecords).toBeGreaterThan(0);
    expect(details?.extra?.indexSaveFailures).toBeGreaterThan(0);
    expect(log.lines().join("\n")).not.toContain("PRIVATE_INDEX_SAVE_FAILURE");
  });

  it("preserves healthy persisted cold and warm search modes", async () => {
    const root = fixtureRoot();
    const store = createInMemoryWorkspaceIndexStore();
    const cold = createBufferedServerLogSink();
    await retrieve(root, store, undefined, cold);
    const coldDetails = cold.events.find(
      (event) => event.op === "search.connected-context.completion-details",
    );
    expect(coldDetails?.extra).toMatchObject({
      indexSearchMode: "persistent-cold",
      indexLoadStatus: "miss",
      indexSaveStatus: "succeeded",
    });
    const warm = createBufferedServerLogSink();
    await retrieve(root, store, undefined, warm);
    const warmDetails = warm.events.find(
      (event) => event.op === "search.connected-context.completion-details",
    );
    expect(warmDetails?.extra).toMatchObject({
      indexSearchMode: "persistent-warm",
      indexLoadStatus: "hit",
    });
    expect(warmDetails?.extra?.indexReusedRecords).toBeGreaterThan(0);
  });

  it("forwards the active request guard through the observed index to both store operations", async () => {
    const base = createInMemoryWorkspaceIndexStore();
    const loads: ((() => boolean) | undefined)[] = [];
    const saves: ((() => boolean) | undefined)[] = [];
    const store: WorkspaceIndexStore = {
      loadSnapshot: (key, isActive) => {
        loads.push(isActive);
        return base.loadSnapshot(key, isActive);
      },
      saveSnapshot: (key, snapshot, isActive) => {
        saves.push(isActive);
        return base.saveSnapshot(key, snapshot, isActive);
      },
    };
    const output = await retrieve(fixtureRoot(), store);
    expect(output.pack.files.length).toBeGreaterThan(0);
    expect(loads.length).toBeGreaterThan(0);
    expect(saves.length).toBeGreaterThan(0);
    expect([...loads, ...saves].every((isActive) => isActive?.() === true)).toBe(true);
  });

  it("prevents storage publication when the request aborts during snapshot saving", async () => {
    const base = createInMemoryWorkspaceIndexStore();
    const abort = new AbortController();
    const storedKeys: string[] = [];
    const store: WorkspaceIndexStore = {
      loadSnapshot: base.loadSnapshot,
      saveSnapshot: async (key, snapshot, isActive): Promise<void> => {
        abort.abort();
        await base.saveSnapshot(key, snapshot, isActive);
        if ((await base.loadSnapshot(key)) !== undefined) storedKeys.push(key);
      },
    };
    await expect(retrieve(fixtureRoot(), store, abort.signal)).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(abort.signal.aborted).toBe(true);
    expect(storedKeys).toEqual([]);
  });
});
