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
import {
  PROFILE_EXCLUDED_MEMORY_TAG,
  STANDING_FACT_RETENTION_POLICY_KEY,
} from "@oscharko-dev/keiko-contracts/runtime/memory";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import { buildMemoryResult, type SendDesktopChatRequest } from "./chat-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { applyLearnedSupersession } from "./memory-learned-facts.js";
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
  readonly status?: MemoryRecord["status"];
  readonly standing?: boolean;
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
    status: entry.status ?? "accepted",
    pinned: entry.pinned ?? false,
    tags: [...(entry.tags ?? [])],
    createdAt,
    updatedAt: createdAt,
    ...(entry.standing === true
      ? { retentionHint: { policyKey: STANDING_FACT_RETENTION_POLICY_KEY } }
      : {}),
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
    seed(store, {
      id: "excluded",
      body: "Mag lange Antworten.",
      tags: [PROFILE_EXCLUDED_MEMORY_TAG],
    });
    seed(store, { id: "project", body: "Das Team nutzt Jira.", project: true, pinned: true });
    expect(profileIds(store)).toEqual(["pinned-episode"]);
  });

  it("keeps a fact capture marked standing beyond the newest-500 retrieval window", () => {
    const store = vault();
    seed(store, {
      id: "role",
      body: "Ist Backend-Entwicklerin.",
      type: "semantic-fact",
      standing: true,
      createdAt: NOW - 10_000_000,
    });
    for (let index = 0; index < 600; index += 1) {
      seed(store, {
        id: `fact-${String(index).padStart(4, "0")}`,
        body: `Projekt ${String(index)} läuft auf Kafka.`,
        type: "semantic-fact",
        createdAt: NOW - 5_000 + index,
      });
    }
    expect(profileIds(store)).toEqual(["role"]);
  });

  it("keeps a learned role in the profile when the learner replaces it", () => {
    const store = vault();
    seed(store, {
      id: "role",
      body: "Ist Analystin.",
      type: "semantic-fact",
      standing: true,
      createdAt: NOW - 9,
    });
    const before = store.getMemory("role" as MemoryId);
    if (before === undefined) throw new Error("seed missing");
    // A learned fact carries its evidence; only such a fact gives way to the learner.
    store.updateMemory(
      "role" as MemoryId,
      { provenance: { ...before.provenance, evidenceSpan: "Ich bin Analystin" } },
      NOW - 8,
    );
    const learned = store.getMemory("role" as MemoryId);
    if (learned === undefined) throw new Error("seed missing");
    const replacement: MemoryRecord = {
      ...learned,
      id: "lead" as MemoryId,
      body: "Ist jetzt Teamleiterin.",
      createdAt: NOW - 5,
      updatedAt: NOW - 5,
    };
    const { retentionHint: _dropped, ...unmarked } = replacement;
    applyLearnedSupersession(store, unmarked, learned.id, {
      status: learned.status,
      updatedAt: learned.updatedAt,
    });
    expect(store.getMemory("role" as MemoryId)?.status).toBe("superseded");
    expect(profileIds(store)).toEqual(["lead"]);
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
    expect(standingProfileWire(profile)).toEqual({ entries: [], tokens: 0, droppedCount: 0 });
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
      modelPortFactory: (): undefined => undefined,
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
    expect(result.context.profile?.entries.map((entry) => entry.memoryId)).toEqual(["tables"]);
    expect(result.context.profileRetrievedCount).toBeUndefined();
  });

  it("sends a profile fact the question is about with the retrieved memories, once", async () => {
    // The failure this pins (lab 2026-11-11, Gemma, update-lists-de): "Wie sollst du mir Zahlen
    // zeigen?" received the preference only as a profile line, and the model missed it in two of
    // three runs; dev, which retrieved it, answered all three.
    const store = vaultWithTablesAndDog();
    const tables = await buildMemoryResult(ask("Wie zeigst du mir Zahlen?"), deps(store), ctx);
    expect(tables.context.memories.map((memory) => memory.memoryId)).toEqual(["tables"]);
    expect(tables.context.profile).toBeUndefined();
    expect(tables.context.profileRetrievedCount).toBe(1);
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
