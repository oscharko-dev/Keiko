import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationId,
  MemoryId,
  MemoryRecord,
  MemoryType,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { PROFILE_EXCLUDED_TAG } from "@oscharko-dev/keiko-memory-retrieval";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import { buildMemoryResult, type SendDesktopChatRequest } from "./chat-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { standingProfileForUser, standingProfileWire } from "./memory-profile.js";
import { createInMemoryUiStore } from "./store/index.js";

const USER = "local-operator" as UserId;
const NOW = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function vault(): MemoryVaultStore {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-memory-profile-")));
  const store = createMemoryVault({ memoryDir: root, redactString: (text) => text });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

interface Seed {
  readonly id: string;
  readonly body: string;
  readonly type?: MemoryType;
  readonly createdAt?: number;
  readonly pinned?: boolean;
  readonly tags?: readonly string[];
  readonly project?: boolean;
}

function seed(store: MemoryVaultStore, entry: Seed): void {
  const createdAt = entry.createdAt ?? NOW - 1_000;
  const record: MemoryRecord = {
    id: entry.id as MemoryId,
    schemaVersion: "1",
    scope: entry.project
      ? { kind: "project", projectId: "p1" as ProjectId }
      : { kind: "user", userId: USER },
    type: entry.type ?? "preference",
    body: entry.body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: createdAt,
      confidence: 1,
      sensitivity: "public",
    },
    validity: { validFrom: createdAt },
    status: "accepted",
    pinned: entry.pinned ?? false,
    tags: [...(entry.tags ?? [])],
    createdAt,
    updatedAt: createdAt,
  };
  store.insertMemory(record);
}

function profileIds(store: MemoryVaultStore): readonly string[] {
  return standingProfileForUser(store, USER, NOW).entries.map((entry) => String(entry.id));
}

describe("standingProfileForUser (#4228)", () => {
  it("keeps a stated preference beyond the newest-500 retrieval window", () => {
    const store = vault();
    seed(store, { id: "tables", body: "Bevorzugt Tabellen.", createdAt: NOW - 10_000_000 });
    for (let index = 0; index < 600; index += 1) {
      seed(store, {
        id: `fact-${String(index).padStart(4, "0")}`,
        body: `Projekt ${String(index)} läuft auf Kafka.`,
        type: index % 2 === 0 ? "semantic-fact" : "episodic",
        createdAt: NOW - 5_000 + index,
      });
    }
    expect(profileIds(store)).toEqual(["tables"]);
  });

  it("lets a pinned fact in, keeps an excluded fact out, and ignores project memory", () => {
    const store = vault();
    seed(store, { id: "episode", body: "Hat gestern Kafka konfiguriert.", type: "episodic" });
    seed(store, {
      id: "pinned-episode",
      body: "Arbeitet nur vormittags.",
      type: "episodic",
      pinned: true,
    });
    seed(store, { id: "excluded", body: "Mag lange Antworten.", tags: [PROFILE_EXCLUDED_TAG] });
    seed(store, { id: "project", body: "Das Team nutzt Jira.", project: true, pinned: true });
    expect(profileIds(store)).toEqual(["pinned-episode"]);
  });

  it("reads only as many bodies as the profile needs", () => {
    const store = vault();
    for (let index = 0; index < 200; index += 1) {
      seed(store, {
        id: `pref-${String(index).padStart(3, "0")}`,
        body: `Format ${String(index)}.`,
      });
    }
    const reads = vi.spyOn(store, "getMemory");
    expect(profileIds(store)).toHaveLength(8);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it("is empty for a person without standing facts", () => {
    const profile = standingProfileForUser(vault(), USER, NOW);
    expect(profile.entries).toEqual([]);
    expect(standingProfileWire(profile)).toEqual({ entries: [], tokens: 0 });
  });
});

describe("Chat memory with the standing profile (#4228)", () => {
  const ctx: ConversationMemoryRuntimeContext = {
    userId: USER,
    workspaceId: "w1" as WorkspaceId,
    projectId: "p1" as ProjectId,
    conversationId: "c1" as ConversationId,
  };

  function deps(store: MemoryVaultStore): UiHandlerDeps {
    return {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      store: createInMemoryUiStore(),
      memoryVault: store,
    };
  }

  function ask(content: string): SendDesktopChatRequest {
    return {
      content,
      memory: { enabled: true, budgetTokens: 1_200, context: {} },
    } as unknown as SendDesktopChatRequest;
  }

  function vaultWithTablesAndDog(): MemoryVaultStore {
    const store = vault();
    seed(store, { id: "tables", body: "Bevorzugt Tabellen, wenn du mir Zahlen zeigst." });
    seed(store, { id: "dog", body: "Der Hund der Person heißt Bello.", type: "semantic-fact" });
    return store;
  }

  it("gives an unrelated question the profile and no retrieved memory", async () => {
    const store = vaultWithTablesAndDog();
    const result = await buildMemoryResult(
      ask("Fasse mir die Quartalsergebnisse zusammen."),
      deps(store),
      ctx,
    );
    expect(result.context.memories).toEqual([]);
    expect(result.context.profile?.entries.map((entry) => entry.memoryId)).toEqual(["tables"]);
    expect(result.context.belowFloorCount).toBe(1);
  });

  it("gives a related question only the memory it is about, never a profile fact twice", async () => {
    const store = vaultWithTablesAndDog();
    const result = await buildMemoryResult(ask("Wie heißt mein Hund?"), deps(store), ctx);
    expect(result.context.memories.map((memory) => memory.memoryId)).toEqual(["dog"]);
    const tables = await buildMemoryResult(ask("Wie zeigst du mir Zahlen?"), deps(store), ctx);
    expect(tables.context.memories).toEqual([]);
    expect(tables.context.profile?.entries.map((entry) => entry.memoryId)).toEqual(["tables"]);
  });

  it("supplies nothing when memory is off for the Chat", async () => {
    const store = vaultWithTablesAndDog();
    const off = {
      content: "Wie heißt mein Hund?",
      memory: { enabled: false, budgetTokens: 1_200, context: {} },
    } as unknown as SendDesktopChatRequest;
    const result = await buildMemoryResult(off, deps(store), ctx);
    expect(result.context.profile).toBeUndefined();
    expect(result.context.memories).toEqual([]);
  });
});
