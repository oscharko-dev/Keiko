// Issue #148 — Safe document context extraction (Epic #142).
//
// Acceptance criteria coverage:
//   AC #1 (bounded context):       budget tests + truncation marker
//   AC #2 (path-safe failures):    denied-path / not-found / no path-string in failures
//   AC #3 (truncation surfacing):  truncated:true + truncationMarker present when capped
//   AC #4 (separation):            tested at the prompt-composer layer (conversation-prompt.test.ts)

import { describe, expect, it } from "vitest";
import {
  MAX_EXTRACTED_BYTES,
  MAX_TOTAL_EXTRACTED_BYTES,
  SUPPORTED_MIME_LITERALS,
  SUPPORTED_MIME_PREFIXES,
  extractDocumentContext,
  type DocumentExtractionBudget,
  type DocumentExtractionFailure,
} from "./document-extraction.js";
import { memFs } from "./_memfs.js";
import type { WorkspaceFs } from "./fs.js";

const ROOT = "/ws";

function fullBudget(): DocumentExtractionBudget {
  return {
    perDocBytes: MAX_EXTRACTED_BYTES,
    totalBudgetUsedBytes: 0,
    totalBudgetBytes: MAX_TOTAL_EXTRACTED_BYTES,
  };
}

function binaryFs(absPath: string, bytes: Uint8Array): WorkspaceFs {
  // Adapter that returns raw binary bytes for the probe / capped-read path. We do not use
  // memFs() for this because the in-memory fake encodes via TextEncoder, which silently scrubs
  // arbitrary binary content.
  return {
    readFileUtf8: (path: string): string => {
      if (path === absPath) return new TextDecoder("utf-8").decode(bytes);
      throw new Error(`ENOENT: ${path}`);
    },
    stat: (path: string): import("./fs.js").WorkspaceStat => {
      if (path === absPath) {
        return {
          size: bytes.length,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        };
      }
      return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
    },
    readDir: () => [],
    realPath: (path: string) => path,
    exists: (path: string) => path === absPath || path === ROOT,
    readFileBytes: (path: string, maxBytes: number): Promise<Uint8Array> => {
      if (path === absPath) {
        const cap = Math.max(0, Math.floor(maxBytes));
        return Promise.resolve(bytes.subarray(0, Math.min(cap, bytes.length)));
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    },
  };
}

function failureHasNoPath(failure: DocumentExtractionFailure): boolean {
  // The failure tagged-union must never carry an absolute or workspace-relative path string.
  // We enumerate explicitly so an added field still has to opt out by name.
  return !("path" in failure) && !("relativePath" in failure) && !("filePath" in failure);
}

describe("extractDocumentContext — happy path", () => {
  it("returns ok:true with full text for a small markdown file", async () => {
    const fs = memFs(ROOT, { "README.md": "# Hello\n\nWorld\n" });
    const result = await extractDocumentContext(fs, ROOT, "README.md", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.displayName).toBe("README.md");
    expect(result.context.mimeType).toBe("text/markdown");
    expect(result.context.text).toBe("# Hello\n\nWorld");
    expect(result.context.truncated).toBe(false);
    expect(result.context.truncationMarker).toBeUndefined();
    expect(result.context.extractedBytes).toBeGreaterThan(0);
    expect(result.context.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("classifies json/yaml/ts files via extension fallback", async () => {
    const fs = memFs(ROOT, {
      "a.json": '{"hello":"world"}',
      "b.yaml": "hello: world",
      "c.ts": "export const x = 1;",
    });
    const r1 = await extractDocumentContext(fs, ROOT, "a.json", fullBudget());
    const r2 = await extractDocumentContext(fs, ROOT, "b.yaml", fullBudget());
    const r3 = await extractDocumentContext(fs, ROOT, "c.ts", fullBudget());
    expect(r1.ok && r1.context.mimeType).toBe("application/json");
    expect(r2.ok && r2.context.mimeType).toBe("application/yaml");
    expect(r3.ok && r3.context.mimeType).toBe("application/typescript");
  });
});

describe("extractDocumentContext — truncation", () => {
  it("truncates content larger than perDocBytes and reports truncated:true with marker", async () => {
    const big = "A".repeat(MAX_EXTRACTED_BYTES + 1024); // bigger than the per-doc cap
    const fs = memFs(ROOT, { "big.txt": big });
    const result = await extractDocumentContext(fs, ROOT, "big.txt", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.truncated).toBe(true);
    expect(result.context.extractedBytes).toBe(MAX_EXTRACTED_BYTES);
    expect(result.context.truncationMarker).toBeDefined();
    expect(result.context.truncationMarker).toContain("truncated");
  });

  it("respects total-budget remaining when smaller than perDocBytes", async () => {
    const content = "A".repeat(5000);
    const fs = memFs(ROOT, { "doc.txt": content });
    // perDoc=64KiB but only 2000 bytes of total budget remain → cap is 2000 bytes
    const budget: DocumentExtractionBudget = {
      perDocBytes: MAX_EXTRACTED_BYTES,
      totalBudgetUsedBytes: MAX_TOTAL_EXTRACTED_BYTES - 2000,
      totalBudgetBytes: MAX_TOTAL_EXTRACTED_BYTES,
    };
    const result = await extractDocumentContext(fs, ROOT, "doc.txt", budget);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.extractedBytes).toBe(2000);
    expect(result.context.truncated).toBe(true);
  });

  it("budget fully exhausted ⇒ extractedBytes:0, truncated:true, text empty", async () => {
    const fs = memFs(ROOT, { "doc.txt": "any content" });
    const budget: DocumentExtractionBudget = {
      perDocBytes: MAX_EXTRACTED_BYTES,
      totalBudgetUsedBytes: MAX_TOTAL_EXTRACTED_BYTES,
      totalBudgetBytes: MAX_TOTAL_EXTRACTED_BYTES,
    };
    const result = await extractDocumentContext(fs, ROOT, "doc.txt", budget);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.extractedBytes).toBe(0);
    expect(result.context.truncated).toBe(true);
    expect(result.context.text).toBe("");
  });
});

describe("extractDocumentContext — path-safe failures", () => {
  it("returns denied-path for a traversal attempt and carries no path string", async () => {
    const fs = memFs(ROOT, { "doc.txt": "ok" });
    const result = await extractDocumentContext(fs, ROOT, "../../../etc/passwd", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("denied-path");
    expect(failureHasNoPath(result.failure)).toBe(true);
    // Stringified failure must not embed a fs path
    expect(JSON.stringify(result.failure)).not.toContain("etc/passwd");
    expect(JSON.stringify(result.failure)).not.toContain("/");
  });

  it("returns not-found for a missing file with no path in the failure", async () => {
    const fs = memFs(ROOT, {});
    const result = await extractDocumentContext(fs, ROOT, "missing.txt", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("not-found");
    expect(failureHasNoPath(result.failure)).toBe(true);
    expect(JSON.stringify(result.failure)).not.toContain("missing.txt");
  });

  it("returns empty for a zero-byte file", async () => {
    const fs = memFs(ROOT, { "empty.txt": "" });
    const result = await extractDocumentContext(fs, ROOT, "empty.txt", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("empty");
    expect(failureHasNoPath(result.failure)).toBe(true);
  });

  it("returns unsupported-type for an unrecognised extension", async () => {
    const fs = memFs(ROOT, { "binary.exe": "MZ" });
    const result = await extractDocumentContext(fs, ROOT, "binary.exe", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unsupported-type");
    expect(failureHasNoPath(result.failure)).toBe(true);
  });

  it("returns binary-file when a NUL byte appears in the first 512 bytes", async () => {
    const bytes = new Uint8Array(64);
    bytes.fill(0x41);
    bytes[10] = 0x00;
    const fs = binaryFs(`${ROOT}/payload.bin`, bytes);
    const result = await extractDocumentContext(fs, ROOT, "payload.bin", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("binary-file");
    expect(failureHasNoPath(result.failure)).toBe(true);
  });

  it("denies a path inside a deny-list directory (e.g. .git)", async () => {
    const fs = memFs(ROOT, { ".git/config": "ok" });
    const result = await extractDocumentContext(fs, ROOT, ".git/config", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("denied-path");
    expect(failureHasNoPath(result.failure)).toBe(true);
  });

  it("denies a path that contains a NUL byte", async () => {
    const fs = memFs(ROOT, { "ok.txt": "ok" });
    const result = await extractDocumentContext(fs, ROOT, "ok .txt", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("denied-path");
    expect(failureHasNoPath(result.failure)).toBe(true);
  });
});

describe("extractDocumentContext — budget accounting across calls", () => {
  it("second extraction sees updated totalBudgetUsedBytes and truncates accordingly", async () => {
    const fs = memFs(ROOT, {
      "a.txt": "A".repeat(1000),
      "b.txt": "B".repeat(1000),
    });
    const first = await extractDocumentContext(fs, ROOT, "a.txt", {
      perDocBytes: MAX_EXTRACTED_BYTES,
      totalBudgetUsedBytes: 0,
      totalBudgetBytes: 1500,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.context.extractedBytes).toBe(1000);
    expect(first.context.truncated).toBe(false);

    // Second call: only 500 bytes of total budget remain
    const second = await extractDocumentContext(fs, ROOT, "b.txt", {
      perDocBytes: MAX_EXTRACTED_BYTES,
      totalBudgetUsedBytes: first.context.extractedBytes,
      totalBudgetBytes: 1500,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.context.extractedBytes).toBe(500);
    expect(second.context.truncated).toBe(true);
  });
});

describe("extractDocumentContext — display name is basename only", () => {
  it("uses basename only — never the workspace-relative path or directory components", async () => {
    const fs = memFs(ROOT, { "docs/inner/notes.md": "hello" });
    const result = await extractDocumentContext(fs, ROOT, "docs/inner/notes.md", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.displayName).toBe("notes.md");
    expect(result.context.displayName).not.toContain("/");
  });
});

describe("extractDocumentContext — constants and stability", () => {
  it("exports MAX_EXTRACTED_BYTES = 64 KiB", () => {
    expect(MAX_EXTRACTED_BYTES).toBe(65_536);
  });
  it("exports MAX_TOTAL_EXTRACTED_BYTES = 256 KiB", () => {
    expect(MAX_TOTAL_EXTRACTED_BYTES).toBe(262_144);
  });
  it("treats text/* as supported and includes common structured-text literals", () => {
    expect(SUPPORTED_MIME_PREFIXES).toContain("text/");
    expect(SUPPORTED_MIME_LITERALS.has("application/json")).toBe(true);
    expect(SUPPORTED_MIME_LITERALS.has("application/yaml")).toBe(true);
  });
});
