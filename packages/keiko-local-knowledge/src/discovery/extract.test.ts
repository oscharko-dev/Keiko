import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { addSourceToCapsule } from "../source-lifecycle.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";
import { createDefaultParserRegistry, buildParserOptions } from "../parsers/index.js";
import { PDF_TEXT_LAYER } from "../parsers/parser-test-fixtures.js";

import { extractDocument } from "./extract.js";
import { folderScope, memoryFs } from "./test-support.js";
import { documentIdFor } from "./types.js";

const ROOT = "/srv/docs";

interface CountRow {
  readonly n: number;
}

let store: KnowledgeStore;
let cleanup: () => void;
let capsuleId: KnowledgeCapsuleId;
let source: KnowledgeSource;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  const cap = createCapsule(store, sampleCapsuleInput());
  capsuleId = cap.id;
  source = addSourceToCapsule(store, capsuleId, {
    id: "src-1" as KnowledgeSourceId,
    displayName: "docs",
    tags: [],
    scope: folderScope(ROOT),
  });
});

afterEach(() => {
  cleanup();
});

function count(table: string, params: Record<string, unknown> = {}): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c`)
    .get({ c: capsuleId, ...params });
  return (row as CountRow | undefined)?.n ?? 0;
}

describe("extractDocument — markdown success path", () => {
  it("persists a documents row with full lineage and content_hash", async () => {
    const fs = memoryFs(ROOT, [{ relativePath: "README.md", content: "# Hello\n\nWorld" }]);
    const registry = createDefaultParserRegistry();
    const result = await extractDocument(
      { fs, store, parserRegistry: registry },
      {
        capsuleId,
        source,
        file: { relativePath: "README.md", sizeBytes: 14 },
      },
    );
    expect(result.outcome.kind).toBe("persisted");
    if (result.outcome.kind !== "persisted") return;
    const doc = result.outcome.document;
    expect(doc.capsuleId).toBe(capsuleId);
    expect(doc.sourceId).toBe(source.id);
    expect(doc.documentPath).toBe("README.md");
    expect(doc.status).toBe("extracted");
    expect(doc.safeDisplayName).toBe("README.md");
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.parser.parserId).toBe("text");
    expect(count("documents")).toBe(1);
    expect(count("parsed_units")).toBeGreaterThan(0);
  });
});

describe("extractDocument — unsupported format", () => {
  it("writes status=unsupported and an UNSUPPORTED_FORMAT diagnostic", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fs = memoryFs(ROOT, [{ relativePath: "logo.png", content: pngBytes }]);
    const registry = createDefaultParserRegistry();
    const result = await extractDocument(
      { fs, store, parserRegistry: registry },
      {
        capsuleId,
        source,
        file: { relativePath: "logo.png", sizeBytes: pngBytes.byteLength },
      },
    );
    expect(result.outcome.kind).toBe("persisted");
    if (result.outcome.kind !== "persisted") return;
    expect(result.outcome.document.status).toBe("unsupported");
    expect(result.diagnostics.some((d) => d.code === "UNSUPPORTED_FORMAT")).toBe(true);
    const diagCount = count("parser_diagnostics");
    expect(diagCount).toBeGreaterThanOrEqual(1);
  });
});

describe("extractDocument — normalized binary text", () => {
  it("persists extracted text for binary parsers that emit normalized content", async () => {
    const fs = memoryFs(ROOT, [{ relativePath: "policy.pdf", content: PDF_TEXT_LAYER }]);
    const registry = createDefaultParserRegistry();
    const result = await extractDocument(
      { fs, store, parserRegistry: registry },
      {
        capsuleId,
        source,
        file: { relativePath: "policy.pdf", sizeBytes: PDF_TEXT_LAYER.byteLength },
      },
    );
    expect(result.outcome.kind).toBe("persisted");
    if (result.outcome.kind !== "persisted") return;
    const row = store._internal.db
      .prepare(
        "SELECT normalized_text FROM document_texts WHERE capsule_id = :c AND document_id = :d",
      )
      .get({ c: capsuleId, d: result.outcome.document.id }) as
      | { readonly normalized_text?: string }
      | undefined;
    expect(row?.normalized_text).toContain("Hello PDF");
  });
});

describe("extractDocument — oversized file", () => {
  it("writes status=failed and an OVERSIZED_FILE diagnostic without parsing", async () => {
    const big = "x".repeat(2048);
    const fs = memoryFs(ROOT, [{ relativePath: "big.txt", content: big }]);
    const registry = createDefaultParserRegistry();
    const result = await extractDocument(
      { fs, store, parserRegistry: registry },
      {
        capsuleId,
        source,
        file: { relativePath: "big.txt", sizeBytes: 2048 },
        parserOptions: buildParserOptions({ maxBytes: 1024 }),
      },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.document.status).toBe("failed");
    expect(result.outcome.error.code).toBe("OVERSIZED_FILE");
    expect(count("documents")).toBe(1);
    expect(count("parser_diagnostics")).toBe(1);
    expect(count("parsed_units")).toBe(0);
  });
});

describe("extractDocument — re-extract fast-path", () => {
  it("skips the parse when content_hash matches the stored row", async () => {
    const fs = memoryFs(ROOT, [{ relativePath: "README.md", content: "stable bytes" }]);
    const registry = createDefaultParserRegistry();
    const first = await extractDocument(
      { fs, store, parserRegistry: registry },
      { capsuleId, source, file: { relativePath: "README.md", sizeBytes: 12 } },
    );
    expect(first.outcome.kind).toBe("persisted");
    if (first.outcome.kind !== "persisted") return;
    const firstExtractedAt = first.outcome.document.lastExtractedAt;
    // Wait one ms-tick so a re-parse would update the timestamp.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await extractDocument(
      { fs, store, parserRegistry: registry },
      { capsuleId, source, file: { relativePath: "README.md", sizeBytes: 12 } },
    );
    expect(second.outcome.kind).toBe("skipped");
    if (second.outcome.kind !== "skipped") return;
    expect(second.outcome.reason).toBe("unchanged");
    expect(second.outcome.document.lastExtractedAt).toBe(firstExtractedAt);
    expect(second.diagnostics).toStrictEqual([]);
  });

  it("re-parses when the content_hash changes", async () => {
    const registry = createDefaultParserRegistry();
    const fs1 = memoryFs(ROOT, [{ relativePath: "x.md", content: "v1" }]);
    await extractDocument(
      { fs: fs1, store, parserRegistry: registry },
      { capsuleId, source, file: { relativePath: "x.md", sizeBytes: 2 } },
    );
    const fs2 = memoryFs(ROOT, [{ relativePath: "x.md", content: "v2 differs" }]);
    const second = await extractDocument(
      { fs: fs2, store, parserRegistry: registry },
      { capsuleId, source, file: { relativePath: "x.md", sizeBytes: 10 } },
    );
    expect(second.outcome.kind).toBe("persisted");
  });
});

describe("extractDocument — path containment", () => {
  it("rejects a file whose realPath escapes the scope root", async () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: "shady.txt",
        content: "secret",
        realPathOverride: "/etc/passwd",
      },
    ]);
    const registry = createDefaultParserRegistry();
    const result = await extractDocument(
      { fs, store, parserRegistry: registry },
      { capsuleId, source, file: { relativePath: "shady.txt", sizeBytes: 6 } },
    );
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("PATH_ESCAPE");
    expect(count("documents")).toBe(0);
  });
});

describe("documentIdFor", () => {
  it("returns a stable id for the same (capsule, source, path) tuple", () => {
    const a = documentIdFor({
      capsuleId,
      sourceId: source.id,
      relativePath: "README.md",
    });
    const b = documentIdFor({
      capsuleId,
      sourceId: source.id,
      relativePath: "README.md",
    });
    expect(a).toBe(b);
  });

  it("encodes # in relativePath so a file named 'a#u0.md' does not collide with a parsed_unit suffix", () => {
    // A file literally named 'a#u0.md' must produce a document ID that does NOT
    // equal the parsed_unit id `<docId>#u0` derived from a different document 'a.md'.
    const hashFile = documentIdFor({ capsuleId, sourceId: source.id, relativePath: "a#u0.md" });
    const otherDoc = documentIdFor({ capsuleId, sourceId: source.id, relativePath: "a.md" });
    const unitId = `${String(otherDoc)}#u0`;
    expect(hashFile).not.toBe(unitId);
    // Also verify the # is encoded in the id (not raw).
    expect(String(hashFile)).toContain("%23");
  });
});

describe("extractDocument — Windows separator normalisation", () => {
  it("passes the realpath containment gate when WorkspaceFs.realPath returns Windows-style paths", async () => {
    // realPathOverride simulates a Windows realPath that returns backslash paths.
    const fs = memoryFs(ROOT, [
      {
        relativePath: "docs/guide.md",
        content: "# Guide",
        // Simulate Windows realPath returning backslash-normalised absolute path.
        realPathOverride: ROOT.replace(/\//g, "\\") + "\\docs\\guide.md",
      },
    ]);
    const registry = createDefaultParserRegistry();
    const result = await extractDocument(
      { fs, store, parserRegistry: registry },
      {
        capsuleId,
        source,
        file: { relativePath: "docs/guide.md", sizeBytes: 7 },
      },
    );
    // Must NOT be rejected as PATH_ESCAPE; containment check must pass after normalisation.
    expect(result.outcome.kind).not.toBe("failed");
    if (result.outcome.kind === "failed") {
      // Provide diagnostic info if the test fails.
      expect(result.outcome.error.code).not.toBe("PATH_ESCAPE");
    }
  });
});
