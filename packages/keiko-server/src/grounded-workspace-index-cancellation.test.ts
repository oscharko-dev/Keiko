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
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
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
      activityLog: createBufferedServerLogSink(),
      signal,
      workspaceIndexForRoot: () => createWorkspaceIndex(store),
      answerer: { answer: (): Promise<string> => Promise.resolve("unused") },
    },
  );
}

describe("grounded index request cancellation forwarding", () => {
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
