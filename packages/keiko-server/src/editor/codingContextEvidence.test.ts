import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore, listEvidence } from "@oscharko-dev/keiko-evidence";
import type { CodingContextWirePack, EvidenceStore } from "@oscharko-dev/keiko-contracts";
import {
  codingContextEvidenceRunId,
  recordCodingContextEvidence,
} from "./codingContextEvidence.js";

const identity = (value: unknown): unknown => value;

function wirePack(overrides: Partial<CodingContextWirePack> = {}): CodingContextWirePack {
  return {
    schemaVersion: "1",
    purpose: "completion",
    entries: [
      {
        sourceKind: "repo-search",
        sourceTier: "first-party-workspace",
        id: "a-1",
        score: 0.9,
        rank: 0,
        citationRef: "foo.ts",
        byteCount: 128,
        truncated: false,
      },
      {
        sourceKind: "local-knowledge",
        sourceTier: "indexed-knowledge",
        id: "chunk-7",
        score: 0.7,
        rank: 1,
        citationRef: "design.pdf",
        byteCount: 64,
        truncated: true,
      },
    ],
    usedBytes: 192,
    budgetBytes: 32_768,
    droppedForBudget: 1,
    omissions: [{ sourceKind: "memory", reason: "unavailable" }],
    ...overrides,
  };
}

describe("codingContextEvidenceRunId", () => {
  it("is deterministic for the same pack and time", () => {
    expect(codingContextEvidenceRunId(wirePack(), 1_700_000_000_000)).toBe(
      codingContextEvidenceRunId(wirePack(), 1_700_000_000_000),
    );
  });

  it("differs when the citations differ", () => {
    const a = codingContextEvidenceRunId(wirePack(), 1_700_000_000_000);
    const b = codingContextEvidenceRunId(wirePack({ entries: [] }), 1_700_000_000_000);
    expect(a).not.toBe(b);
  });
});

describe("recordCodingContextEvidence", () => {
  it("persists a content-free record retrievable by run id", () => {
    const store = createInMemoryEvidenceStore();
    const runId = recordCodingContextEvidence(store, identity, wirePack(), 1_700_000_000_000);
    const json = store.get(runId);
    expect(json).toBeDefined();
    const manifest = JSON.parse(json ?? "{}") as Record<string, unknown>;
    expect(manifest.codingContextSchemaVersion).toBe("1");
    expect(manifest.evidenceSchemaVersion).toBeUndefined();
    expect((manifest.tierCounts as Record<string, number>)["first-party-workspace"]).toBe(1);
    expect((manifest.tierCounts as Record<string, number>)["indexed-knowledge"]).toBe(1);
  });

  it("does not pollute the grounded/QI evidence index", () => {
    const store = createInMemoryEvidenceStore();
    recordCodingContextEvidence(store, identity, wirePack(), 1_700_000_000_000);
    // listEvidence requires evidenceSchemaVersion; the coding-context record omits it and is skipped.
    expect(listEvidence(store)).toHaveLength(0);
  });

  it("never throws when persistence fails", () => {
    const failingStore: EvidenceStore = {
      put: (): string => {
        throw new Error("disk full");
      },
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    };
    expect(() =>
      recordCodingContextEvidence(failingStore, identity, wirePack(), 1_700_000_000_000),
    ).not.toThrow();
  });
});
