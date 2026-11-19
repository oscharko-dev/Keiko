import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { DEFAULT_STALE_CONFIDENCE_THRESHOLD } from "@oscharko-dev/keiko-memory-retrieval";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import { buildMemoryResult, type SendDesktopChatRequest } from "./chat-handlers.js";
import { memorySelectionLogFields } from "./chat-activity.js";
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
  readonly validFrom?: number;
  readonly provenance?: Pick<MemoryRecord["provenance"], "sensitivity" | "confidence">;
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
      ...entry.provenance,
    },
    validity: { validFrom: entry.validFrom ?? createdAt },
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

  it("joins overlapping profile sources and confirmations before taking the bounded window", () => {
    const store = vault();
    for (let index = 0; index < 96; index += 1) {
      seed(store, {
        id: `overlap-${String(index).padStart(3, "0")}`,
        body: "Use tables.",
        pinned: true,
        standing: true,
      });
    }
    // UTF-8 orders the private-use character ahead of the supplementary character; JavaScript
    // code-unit order puts the supplementary character first. Both fall on the eight-entry cutoff.
    for (const id of ["a-😀", "a-\uE000"])
      seed(store, { id, body: "Use tables.", pinned: true, standing: true });
    const confirmed = [
      "overlap-091",
      "overlap-092",
      "overlap-093",
      "overlap-094",
      "overlap-095",
      "overlap-083",
      "overlap-084",
    ].sort();
    store.recordAccess(confirmed as MemoryId[], NOW);
    const ranked = vi.spyOn(store, "listStandingProfileCandidates");
    const metadata = vi.spyOn(store, "listMemoryMetadataByScope");
    const counters = vi.spyOn(store, "getAccessStats");
    const records = vi.spyOn(store, "getMemory");
    expect(profileIds(store)).toEqual([...confirmed, "a-😀"]);
    expect(records.mock.calls.length).toBeLessThanOrEqual(16);
    expect(ranked).toHaveBeenCalledTimes(1);
    expect(ranked.mock.results[0]?.value).toHaveLength(64);
    expect(metadata).not.toHaveBeenCalled();
    expect(counters).not.toHaveBeenCalled();
  });

  it("keeps invalid SQL window sizes from reading an unbounded profile", () => {
    const store = vault();
    seed(store, { id: "pref", body: "Use tables." });
    for (const limit of [-1, 0, Number.NaN, 0.5]) {
      expect(
        store.listStandingProfileCandidates(USER, {
          types: ["preference"],
          minConfidenceExclusive: 0,
          nowMs: NOW,
          limit,
        }),
      ).toEqual([]);
    }
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

  it.each([
    { label: "future", validFrom: NOW + 1, sensitivity: "public", confidence: 1 },
    { label: "confidential", validFrom: NOW - 100, sensitivity: "confidential", confidence: 1 },
    {
      label: "threshold-confidence",
      validFrom: NOW - 100,
      sensitivity: "public",
      confidence: DEFAULT_STALE_CONFIDENCE_THRESHOLD,
    },
    {
      label: "below-threshold-confidence",
      validFrom: NOW - 100,
      sensitivity: "public",
      confidence: DEFAULT_STALE_CONFIDENCE_THRESHOLD / 2,
    },
  ] as const)(
    "does not spend the profile read bound on $label records",
    ({ validFrom, sensitivity, confidence }) => {
      const store = vault();
      seed(store, {
        id: "eligible",
        body: "Use tables.",
        createdAt: NOW - 10_000,
        validFrom: NOW,
        provenance: {
          confidence: DEFAULT_STALE_CONFIDENCE_THRESHOLD + Number.EPSILON,
          sensitivity: "public",
        },
      });
      for (let index = 0; index < 64; index += 1) {
        seed(store, {
          id: `skipped-${String(index)}`,
          body: `Synthetic fixture ${String(index)}.`,
          createdAt: NOW - 100 + index,
          pinned: true,
          validFrom,
          provenance: { sensitivity, confidence },
        });
      }

      const reads = vi.spyOn(store, "getMemory");
      const profile = standingProfileForUser(store, USER, NOW);
      expect([profile.entries.length, reads.mock.calls.length]).toEqual([1, 1]);
      expect(reads.mock.calls).toEqual([["eligible"]]);
      expect(standingProfileWire(profile).entries.map(({ memoryId }) => memoryId)).toEqual([
        "eligible",
      ]);
      expect(standingProfileWire(profile).droppedCount).toBe(0);
    },
  );

  it("keeps the body-read bound when the exclusion can only be seen in sealed tags", () => {
    const store = vault();
    seed(store, { id: "eligible", body: "Use tables.", createdAt: NOW - 10_000 });
    for (let index = 0; index < 63; index += 1) {
      seed(store, {
        id: `excluded-${String(index)}`,
        body: `Synthetic fixture ${String(index)}.`,
        createdAt: NOW - 100 + index,
        tags: [PROFILE_EXCLUDED_MEMORY_TAG],
      });
    }

    const reads = vi.spyOn(store, "getMemory");
    expect(profileIds(store)).toEqual(["eligible"]);
    expect(reads.mock.calls).toHaveLength(64);

    seed(store, {
      id: "excluded-last",
      body: "Another exclusion.",
      tags: [PROFILE_EXCLUDED_MEMORY_TAG],
    });
    reads.mockClear();
    const profile = standingProfileForUser(store, USER, NOW);
    expect(profile.entries).toEqual([]);
    expect(reads.mock.calls).toHaveLength(64);
    expect(standingProfileWire(profile).droppedCount).toBe(0);
  });

  it("is empty for a person without standing facts", () => {
    const profile = standingProfileForUser(vault(), USER, NOW);
    expect(profile.entries).toEqual([]);
    expect(standingProfileWire(profile)).toEqual({ entries: [], tokens: 0, droppedCount: 0 });
  });
});

describe("Chat memory with the standing profile (#4228)", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    // No embedder: lexical recall only, and no semantic floor is reported.
    expect("semanticFloor" in result.context).toBe(false);
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

  it("preserves the profile cap count when recall includes every selected profile line", async () => {
    const store = vault();
    const topics = ["Tabellen", "Balken", "Diagramme", "Listen", "Anlagen", "Stichpunkte"];
    const detail = " mit Legenden, Fußnoten, Einheiten und geeigneten Überschriften".repeat(4);
    for (const [index, topic] of topics.entries()) {
      seed(store, {
        id: topic,
        body: `Bevorzugt ${topic}${detail}.`,
        createdAt: NOW - 1_000 - index,
      });
    }
    const selected = standingProfileForUser(store, USER, Date.now());
    const before = standingProfileWire(selected);
    expect(before.entries.map((entry) => entry.memoryId)).toEqual(topics.slice(0, 5));
    expect(before.droppedCount).toBe(1);

    const result = await buildMemoryResult(ask(topics.slice(0, 5).join(" ")), deps(store), ctx);

    expect(result.context.profileRetrievedCount).toBe(5);
    expect(result.context.profile).toEqual({ entries: [], tokens: 0, droppedCount: 1 });
    expect(memorySelectionLogFields(result)).toMatchObject({
      profileEntryCount: 0,
      profileDroppedCount: 1,
      profileRetrievedCount: 5,
    });
  });

  it("answers a question about a corrected preference with the correction, never the old value", async () => {
    // Lab 2026-11-11 (Gemma, update-lists-de) end to end: the correction shares no word with the
    // question; the fact it superseded does.
    const store = vault();
    seed(store, { id: "tables", body: "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst." });
    const before = store.getMemory("tables" as MemoryId);
    if (before === undefined) throw new Error("seed missing");
    store.updateMemory(
      "tables" as MemoryId,
      { provenance: { ...before.provenance, evidenceSpan: before.body } },
      NOW - 900,
    );
    const learned = store.getMemory("tables" as MemoryId);
    if (learned === undefined) throw new Error("seed missing");
    applyLearnedSupersession(
      store,
      {
        ...learned,
        id: "lists" as MemoryId,
        body: "Ab jetzt bevorzuge ich Listen.",
        createdAt: NOW - 800,
        updatedAt: NOW - 800,
      },
      learned.id,
      { status: learned.status, updatedAt: learned.updatedAt },
    );
    expect(store.getMemory("tables" as MemoryId)?.status).toBe("superseded");
    const result = await buildMemoryResult(
      ask("Wie sollst du mir Zahlen zeigen?"),
      deps(store),
      ctx,
    );
    expect(result.context.memories.map((memory) => memory.memoryId)).toEqual(["lists"]);
    expect(result.context.profile).toBeUndefined();
    expect(result.context.profileRetrievedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("Tabellen");

    // The same history answers a question about the past, labelled as replaced (#4223).
    const past = await buildMemoryResult(
      ask("Wie wolltest du mir Zahlen früher zeigen?"),
      deps(store),
      ctx,
    );
    expect(past.context.memories.map((memory) => memory.memoryId)).toEqual(["lists"]);
    expect(past.context.memories[0]?.earlierValues).toEqual([
      "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.",
    ]);
  });

  it("keeps the profile line when recall could send only a shorter excerpt", async () => {
    const store = vault();
    const long =
      "Bevorzugt Tabellen mit Spaltenköpfen, Einheiten und Summenzeile, wenn du mir Zahlen zeigst.";
    seed(store, { id: "tables", body: long });
    const askWithBudget = (budgetTokens: number): ReturnType<typeof buildMemoryResult> =>
      buildMemoryResult(
        {
          content: "Wie zeigst du mir Zahlen?",
          memory: { enabled: true, budgetTokens, context: {} },
        } as unknown as SendDesktopChatRequest,
        deps(store),
        ctx,
      );
    // The profile line costs 16 tokens. Recall renders its reason beside the excerpt, and the
    // truthful "lexical relevance" reason is longer than the "pinned memory" label an unpinned
    // fact used to carry, so a partial excerpt needs 20 tokens of recall budget.
    const result = await askWithBudget(36);
    const excerpt = result.context.memories[0]?.bodyExcerpt ?? "";
    const line = result.context.profile?.entries[0]?.text ?? "";
    // Recall had room only for part of the fact, so its full profile line stays.
    expect(excerpt.length).toBeGreaterThan(0);
    expect(excerpt.length).toBeLessThan(long.length);
    expect(line).toBe(long);
    // With no room for any excerpt the fact still reaches the answer whole, through the profile.
    const tight = await askWithBudget(30);
    expect(tight.context.memories).toEqual([]);
    expect(tight.context.profile?.entries[0]?.text).toBe(long);
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
