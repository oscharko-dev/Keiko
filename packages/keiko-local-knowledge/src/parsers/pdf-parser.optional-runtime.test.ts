import { describe, expect, it, vi } from "vitest";

import { buildParserOptions } from "./registry.js";
import { PDF_MAGIC, selectionFromBytes } from "./parser-test-fixtures.js";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  throw new Error("simulated missing PDF native canvas runtime");
});

describe("pdfParser optional PDF runtime dependency", () => {
  it("does not fail module import when the optional PDF runtime cannot load", async () => {
    const { pdfParser } = await import("./pdf-parser.js");

    expect(pdfParser.capability.matches(selectionFromBytes(PDF_MAGIC, { extension: "pdf" }))).toBe(
      true,
    );
  });

  it("reports a controlled parser diagnostic when PDFJS cannot load", async () => {
    const { pdfParser } = await import("./pdf-parser.js");

    const result = await pdfParser.parseAsync(
      selectionFromBytes(PDF_MAGIC, { extension: "pdf", mediaType: "application/pdf" }),
      buildParserOptions(),
    );

    expect(result.diagnostics[0]).toMatchObject({
      code: "MALFORMED_INPUT",
      severity: "error",
    });
    expect(result.diagnostics[0]?.message).not.toHaveLength(0);
  });
});
