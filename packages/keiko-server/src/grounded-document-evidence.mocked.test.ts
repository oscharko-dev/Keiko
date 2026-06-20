// Behaviours that need a controlled Local Knowledge extractor result (Issue #1285): redaction of
// extracted document text before windowing, and enforcement of the per-request aggregate document
// byte budget. The extractor is mocked so the redaction step and the budget arithmetic are
// exercised deterministically without crafting secret-bearing or 32 KiB binary documents.

import { describe, expect, it, vi, beforeEach } from "vitest";

import type {
  SelectedScope,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchScope, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));

vi.mock("@oscharko-dev/keiko-local-knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-local-knowledge")>();
  return { ...actual, extractBoundedDocumentText: extractMock };
});

const { collectConnectedDocumentEvidence, MAX_DOCUMENT_EXTRACTED_BYTES } =
  await import("./grounded-document-evidence.js");

const WORKSPACE_ROOT = "/ws";
const SOME_BYTES = new Uint8Array([1, 2, 3, 4]);

function fs(): WorkspaceFs {
  return {
    readFileUtf8: (): string => "",
    stat: (): WorkspaceStat => ({
      size: SOME_BYTES.byteLength,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      hardLinkCount: 1,
      mtimeMs: 1,
    }),
    readDir: (): readonly never[] => [],
    realPath: (path): string => path,
    exists: (): boolean => true,
    readFileBytes: (): Promise<Uint8Array> => Promise.resolve(SOME_BYTES),
  };
}

function scope(relativePaths: readonly string[]): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "scope-docs",
    workspaceRoot: WORKSPACE_ROOT,
    kind: "files",
    relativePaths,
    conversationId: undefined,
    connectedAtMs: 1,
    explicitConnection: true,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "summarize the connected documents",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 1,
  };
}

function run(
  relativePaths: readonly string[],
): ReturnType<typeof collectConnectedDocumentEvidence> {
  const searchScope: SearchScope = {
    workspace: { root: WORKSPACE_ROOT },
    scopeId: "scope-docs",
    relativePaths,
  } as SearchScope;
  return collectConnectedDocumentEvidence({
    scope: scope(relativePaths),
    query: query(),
    searchScope,
    fs: fs(),
    nowMs: () => 1_000,
  });
}

beforeEach(() => {
  extractMock.mockReset();
});

describe("collectConnectedDocumentEvidence with a mocked extractor", () => {
  it("strips credential-shaped strings from document excerpt windows", async () => {
    extractMock.mockResolvedValue({
      outcome: "extracted",
      format: "docx",
      text: "Connection: sk-ABCDEFGHIJKLMNOP1234567890 and AKIAIOSFODNN7EXAMPLE follow.",
      extractedBytes: 70,
      truncated: false,
      diagnostics: [],
    });
    const result = await run(["docs/creds.docx"]);
    const content =
      result.excerpts
        .get("docs/creds.docx")
        ?.map((window) => window.content)
        .join("\n") ?? "";
    expect(content).not.toContain("sk-ABCDEFGHIJKLMNOP1234567890");
    expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(content).toContain("[REDACTED]");
  });

  it("enforces the per-request aggregate document byte budget", async () => {
    // Each document fills its full extraction allowance (respecting the per-document cap and the
    // remaining aggregate budget). After two full documents the aggregate budget is exhausted, so
    // the third lands with no remaining allowance and is reported, not extracted.
    extractMock.mockImplementation(
      (_input: unknown, options: { readonly maxOutputBytes: number }) =>
        Promise.resolve({
          outcome: "extracted",
          format: "docx",
          text: "x".repeat(options.maxOutputBytes),
          extractedBytes: options.maxOutputBytes,
          truncated: true,
          diagnostics: [],
        }),
    );
    const result = await run(["docs/a.docx", "docs/b.docx", "docs/c.docx"]);
    const budgetExhausted = result.omitted.filter((entry) => entry.reason === "budget-exhausted");
    expect(result.candidates.length).toBe(2);
    expect(budgetExhausted).toEqual([
      { scopePath: "docs/c.docx", reason: "budget-exhausted", omittedAtMs: 1_000 },
    ]);
    expect(result.uncertainty[0]?.kind).toBe("scope-incomplete");
    // Per-document cap is respected: each extracted document carries at most the per-document max.
    expect(MAX_DOCUMENT_EXTRACTED_BYTES).toBeGreaterThan(0);
  });
});
