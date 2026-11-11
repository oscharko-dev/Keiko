import { describe, expect, it } from "vitest";

import type { MemoryEdge, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { RetrievalError } from "./errors.js";
import { sharedInformativeWordCount } from "./relevance.js";
import { retrieveMemoryContext } from "./retrieve.js";
import type { MemoryQueryPort, MemoryRetrievalRequest } from "./types.js";
import {
  buildEdge,
  buildRecord,
  memoryId,
  userScope,
  type BuildRecordOptions,
} from "./_support.js";

const NOW = 7 * 86_400_000;

function record(id: string, body: string, options: BuildRecordOptions = {}): MemoryRecord {
  return buildRecord({ id, body, status: "accepted", type: "preference", ...options });
}

function port(records: readonly MemoryRecord[]): MemoryQueryPort {
  return { listByScope: () => records };
}

function edgedPort(
  records: readonly MemoryRecord[],
  edges: readonly MemoryEdge[],
): MemoryQueryPort {
  const incident = (id: string): readonly MemoryEdge[] =>
    edges.filter((edge) => edge.fromMemoryId === id || edge.toMemoryId === id);
  return {
    listByScope: () => records,
    listEdgesForMemories: (ids) => new Map(ids.map((id) => [id, incident(id)])),
  };
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
  ["Erkläre etwas über Rust.", "Ich schreibe über Kafka.", false],
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

describe("the strict floor and corrections (#4228, lab 2026-11-11)", () => {
  // The failure this pins (Gemma via LiteLLM, update-lists-de): the person corrected "Ich bevorzuge
  // Tabellen, wenn du mir Zahlen zeigst." with "Ab jetzt bevorzuge ich Listen.", and the question
  // "Wie sollst du mir Zahlen zeigen?" shares no word with the correction itself.
  const tables = record("tables", "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.", {
    status: "superseded",
  });
  const lists = record("lists", "Ab jetzt bevorzuge ich Listen.");
  const supersedes = buildEdge({ from: "tables", to: "lists", kind: "supersedes" });

  // Every current fact here is a standing profile fact unless a test says otherwise.
  function retrieved(
    records: readonly MemoryRecord[],
    edges: readonly MemoryEdge[],
    queryText = "Wie sollst du mir Zahlen zeigen?",
    profile: readonly string[] = records.map((entry) => entry.id),
  ): string[] {
    const request = strict(queryText, { standingProfileIds: new Set(profile.map(memoryId)) });
    return retrieveMemoryContext(request, edgedPort(records, edges)).included.map(
      (entry) => entry.memoryId,
    );
  }

  function chain(length: number): { records: MemoryRecord[]; edges: MemoryEdge[] } {
    // g0 named the topic; g1..g(length-1) each corrected the one before; the last is current.
    const records = Array.from({ length }, (_, index) =>
      record(`g${String(index)}`, index === 0 ? tables.body : `Format Nummer ${String(index)}.`, {
        status: index === length - 1 ? "accepted" : "superseded",
      }),
    );
    const edges = records
      .slice(1)
      .map((entry, index) =>
        buildEdge({ from: `g${String(index)}`, to: entry.id, kind: "supersedes" }),
      );
    return { records, edges };
  }

  it("lets a correction answer a question about the fact it superseded, never the old fact", () => {
    expect(retrieved([tables, lists], [supersedes])).toEqual(["lists"]);
  });

  it("does not read the corrected fact's words without the supersession", () => {
    expect(retrieved([tables, lists], [])).toEqual([]);
    const related = buildEdge({ from: "tables", to: "lists", kind: "related" });
    expect(retrieved([tables, lists], [related])).toEqual([]);
  });

  it("follows a chain of corrections back to the fact that named the topic", () => {
    const listsBefore = record("lists", "Ab jetzt bevorzuge ich Listen.", { status: "superseded" });
    const prose = record("prose", "Jetzt doch lieber Fließtext.");
    const chain = [supersedes, buildEdge({ from: "lists", to: "prose", kind: "supersedes" })];
    expect(retrieved([tables, listsBefore, prose], chain)).toEqual(["prose"]);
  });

  it("stops four corrections back", () => {
    const four = chain(5);
    expect(retrieved(four.records, four.edges)).toEqual(["g4"]);
    const five = chain(6);
    expect(retrieved(five.records, five.edges)).toEqual([]);
  });

  it("ends a cycle of supersessions", () => {
    const back = buildEdge({ id: "back", from: "lists", to: "tables", kind: "supersedes" });
    expect(retrieved([tables, lists], [supersedes, back])).toEqual(["lists"]);
  });

  it("lends a fact two corrections superseded to both", () => {
    const tablesKept = record("charts", "Ab jetzt bevorzuge ich Diagramme.");
    const both = [supersedes, buildEdge({ from: "tables", to: "charts", kind: "supersedes" })];
    expect(retrieved([tables, lists, tablesKept], both).sort()).toEqual(["charts", "lists"]);
  });

  it("lends no words to a memory outside the standing profile", () => {
    // Such a memory keeps its semantic match; inherited words would pull a current fact into a
    // question that only names its old value.
    const siemens = record("siemens", "Ich arbeite bei Siemens.", { status: "superseded" });
    const bosch = record("bosch", "Ich arbeite jetzt bei Bosch.", { type: "semantic-fact" });
    const moved = buildEdge({ from: "siemens", to: "bosch", kind: "supersedes" });
    expect(retrieved([siemens, bosch], [moved], "Was macht Siemens eigentlich?", [])).toEqual([]);
    expect(retrieved([tables, lists], [supersedes], undefined, [])).toEqual([]);
  });

  it("takes no words from a forgotten predecessor", () => {
    const forgotten = record("tables", tables.body, { status: "forgotten" });
    expect(retrieved([forgotten, lists], [supersedes])).toEqual([]);
  });

  it("retrieves a profile fact on the question's words, never on semantic similarity alone", () => {
    // The profile supplies the fact anyway; retrieval would only claim the question is about it.
    // "Welche Farbe mag ich am liebsten?" and a table preference scored 0.47 with qwen3-embedding,
    // above the 0.40 of the correction the question really was about, so no threshold separates them.
    const preference = record("pref", "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.");
    const semanticById = new Map([[memoryId("pref"), 0.47]]);
    const profile = new Set([memoryId("pref")]);
    const colour = strict("Welche Farbe mag ich am liebsten?", { semanticById });
    expect(included(colour, [preference])).toEqual(["pref"]);
    expect(included({ ...colour, standingProfileIds: profile }, [preference])).toEqual([]);
    const numbers = strict("Wie sollst du mir Zahlen zeigen?", {
      semanticById,
      standingProfileIds: profile,
    });
    expect(included(numbers, [preference])).toEqual(["pref"]);
  });
});
