// Issue #148 — client-side document text extraction into bounded conversation context.
//
// The extractor mirrors the SERVER trust boundary exactly: per-entry 64 KiB UTF-8 cap,
// 256 KiB aggregate cap, max 16 entries, basename-only display names. These tests pin the
// byte-budget math and the truncation marker so a one-line mutation to either is caught.

import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TRUNCATION_MARKER,
  MAX_AGGREGATE_DOCUMENT_BYTES,
  MAX_DOCUMENT_CONTEXT_ENTRIES,
  MAX_DOCUMENT_CONTEXT_TEXT_BYTES,
  extractDocumentContext,
  isTextExtractableMime,
  type PendingDocument,
} from "./documentContext";

const encoder = new TextEncoder();
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** A PendingDocument whose File yields the given text via file.text(). */
function makeDoc(overrides: Partial<PendingDocument> & { text: string }): PendingDocument {
  const { text, ...rest } = overrides;
  const file = new File([text], rest.name ?? "doc.txt", { type: rest.mimeType ?? "text/plain" });
  return {
    id: rest.id ?? "doc-1",
    name: rest.name ?? "doc.txt",
    mimeType: rest.mimeType ?? "text/plain",
    sizeBytes: rest.sizeBytes ?? utf8Bytes(text),
    file,
  };
}

/** A PendingDocument whose File.text() rejects, to exercise the unreadable path. */
function makeUnreadableDoc(name: string): PendingDocument {
  const file = new File(["unused"], name, { type: "text/plain" });
  Object.defineProperty(file, "text", {
    value: () => Promise.reject(new Error("/Users/secret/denied: EACCES permission denied")),
  });
  return { id: "bad-1", name, mimeType: "text/plain", sizeBytes: 10, file };
}

describe("server-parity constants", () => {
  it("per-entry cap is exactly 64 KiB", () => {
    expect(MAX_DOCUMENT_CONTEXT_TEXT_BYTES).toBe(65_536);
  });
  it("aggregate cap is exactly 256 KiB", () => {
    expect(MAX_AGGREGATE_DOCUMENT_BYTES).toBe(262_144);
  });
  it("entry count cap is 16", () => {
    expect(MAX_DOCUMENT_CONTEXT_ENTRIES).toBe(16);
  });
  it("truncation marker is the fixed sentinel", () => {
    expect(DOCUMENT_TRUNCATION_MARKER).toBe("\n…[truncated]");
  });
});

describe("isTextExtractableMime", () => {
  it("accepts text/* and json/yaml", () => {
    expect(isTextExtractableMime("text/plain")).toBe(true);
    expect(isTextExtractableMime("text/markdown")).toBe(true);
    expect(isTextExtractableMime("application/json")).toBe(true);
    expect(isTextExtractableMime("application/x-yaml")).toBe(true);
    expect(isTextExtractableMime("application/yaml")).toBe(true);
  });
  it("rejects binary documents like PDF", () => {
    expect(isTextExtractableMime("application/pdf")).toBe(false);
    expect(isTextExtractableMime("image/png")).toBe(false);
  });
});

describe("extractDocumentContext — single document", () => {
  it("emits a full-text entry with truncated:false and correct UTF-8 extractedBytes", async () => {
    const text = "# Title\nbody with unicode 漢字 and emoji 🎉";
    const { entries, failures } = await extractDocumentContext([
      makeDoc({ id: "d1", name: "notes.md", mimeType: "text/markdown", text }),
    ]);

    expect(failures).toEqual([]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.id).toBe("d1");
    expect(entry.displayName).toBe("notes.md");
    expect(entry.mimeType).toBe("text/markdown");
    expect(entry.text).toBe(text);
    expect(entry.truncated).toBe(false);
    expect(entry.truncationMarker).toBeUndefined();
    expect(entry.extractedBytes).toBe(utf8Bytes(text));
  });

  it("uses the basename only — never a path component (AC #4)", async () => {
    const { entries } = await extractDocumentContext([
      makeDoc({ id: "d1", name: "/Users/secret/Projects/report.txt", text: "hello" }),
    ]);
    expect(entries[0]?.displayName).toBe("report.txt");
    expect(entries[0]?.displayName).not.toContain("/Users/");
  });

  it("strips Windows path separators too", async () => {
    const { entries } = await extractDocumentContext([
      makeDoc({ id: "d1", name: "C:\\Users\\me\\notes.txt", text: "hi" }),
    ]);
    expect(entries[0]?.displayName).toBe("notes.txt");
  });
});

describe("extractDocumentContext — per-entry budget", () => {
  it("truncates an over-budget document to <= the byte cap and appends the marker", async () => {
    // 70 000 ASCII bytes — over the 65 536 cap.
    const big = "a".repeat(70_000);
    const { entries } = await extractDocumentContext([makeDoc({ id: "big", text: big })]);

    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.truncated).toBe(true);
    expect(entry.truncationMarker).toBe(DOCUMENT_TRUNCATION_MARKER);
    expect(utf8Bytes(entry.text)).toBeLessThanOrEqual(MAX_DOCUMENT_CONTEXT_TEXT_BYTES);
    expect(entry.extractedBytes).toBe(utf8Bytes(entry.text));
    expect(entry.text.length).toBe(MAX_DOCUMENT_CONTEXT_TEXT_BYTES);
  });

  it("never splits a multi-byte code point at the budget boundary", async () => {
    // Each 漢 is 3 UTF-8 bytes. 22_000 of them = 66_000 bytes (> 65_536). The truncation
    // must land on a code-point boundary so the result re-encodes without replacement chars.
    const big = "漢".repeat(22_000);
    const { entries } = await extractDocumentContext([makeDoc({ id: "cjk", text: big })]);

    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(utf8Bytes(entry.text)).toBeLessThanOrEqual(MAX_DOCUMENT_CONTEXT_TEXT_BYTES);
    // Re-encode/decode round-trips with no replacement char => no split surrogate.
    expect(entry.text).not.toContain("�");
    // 65_536 / 3 = 21_845 whole chars; the 21_846th would overflow.
    expect(entry.text.length).toBe(21_845);
  });
});

describe("extractDocumentContext — aggregate budget", () => {
  it("truncates a later document so the running total never exceeds the aggregate cap", async () => {
    // First doc consumes the full per-entry cap (64 KiB). Three more of 64 KiB each would be
    // 256 KiB total which is exactly the aggregate cap; a fifth must be dropped.
    const chunk = "a".repeat(MAX_DOCUMENT_CONTEXT_TEXT_BYTES);
    const docs: PendingDocument[] = [
      makeDoc({ id: "a", name: "a.txt", text: chunk }),
      makeDoc({ id: "b", name: "b.txt", text: chunk }),
      makeDoc({ id: "c", name: "c.txt", text: chunk }),
      makeDoc({ id: "d", name: "d.txt", text: chunk }),
    ];
    const { entries } = await extractDocumentContext(docs);

    const total = entries.reduce(
      (sum, e) => sum + utf8Bytes(e.text) + utf8Bytes(e.truncationMarker ?? ""),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_AGGREGATE_DOCUMENT_BYTES);
    // a + b + c each 64 KiB = 192 KiB; d gets the remaining 64 KiB minus the markers already
    // spent — so d is present but truncated.
    expect(entries.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(entries[3]?.truncated).toBe(true);
  });

  it("drops a document entirely when zero aggregate budget remains", async () => {
    const chunk = "a".repeat(MAX_DOCUMENT_CONTEXT_TEXT_BYTES);
    // Four full 64 KiB docs already saturate the 256 KiB aggregate; a fifth gets nothing.
    const docs: PendingDocument[] = [
      makeDoc({ id: "a", name: "a.txt", text: chunk }),
      makeDoc({ id: "b", name: "b.txt", text: chunk }),
      makeDoc({ id: "c", name: "c.txt", text: chunk }),
      makeDoc({ id: "d", name: "d.txt", text: chunk }),
      makeDoc({ id: "e", name: "e.txt", text: chunk }),
    ];
    const { entries } = await extractDocumentContext(docs);
    expect(entries.map((e) => e.id)).not.toContain("e");
    const total = entries.reduce(
      (sum, e) => sum + utf8Bytes(e.text) + utf8Bytes(e.truncationMarker ?? ""),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_AGGREGATE_DOCUMENT_BYTES);
  });

  it("caps the number of emitted entries at MAX_DOCUMENT_CONTEXT_ENTRIES", async () => {
    const docs: PendingDocument[] = Array.from({ length: 20 }, (_unused, i) =>
      makeDoc({ id: `d${String(i)}`, name: `d${String(i)}.txt`, text: "x" }),
    );
    const { entries } = await extractDocumentContext(docs);
    expect(entries.length).toBeLessThanOrEqual(MAX_DOCUMENT_CONTEXT_ENTRIES);
  });
});

describe("extractDocumentContext — unreadable files", () => {
  it("reports a fixed, path-safe failure and never throws", async () => {
    const { entries, failures } = await extractDocumentContext([makeUnreadableDoc("locked.txt")]);
    expect(entries).toEqual([]);
    expect(failures).toHaveLength(1);
    const message = failures[0] ?? "";
    expect(message).toContain("locked.txt");
    expect(message).not.toContain("/Users/");
    expect(message).not.toContain("EACCES");
  });

  it("emits readable docs and reports only the unreadable ones", async () => {
    const { entries, failures } = await extractDocumentContext([
      makeDoc({ id: "ok", name: "ok.txt", text: "fine" }),
      makeUnreadableDoc("bad.txt"),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["ok"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("bad.txt");
  });
});
