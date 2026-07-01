import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBoundedDocumentText } from "@oscharko-dev/keiko-local-knowledge";
import { extractQiDocumentText } from "../documentTextExtractor.js";

vi.mock("@oscharko-dev/keiko-local-knowledge", () => ({
  extractBoundedDocumentText: vi.fn(),
}));

const roots: string[] = [];
const extractMock = vi.mocked(extractBoundedDocumentText);

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-qi-doc-extractor-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  extractMock.mockReset();
});

describe("extractQiDocumentText", () => {
  it("forwards bounded PDF bytes to the Local Knowledge parser", async () => {
    const dir = makeDir();
    const path = join(dir, "fachkonzept.pdf");
    writeFileSync(path, "%PDF fixture", "utf8");
    extractMock.mockResolvedValueOnce({
      outcome: "extracted",
      format: "pdf",
      text: "Fachkonzept: Die IBAN muss validiert werden.",
      extractedBytes: 45,
      truncated: false,
      diagnostics: [],
    });
    const controller = new AbortController();
    const text = await extractQiDocumentText({
      path,
      label: "Fachkonzept",
      format: "pdf",
      decodedText: "ignored mojibake",
      maxInputBytes: 2 * 1024 * 1024,
      maxExtractedBytes: 4096,
      signal: controller.signal,
    });
    expect(text).toContain("IBAN muss validiert");
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(extractMock.mock.calls[0]?.[0]).toMatchObject({
      extension: "pdf",
      mediaType: "application/pdf",
    });
    expect(extractMock.mock.calls[0]?.[0].bytes).toBeInstanceOf(Uint8Array);
    expect(extractMock.mock.calls[0]?.[1]).toMatchObject({
      maxInputBytes: 2 * 1024 * 1024,
      maxOutputBytes: 4096,
      maxUnits: 5000,
      timeoutMs: 5000,
      signal: controller.signal,
    });
  });

  it("returns undefined without invoking the parser when the file exceeds the input cap", async () => {
    const dir = makeDir();
    mkdirSync(join(dir, "nested"));
    const path = join(dir, "nested", "large.docx");
    writeFileSync(path, "0123456789", "utf8");
    const text = await extractQiDocumentText({
      path,
      label: "Large",
      format: "docx",
      decodedText: "",
      maxInputBytes: 4,
      maxExtractedBytes: 4096,
    });
    expect(text).toBeUndefined();
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("returns undefined without invoking the parser when the file cannot be read", async () => {
    const dir = makeDir();
    const path = join(dir, "missing.pdf");
    const text = await extractQiDocumentText({
      path,
      label: "Missing",
      format: "pdf",
      decodedText: "",
      maxInputBytes: 2 * 1024 * 1024,
      maxExtractedBytes: 4096,
    });
    expect(text).toBeUndefined();
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("returns undefined for supported documents without extractable text", async () => {
    const dir = makeDir();
    const path = join(dir, "scan.pdf");
    writeFileSync(path, "%PDF image only", "utf8");
    extractMock.mockResolvedValueOnce({
      outcome: "no-text-layer",
      format: "pdf",
      text: "",
      extractedBytes: 0,
      truncated: false,
      diagnostics: [],
    });
    const text = await extractQiDocumentText({
      path,
      label: "Scan",
      format: "pdf",
      decodedText: "",
      maxInputBytes: 2 * 1024 * 1024,
      maxExtractedBytes: 4096,
    });
    expect(text).toBeUndefined();
  });
});
