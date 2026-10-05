import { describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  collectSemanticSearchDocument,
  createSemanticSearchSession,
  DEFAULT_STREAMED_SEMANTIC_BOUNDS,
  runSemanticSearchSession,
  type SemanticSearchDocument,
  type SemanticSearchProvider,
} from "./repoSearchSemantic.js";

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "charge card",
  caseSensitive: false,
  maxResults: 10,
  emittedAtMs: 0,
};
const PROVIDER: SemanticSearchProvider = {
  name: "admission-fixture",
  search: () => Promise.resolve([]),
};

function boundedSession(): ReturnType<typeof createSemanticSearchSession> {
  return createSemanticSearchSession(PROVIDER, QUERY, DEFAULT_STREAMED_SEMANTIC_BOUNDS);
}

describe("semantic document admission work", () => {
  it("encodes each ascending candidate at most once in full and one bounded prefix", () => {
    const session = boundedSession();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      for (let index = 0; index < 64; index += 1) {
        const text = `${String(index)}:${"x".repeat(65_536)}`;
        encode.mockClear();
        collectSemanticSearchDocument(
          session,
          { scopePath: `note-${String(index)}.txt`, text },
          index,
        );
        const retained = session?.documents[0];
        expect(retained?.scopePath).toBe(`note-${String(index)}.txt`);
        const suppliedCharacters = encode.mock.calls.reduce(
          (sum, [input]) => sum + (input?.length ?? 0),
          0,
        );
        expect(encode.mock.calls.length).toBeLessThanOrEqual(2);
        expect(suppliedCharacters).toBeLessThanOrEqual(text.length + (retained?.text.length ?? 0));
      }
      expect(session?.documents).toHaveLength(DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocuments);
      expect(session?.documents.at(-1)?.scopePath).toBe("note-32.txt");
    } finally {
      encode.mockRestore();
    }
  });

  it("encodes anchored sources once without re-encoding retained excerpts", () => {
    const session = boundedSession();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      for (let index = 0; index < 40; index += 1) {
        const text = `${"header\n".repeat(2_000)}charge card ${String(index)}\n${"tail\n".repeat(2_000)}`;
        encode.mockClear();
        collectSemanticSearchDocument(
          session,
          { scopePath: `note-${String(index)}.txt`, text },
          index,
        );
        expect(encode.mock.calls.length).toBeLessThanOrEqual(1);
        expect(session?.documents[0]?.text).toContain(`charge card ${String(index)}`);
        expect(session?.documents[0]?.startLine).toBeGreaterThan(1);
      }
    } finally {
      encode.mockRestore();
    }
  });

  it("does no text encoding for a rejected lower-ranked candidate", () => {
    const session = boundedSession();
    for (let index = 0; index < DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocuments; index += 1) {
      collectSemanticSearchDocument(
        session,
        { scopePath: `${String(index)}.txt`, text: "charge" },
        10,
      );
    }
    const before = session?.documents.slice();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      collectSemanticSearchDocument(
        session,
        { scopePath: "rejected.txt", text: "z".repeat(65_536) },
        0,
      );
      expect(encode).not.toHaveBeenCalled();
      expect(session?.documents).toEqual(before);
    } finally {
      encode.mockRestore();
    }
  });
});

describe("bounded semantic payload compatibility", () => {
  it.each([
    { text: "a😀tail", bytes: 4, expected: "a" },
    { text: "a😀tail", bytes: 5, expected: "a😀" },
    { text: "ab中tail", bytes: 4, expected: "ab" },
    { text: "ab中tail", bytes: 5, expected: "ab中" },
    { text: "a\ud800tail", bytes: 4, expected: "a\uFFFD" },
    { text: "ok\uFFFDtail", bytes: 5, expected: "ok\uFFFD" },
    { text: "charge", bytes: 0, expected: "" },
  ])("preserves the existing UTF-8 prefix at $bytes bytes ($text)", (entry) => {
    const session = createSemanticSearchSession(PROVIDER, QUERY, {
      maxDocumentBytes: entry.bytes,
      maxDocuments: 1,
    });
    collectSemanticSearchDocument(session, {
      scopePath: "notes.txt",
      text: entry.text,
      startLine: 7,
    });
    expect(session?.documents).toEqual([
      { scopePath: "notes.txt", text: entry.expected, startLine: 7 },
    ]);
    expect(Buffer.byteLength(session?.documents[0]?.text ?? "")).toBeLessThanOrEqual(entry.bytes);
  });

  it("keeps score/path ordering, provider contents and payload bounds", async () => {
    let supplied: readonly SemanticSearchDocument[] = [];
    const session = createSemanticSearchSession(
      {
        name: "payload-fixture",
        search: ({ documents }) => {
          supplied = documents;
          return Promise.resolve([]);
        },
      },
      QUERY,
      { maxDocuments: 2, maxDocumentBytes: 10 },
    );
    for (const path of ["z.txt", "b.txt", "a.txt", "c.txt"]) {
      collectSemanticSearchDocument(session, { scopePath: path, text: "ok\uFFFDtail" }, 4);
    }
    await runSemanticSearchSession(session, QUERY, undefined);
    expect(supplied).toEqual([
      { scopePath: "a.txt", text: "ok\uFFFD" },
      { scopePath: "b.txt", text: "ok\uFFFD" },
    ]);
    expect(supplied.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)).toBe(10);
  });
});
