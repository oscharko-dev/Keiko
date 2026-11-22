// #4228 — the coding-context memory provider hands the embedding model's semantic floor to retrieval
// together with the semantic scores it judges, and hands none without scores.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { MemoryId, MemoryRecord, ProjectId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryRetrievalRequest } from "@oscharko-dev/keiko-memory-retrieval";

import type { UiHandlerDeps } from "../index.js";
import type { ProviderContext } from "./codingContextProviders.js";

const { requests, signalsMock } = vi.hoisted(() => ({
  requests: [] as unknown[],
  signalsMock: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-memory-retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-memory-retrieval")>();
  return {
    ...actual,
    retrieveMemoryContext: (
      ...args: Parameters<typeof actual.retrieveMemoryContext>
    ): ReturnType<typeof actual.retrieveMemoryContext> => {
      requests.push(args[0]);
      return actual.retrieveMemoryContext(...args);
    },
  };
});

vi.mock("../memory-retrieval-signals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory-retrieval-signals.js")>();
  return { ...actual, buildConversationRetrievalSignals: signalsMock };
});

const { runMemoryProvider } = await import("./codingContextProviders.js");

const NOW_MS = 1_700_000_000_000;
const tmpDirs: string[] = [];
const vaults: MemoryVaultStore[] = [];

afterEach(() => {
  requests.length = 0;
  signalsMock.mockReset();
  for (const vault of vaults.splice(0)) vault.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function providerContext(): ProviderContext {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-cc-floor-"));
  tmpDirs.push(root);
  const vault = createMemoryVault({ memoryDir: join(root, "vault"), redactString: (s) => s });
  vaults.push(vault);
  vault.insertMemory({
    id: "floor-memory" as unknown as MemoryId,
    schemaVersion: "1",
    scope: { kind: "project", projectId: root as ProjectId },
    type: "preference",
    body: "Deploys happen on Tuesdays.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: NOW_MS,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: NOW_MS - 1000 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  } as unknown as MemoryRecord);
  return {
    deps: { env: {}, config: undefined, memoryVault: vault } as unknown as UiHandlerDeps,
    realRoot: root,
    fs: nodeWorkspaceFs,
    signal: new AbortController().signal,
    maxBytesPerExcerpt: 8192,
    currentTimeMs: () => NOW_MS,
    nowMs: NOW_MS,
  };
}

function lastRequest(): MemoryRetrievalRequest {
  return requests.at(-1) as MemoryRetrievalRequest;
}

describe("coding-context memory provider semantic floor (#4228)", () => {
  it("passes the floor with the semantic scores to retrieval", async () => {
    signalsMock.mockResolvedValue({
      strengthById: new Map(),
      embeddingById: new Map(),
      semanticById: new Map([["floor-memory" as unknown as MemoryId, 0.35]]),
      semanticMinScore: 0.4,
    });
    const outcome = await runMemoryProvider(providerContext(), { queryText: "Which formatter?" });
    expect(outcome.omission).toBeUndefined();
    expect(lastRequest().semanticMinScore).toBe(0.4);
    expect(lastRequest().semanticById?.size).toBe(1);
  });

  it("passes no floor field without semantic scores", async () => {
    signalsMock.mockResolvedValue({ strengthById: new Map(), embeddingById: new Map() });
    const outcome = await runMemoryProvider(providerContext(), { queryText: "Which formatter?" });
    expect(outcome.omission).toBeUndefined();
    expect("semanticMinScore" in lastRequest()).toBe(false);
    expect("semanticById" in lastRequest()).toBe(false);
  });
});
