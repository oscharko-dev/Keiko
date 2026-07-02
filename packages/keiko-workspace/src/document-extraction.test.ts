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

function utf16Bytes(value: string, endian: "le" | "be", bom = true): Uint8Array {
  const bytes = new Uint8Array((bom ? 2 : 0) + value.length * 2);
  let offset = 0;
  if (bom) {
    if (endian === "le") {
      bytes[offset++] = 0xff;
      bytes[offset++] = 0xfe;
    } else {
      bytes[offset++] = 0xfe;
      bytes[offset++] = 0xff;
    }
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (endian === "le") {
      bytes[offset++] = code & 0xff;
      bytes[offset++] = code >> 8;
    } else {
      bytes[offset++] = code >> 8;
      bytes[offset++] = code & 0xff;
    }
  }
  return bytes;
}

function utf32LeBytes(value: string, bom = true): Uint8Array {
  const codePoints = Array.from(value, (char) => char.codePointAt(0) ?? 0);
  const bytes = new Uint8Array((bom ? 4 : 0) + codePoints.length * 4);
  let offset = 0;
  if (bom) {
    bytes[offset++] = 0xff;
    bytes[offset++] = 0xfe;
    bytes[offset++] = 0x00;
    bytes[offset++] = 0x00;
  }
  for (const codePoint of codePoints) {
    bytes[offset++] = codePoint & 0xff;
    bytes[offset++] = (codePoint >> 8) & 0xff;
    bytes[offset++] = (codePoint >> 16) & 0xff;
    bytes[offset++] = (codePoint >> 24) & 0xff;
  }
  return bytes;
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

  it("extracts UTF-16LE text when a BOM is present", async () => {
    const text = "class Order {}\n";
    const fs = binaryFs(`${ROOT}/order.ts`, utf16Bytes(text, "le"));
    const result = await extractDocumentContext(fs, ROOT, "order.ts", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.text).toBe("class Order {}");
    expect(result.context.mimeType).toBe("application/typescript");
  });

  it("extracts UTF-16BE text when alternating NUL bytes identify text", async () => {
    const text = "SELECT * FROM orders;\n";
    const fs = binaryFs(`${ROOT}/query.sql`, utf16Bytes(text, "be", false));
    const result = await extractDocumentContext(fs, ROOT, "query.sql", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.text).toBe("SELECT * FROM orders;");
    expect(result.context.mimeType).toBe("application/sql");
  });

  it("extracts UTF-32LE text when a BOM is present", async () => {
    const text = "let answer = 42;\n";
    const fs = binaryFs(`${ROOT}/answer.ts`, utf32LeBytes(text));
    const result = await extractDocumentContext(fs, ROOT, "answer.ts", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.text).toBe("let answer = 42;");
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

  it("does NOT classify as binary-file when a multibyte char straddles the byte cap", async () => {
    // Construct a file: (MAX_EXTRACTED_BYTES - 1) ASCII bytes followed by a 3-byte CJK
    // character '中' (U+4E2D, encoded as E4 B8 AD). The per-doc cap reads exactly
    // MAX_EXTRACTED_BYTES bytes, slicing the CJK char after its first byte. Without the
    // validUtf8PrefixLength fix the fatal UTF-8 decoder would throw and misclassify this
    // valid text file as binary-file. With the fix the incomplete tail byte is trimmed and
    // the file extracts cleanly as truncated TEXT.
    //
    // Mutation robustness: each assertion targets a distinct observable — ok:true rules out
    // binary-file, truncated:true rules out treating the capped slice as the whole file,
    // extractedBytes pins the reported count, and the ASCII prefix in the text body confirms
    // the decoder received the correct pre-trim content.
    const asciiPrefix = "A".repeat(MAX_EXTRACTED_BYTES - 1);
    const cjkChar = "中"; // '中' — 3 UTF-8 bytes: E4 B8 AD
    const fullText = asciiPrefix + cjkChar + "trailing content beyond the cap";
    const allBytes = new TextEncoder().encode(fullText);
    // Sanity: verify the byte layout. asciiPrefix is MAX_EXTRACTED_BYTES-1 bytes (indices
    // 0..65534), then CJK starts at index 65535. The cap reads MAX_EXTRACTED_BYTES = 65536
    // bytes total, so the capped slice ends at index 65535 — capturing only the first byte
    // of the 3-byte CJK char, leaving an incomplete sequence.
    expect(allBytes.length).toBeGreaterThan(MAX_EXTRACTED_BYTES);
    expect(allBytes[MAX_EXTRACTED_BYTES - 2]).toBe(0x41); // last ASCII 'A' (index 65534)
    expect(allBytes[MAX_EXTRACTED_BYTES - 1]).toBe(0xe4); // first byte of CJK at index 65535

    const absPath = `${ROOT}/multibyte.txt`;
    const fs = binaryFs(absPath, allBytes);
    const result = await extractDocumentContext(fs, ROOT, "multibyte.txt", fullBudget());

    // Must succeed as TEXT — not binary-file.
    expect(result.ok).toBe(true);
    if (!result.ok) {
      // Fail with a diagnostic: which kind was returned?
      expect(result.failure.kind).toBe("ok (expected success, got failure)");
      return;
    }
    expect(result.context.truncated).toBe(true);
    // extractedBytes is the raw cap read from disk (before codepoint-trim).
    expect(result.context.extractedBytes).toBe(MAX_EXTRACTED_BYTES);
    // The text body must contain the full ASCII prefix but NOT the CJK char (it was trimmed).
    expect(result.context.text).toContain("AAAA");
    expect(result.context.text).not.toContain(cjkChar);
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

  it("extracts a focused source span beyond the 64 KiB prefix cap", async () => {
    const prefixLines = Array.from({ length: 7_000 }, (_, index) => `// padding ${String(index)}`);
    const targetStartLine = prefixLines.length + 1;
    const source = [
      ...prefixLines,
      "export class CheckoutTotals {",
      "  computeGrandTotal() { return 42; }",
      "}",
      "// suffix that should not be included",
    ].join("\n");
    expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(MAX_EXTRACTED_BYTES);
    const fs = memFs(ROOT, { "src/large.ts": source });
    const result = await extractDocumentContext(fs, ROOT, "src/large.ts", fullBudget(), {
      focus: {
        kind: "line-range",
        startLine: targetStartLine,
        endLine: targetStartLine + 2,
        contextLines: 0,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.text).toBe(
      ["export class CheckoutTotals {", "  computeGrandTotal() { return 42; }", "}"].join("\n"),
    );
    expect(result.context.text).not.toContain("padding");
    expect(result.context.text).not.toContain("suffix");
    expect(result.context.truncated).toBe(true);
    expect(result.context.truncationMarker).toContain(
      `selected lines ${String(targetStartLine)}-${String(targetStartLine + 2)}`,
    );
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

  it("returns binary-file when control bytes exceed the binary ratio threshold", async () => {
    const bytes = new Uint8Array(64);
    bytes.fill(0x41);
    for (let i = 0; i < 9; i += 1) {
      bytes[i] = 0x00;
    }
    const fs = binaryFs(`${ROOT}/payload.bin`, bytes);
    const result = await extractDocumentContext(fs, ROOT, "payload.bin", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("binary-file");
    expect(failureHasNoPath(result.failure)).toBe(true);
  });

  it("probes beyond the first 512 bytes before accepting a text extension", async () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    for (let i = 600; i < 700; i += 1) {
      bytes[i] = 0x00;
    }
    const fs = binaryFs(`${ROOT}/late-control.txt`, bytes);
    const result = await extractDocumentContext(fs, ROOT, "late-control.txt", fullBudget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("binary-file");
  });

  it("strips a sparse embedded NUL from supported text documents", async () => {
    const bytes = new TextEncoder().encode(`hello\u0000world ${"text ".repeat(20)}\n`);
    const fs = binaryFs(`${ROOT}/payload.txt`, bytes);
    const result = await extractDocumentContext(fs, ROOT, "payload.txt", fullBudget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.text).toBe(`helloworld ${"text ".repeat(20)}`.trimEnd());
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
    const result = await extractDocumentContext(
      fs,
      ROOT,
      `ok${String.fromCharCode(0)}.txt`,
      fullBudget(),
    );
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
    expect(SUPPORTED_MIME_LITERALS.has("application/toml")).toBe(true);
    expect(SUPPORTED_MIME_LITERALS.has("application/sql")).toBe(true);
  });
});
