import { describe, expect, it } from "vitest";

import type { MemoryEdge, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { retrieveMemoryContext } from "./retrieve.js";
import type { MemoryQueryPort, MemoryRetrievalRequest } from "./types.js";
import {
  buildEdge,
  buildRecord,
  memoryId,
  projectScope,
  userScope,
  type BuildRecordOptions,
} from "./_support.js";

// A recalled fact carries the values it replaced (#4223): a corrected fact keeps its superseded
// values as history, and only they answer "what did I tell you before?".

const NOW = 7 * 86_400_000;
const DAY = 86_400_000;

function fact(id: string, body: string, options: BuildRecordOptions = {}): MemoryRecord {
  return buildRecord({ id, body, type: "preference", updatedAt: NOW - DAY, ...options });
}

function supersedes(from: string, to: string): MemoryEdge {
  return buildEdge({ from, to, kind: "supersedes" });
}

// Vault-shaped: the list read leaves history out, a record is fetched by id whatever its status.
function vaultPort(
  records: readonly MemoryRecord[],
  edges: readonly MemoryEdge[],
): MemoryQueryPort {
  const incident = (id: string): readonly MemoryEdge[] =>
    edges.filter((edge) => edge.fromMemoryId === id || edge.toMemoryId === id);
  return {
    listByScope: (scope) =>
      records.filter(
        (record) =>
          record.status !== "superseded" && JSON.stringify(record.scope) === JSON.stringify(scope),
      ),
    getMemory: (id) => records.find((record) => record.id === id),
    listEdgesForMemories: (ids) => new Map(ids.map((id) => [id, incident(id)])),
  };
}

function request(overrides: Partial<MemoryRetrievalRequest> = {}): MemoryRetrievalRequest {
  return { scopes: [userScope()], nowMs: NOW, queryText: "Zahlen Tabellen vorher", ...overrides };
}

const tablesOld = fact("tables-old", "Ich bevorzuge Tabellen mit Summenzeile für Zahlen.", {
  status: "superseded",
  updatedAt: NOW - 60 * DAY,
});
const lists = fact("lists", "Ab jetzt bevorzuge ich Listen mit Nummerierung für Zahlen.", {
  status: "superseded",
  updatedAt: NOW - 30 * DAY,
});
const tablesNow = fact("tables-now", "Ich bevorzuge Tabellen mit Summenzeile für Zahlen.");
const returned = [tablesOld, lists, tablesNow];
const returnEdges = [supersedes("tables-old", "lists"), supersedes("lists", "tables-now")];

describe("earlier values of a recalled memory (#4223)", () => {
  it("carries the values a fact replaced, nearest first and labelled as replaced", () => {
    const result = retrieveMemoryContext(request(), vaultPort(returned, returnEdges));
    const [entry] = result.contextBlock.memories;
    expect(entry?.memoryId).toBe(memoryId("tables-now"));
    expect(entry?.earlierValues).toEqual([lists.body, tablesOld.body]);
    expect(result.contextBlock.text).toBe(
      [
        "# Relevant memories",
        `- (${entry?.inclusionReason ?? ""}) ${tablesNow.body}`,
        `  - earlier value, since replaced: ${lists.body}`,
        `  - earlier value, since replaced: ${tablesOld.body}`,
      ].join("\n"),
    );
    // History is shown with the fact, never recalled as a memory of its own.
    expect(result.included.map((included) => included.memoryId)).toEqual([memoryId("tables-now")]);
  });

  it("keeps history out of an answer about the present", () => {
    const result = retrieveMemoryContext(
      request({ queryText: "Wie sollst du mir Zahlen zeigen, Tabellen?" }),
      vaultPort(returned, returnEdges),
    );
    expect(result.contextBlock.memories[0]?.memoryId).toBe(memoryId("tables-now"));
    expect(result.contextBlock.memories[0]?.earlierValues).toBeUndefined();
    expect(result.contextBlock.text).not.toContain("Listen");
  });

  it("carries at most the two nearest values of a long lineage", () => {
    const oldest = fact("oldest", "Zuerst wollte ich Zahlen als Fließtext.", {
      status: "superseded",
      updatedAt: NOW - 90 * DAY,
    });
    const result = retrieveMemoryContext(
      request(),
      vaultPort([oldest, ...returned], [supersedes("oldest", "tables-old"), ...returnEdges]),
    );
    expect(result.contextBlock.memories[0]?.earlierValues).toEqual([lists.body, tablesOld.body]);
  });

  it("shows only superseded history of the memory's own scope and of an admitted type", () => {
    const foreign = fact("foreign", "Im Projekt zeigen wir Zahlen als Diagramm.", {
      status: "superseded",
      scope: projectScope(),
    });
    const rejected = fact("rejected", "Zahlen bitte als Kreisdiagramm.", { status: "rejected" });
    const procedure = fact("procedure", "Zahlen immer runden.", {
      status: "superseded",
      type: "procedural",
    });
    const current = fact("current", "Ich will Zahlen als Tabellen sehen.");
    const port = vaultPort(
      [foreign, rejected, procedure, current],
      [
        supersedes("foreign", "current"),
        supersedes("rejected", "current"),
        supersedes("procedure", "current"),
      ],
    );
    const result = retrieveMemoryContext(request({ types: ["preference"] }), port);
    expect(result.contextBlock.memories[0]?.memoryId).toBe(memoryId("current"));
    expect(result.contextBlock.memories[0]?.earlierValues).toBeUndefined();
    const anyType = retrieveMemoryContext(request(), port);
    expect(anyType.contextBlock.memories[0]?.earlierValues).toEqual([procedure.body]);
  });

  it("ends a cycle of supersedes edges", () => {
    const a = fact("a", "Zahlen als Tabellen.", { status: "superseded" });
    const b = fact("b", "Zahlen als Tabellen mit Summe.");
    const result = retrieveMemoryContext(
      request(),
      vaultPort([a, b], [supersedes("a", "b"), supersedes("b", "a")]),
    );
    expect(result.contextBlock.memories[0]?.earlierValues).toEqual([a.body]);
  });

  it("keeps history inside the entry's own share, never taking budget from another memory", () => {
    const other = fact("other", "Zahlen zeige ich gern mit Tausenderpunkt.", {
      updatedAt: NOW - 2 * DAY,
    });
    const records = [...returned, other];
    const tight = { budgetTokens: 30, maxIncluded: 2 };
    const withHistory = retrieveMemoryContext(request(tight), vaultPort(records, returnEdges));
    const withoutHistory = retrieveMemoryContext(request(tight), vaultPort(records, []));
    expect(withHistory.included.map((entry) => entry.memoryId)).toEqual(
      withoutHistory.included.map((entry) => entry.memoryId),
    );
    expect(withHistory.contextBlock.memories.map((entry) => entry.bodyExcerpt)).toEqual(
      withoutHistory.contextBlock.memories.map((entry) => entry.bodyExcerpt),
    );
    expect(withHistory.contextBlock.memories[0]?.earlierValues).toBeUndefined();
    expect(withHistory.budget.used).toBeLessThanOrEqual(30);
  });

  it("shows no history through a port without edges", () => {
    const port: MemoryQueryPort = {
      listByScope: () => [tablesNow],
      getMemory: (id) => returned.find((record) => record.id === id),
    };
    const result = retrieveMemoryContext(request(), port);
    expect(result.contextBlock.memories[0]?.earlierValues).toBeUndefined();
  });
});
