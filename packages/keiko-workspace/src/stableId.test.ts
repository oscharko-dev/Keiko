import { describe, expect, it } from "vitest";
import type {
  ConnectedContextPackStableIdInput,
  EvidenceAtomStableIdInput,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  connectedContextPackStableId,
  evidenceAtomStableId,
  importEdgeStableId,
  symbolGraphRecordStableId,
} from "./stableId.js";

function atomInput(overrides: Partial<EvidenceAtomStableIdInput> = {}): EvidenceAtomStableIdInput {
  return {
    scopeId: "scope-1",
    scopePath: "src/foo.ts",
    lineRange: { startLine: 1, endLine: 1 },
    provenanceKind: "lexical-search",
    provenanceTool: "repo.searchText",
    queryFingerprint: "abc123",
    ...overrides,
  };
}

function packInput(
  overrides: Partial<ConnectedContextPackStableIdInput> = {},
): ConnectedContextPackStableIdInput {
  return {
    scopeId: "scope-1",
    queryKind: "natural-language",
    queryText: "find me bugs",
    atomStableIds: ["a-aaa", "a-bbb"],
    ...overrides,
  };
}

describe("evidenceAtomStableId", () => {
  it("is deterministic across invocations", () => {
    expect(evidenceAtomStableId(atomInput())).toBe(evidenceAtomStableId(atomInput()));
  });

  it("produces the same ID regardless of object-key order in the input literal", () => {
    const a: EvidenceAtomStableIdInput = {
      scopeId: "s",
      scopePath: "p",
      lineRange: undefined,
      provenanceKind: "lexical-search",
      provenanceTool: "t",
      queryFingerprint: "f",
    };
    const b: EvidenceAtomStableIdInput = {
      queryFingerprint: "f",
      provenanceTool: "t",
      provenanceKind: "lexical-search",
      lineRange: undefined,
      scopePath: "p",
      scopeId: "s",
    };
    expect(evidenceAtomStableId(a)).toBe(evidenceAtomStableId(b));
  });

  it("changes when scopeId changes", () => {
    expect(evidenceAtomStableId(atomInput())).not.toBe(
      evidenceAtomStableId(atomInput({ scopeId: "scope-2" })),
    );
  });

  it("changes when scopePath changes", () => {
    expect(evidenceAtomStableId(atomInput())).not.toBe(
      evidenceAtomStableId(atomInput({ scopePath: "src/bar.ts" })),
    );
  });

  it("changes when queryFingerprint changes", () => {
    expect(evidenceAtomStableId(atomInput())).not.toBe(
      evidenceAtomStableId(atomInput({ queryFingerprint: "different" })),
    );
  });

  it("distinguishes undefined lineRange from a concrete one", () => {
    const withoutRange = evidenceAtomStableId(atomInput({ lineRange: undefined }));
    const withRange = evidenceAtomStableId(atomInput({ lineRange: { startLine: 1, endLine: 1 } }));
    expect(withoutRange).not.toBe(withRange);
  });

  it("returns the 'a-' prefix", () => {
    expect(evidenceAtomStableId(atomInput()).startsWith("a-")).toBe(true);
  });

  it("returns a 66-character string", () => {
    expect(evidenceAtomStableId(atomInput()).length).toBe(66);
  });

  it("returns lowercase hex characters after the prefix", () => {
    expect(evidenceAtomStableId(atomInput()).slice(2)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("connectedContextPackStableId", () => {
  it("is deterministic across invocations", () => {
    expect(connectedContextPackStableId(packInput())).toBe(
      connectedContextPackStableId(packInput()),
    );
  });

  it("is independent of atomStableIds order", () => {
    expect(connectedContextPackStableId(packInput({ atomStableIds: ["a-aaa", "a-bbb"] }))).toBe(
      connectedContextPackStableId(packInput({ atomStableIds: ["a-bbb", "a-aaa"] })),
    );
  });

  it("changes when queryText changes", () => {
    expect(connectedContextPackStableId(packInput())).not.toBe(
      connectedContextPackStableId(packInput({ queryText: "other" })),
    );
  });

  it("changes when an atom is added", () => {
    expect(connectedContextPackStableId(packInput())).not.toBe(
      connectedContextPackStableId(packInput({ atomStableIds: ["a-aaa", "a-bbb", "a-ccc"] })),
    );
  });

  it("returns the 'p-' prefix and 66 chars", () => {
    const id = connectedContextPackStableId(packInput());
    expect(id.startsWith("p-")).toBe(true);
    expect(id.length).toBe(66);
  });

  it("returns lowercase hex characters after the prefix", () => {
    expect(connectedContextPackStableId(packInput()).slice(2)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles an empty atomStableIds list deterministically", () => {
    expect(connectedContextPackStableId(packInput({ atomStableIds: [] }))).toBe(
      connectedContextPackStableId(packInput({ atomStableIds: [] })),
    );
  });
});

describe("importEdgeStableId", () => {
  const input = {
    importerPath: "src/a.ts",
    specifier: "./b",
    targetPath: "src/b.ts",
    kind: "static-import",
    line: 1,
    ordinal: 0,
  };

  it("is deterministic across invocations", () => {
    expect(importEdgeStableId(input)).toBe(importEdgeStableId(input));
  });

  it("changes when the resolved target changes", () => {
    expect(importEdgeStableId(input)).not.toBe(
      importEdgeStableId({ ...input, targetPath: "src/c.ts" }),
    );
  });

  it("distinguishes multiple edges on the same line by ordinal", () => {
    expect(importEdgeStableId(input)).not.toBe(importEdgeStableId({ ...input, ordinal: 1 }));
  });

  it("returns the 'ie-' prefix and 67 chars", () => {
    const id = importEdgeStableId(input);
    expect(id.startsWith("ie-")).toBe(true);
    expect(id.length).toBe(67);
  });
});

describe("symbolGraphRecordStableId", () => {
  const input = {
    symbol: "parseConfig",
    scopePath: "src/config.ts",
    kind: "definition",
    line: 3,
    ordinal: 0,
    enclosingSymbol: undefined,
  };

  it("is deterministic across invocations", () => {
    expect(symbolGraphRecordStableId(input)).toBe(symbolGraphRecordStableId(input));
  });

  it("changes when record kind changes", () => {
    expect(symbolGraphRecordStableId(input)).not.toBe(
      symbolGraphRecordStableId({ ...input, kind: "reference" }),
    );
  });

  it("distinguishes same-line records by ordinal", () => {
    expect(symbolGraphRecordStableId(input)).not.toBe(
      symbolGraphRecordStableId({ ...input, ordinal: 1 }),
    );
  });

  it("returns the 'sg-' prefix and 67 chars", () => {
    const id = symbolGraphRecordStableId(input);
    expect(id.startsWith("sg-")).toBe(true);
    expect(id.length).toBe(67);
  });
});
