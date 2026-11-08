import { describe, expect, it } from "vitest";

import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { RetrievalError } from "./errors.js";
import { sharedInformativeWordCount } from "./relevance.js";
import { retrieveMemoryContext } from "./retrieve.js";
import type { MemoryQueryPort, MemoryRetrievalRequest } from "./types.js";
import { buildRecord, memoryId, userScope, type BuildRecordOptions } from "./_support.js";

const NOW = 7 * 86_400_000;

function record(id: string, body: string, options: BuildRecordOptions = {}): MemoryRecord {
  return buildRecord({ id, body, status: "accepted", type: "preference", ...options });
}

function port(records: readonly MemoryRecord[]): MemoryQueryPort {
  return { listByScope: () => records };
}

function strict(
  queryText: string | undefined,
  overrides: Partial<MemoryRetrievalRequest> = {},
): MemoryRetrievalRequest {
  return {
    scopes: [userScope()],
    nowMs: NOW,
    strictRelevanceFloor: true,
    ...(queryText === undefined ? {} : { queryText }),
    ...overrides,
  };
}

function included(request: MemoryRetrievalRequest, records: readonly MemoryRecord[]): string[] {
  return retrieveMemoryContext(request, port(records)).included.map((entry) => entry.memoryId);
}

// Question, memory, and whether the memory is about the question. A shared pronoun, modal verb or
// politeness word is not a topic; a shared noun is, including a short inflection.
const PAIRS: readonly (readonly [string, string, boolean])[] = [
  ["Wie sollst du mir Zahlen zeigen?", "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.", true],
  ["Erstelle eine Tabelle der Umsätze.", "Ich bevorzuge Tabellen.", true],
  ["Which language do I use for Atlas?", "I write Atlas in Rust.", true],
  ["Was weißt du über meinen Hund?", "Der Hund der Person heißt Bello.", true],
  ["Wann ist mein Urlaub?", "Mein Urlaub beginnt am 3. Juli.", true],
  ["Please answer in German.", "I prefer answers in German.", true],
  ["Wie konfiguriere ich einen Kafka Consumer?", "Ich betreue den Kafka-Cluster der Bank.", true],
  [
    "Fasse mir die Quartalsergebnisse zusammen.",
    "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.",
    false,
  ],
  ["Wie konfiguriere ich Kafka?", "Ich bevorzuge Tabellen.", false],
  ["Kannst du mir bitte helfen?", "Ich trinke gerne Tee.", false],
  ["What is the weather like today?", "I write Atlas in Rust.", false],
  ["Bitte schreib mir eine E-Mail an den Kunden.", "Mein Hund heißt Bello.", false],
  ["Erkläre mir Docker.", "Ich nutze immer Numbers für Tabellen.", false],
  ["Wann ist das Meeting?", "Wann immer möglich, antworte kurz.", false],
  ["Could you please help me with this?", "You should always answer in short sentences.", false],
];

describe("sharedInformativeWordCount", () => {
  it.each(PAIRS)("%s / %s → related=%s", (question, body, related) => {
    const shared = sharedInformativeWordCount(question, record("m", body));
    if (related) expect(shared).toBeGreaterThanOrEqual(1);
    else expect(shared).toBe(0);
  });

  it("does not read the record's tags", () => {
    const tagged = record("m", "Ich bevorzuge Tabellen.", { tags: ["kafka"] });
    expect(sharedInformativeWordCount("Wie konfiguriere ich Kafka?", tagged)).toBe(0);
  });

  it("returns zero without a question", () => {
    expect(sharedInformativeWordCount(undefined, record("m", "Tabellen"))).toBe(0);
    expect(sharedInformativeWordCount("", record("m", "Tabellen"))).toBe(0);
  });
});

describe("retrieveMemoryContext with the strict relevance floor", () => {
  const tables = record("tables", "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.");
  const pinned = record("pinned", "Antworte immer auf Deutsch.", { pinned: true });
  const correction = record("correction", "Mein Name ist Ana, nicht Anna.", {
    type: "correction",
    sourceKind: "accepted-correction",
  });
  const dog = record("dog", "Der Hund der Person heißt Bello.");
  const vault = [tables, pinned, correction, dog];

  it("retrieves nothing for an unrelated question, pinned and corrections included", () => {
    const result = retrieveMemoryContext(
      strict("Fasse mir die Quartalsergebnisse zusammen."),
      port(vault),
    );
    expect(result.included).toEqual([]);
    expect(result.omitted.filter((entry) => entry.reason === "below-threshold")).toHaveLength(4);
  });

  it("retrieves only the memories the question is about", () => {
    expect(included(strict("Wie sollst du mir Zahlen zeigen?"), vault)).toEqual(["tables"]);
    expect(included(strict("Wie heißt mein Hund?"), vault)).toEqual(["dog"]);
  });

  it("retrieves nothing without a query signal", () => {
    expect(included(strict(undefined), vault)).toEqual([]);
    expect(included(strict("?!"), vault)).toEqual([]);
  });

  it("admits a semantic match above the floor without a shared word", () => {
    const semanticById = new Map([
      [memoryId("tables"), 0.8],
      [memoryId("dog"), 0.1],
    ]);
    expect(included(strict("Quartalsergebnisse bitte", { semanticById }), vault)).toEqual([
      "tables",
    ]);
  });

  it("can require more than one shared word", () => {
    const request = strict("Wie sollst du mir Zahlen zeigen?", { lexicalMinSharedWords: 2 });
    expect(included(request, vault)).toEqual([]);
  });

  it("never retrieves a memory already supplied as the standing profile", () => {
    const result = retrieveMemoryContext(
      strict("Wie sollst du mir Zahlen zeigen?", { excludeMemoryIds: new Set([tables.id]) }),
      port(vault),
    );
    expect(result.included).toEqual([]);
    expect(result.omitted).toContainEqual({ memoryId: tables.id, reason: "standing-profile" });
  });

  it("keeps the permissive floor for callers that do not opt in", () => {
    const permissive = included(
      {
        scopes: [userScope()],
        nowMs: NOW,
        queryText: "Fasse mir die Quartalsergebnisse zusammen.",
      },
      vault,
    );
    expect(permissive).toContain("pinned");
    expect(permissive).toContain("tables");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects lexicalMinSharedWords=%s", (value) => {
    expect(() =>
      retrieveMemoryContext(strict("Zahlen", { lexicalMinSharedWords: value }), port(vault)),
    ).toThrow(RetrievalError);
  });
});
