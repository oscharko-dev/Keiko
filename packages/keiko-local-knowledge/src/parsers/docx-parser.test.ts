import { describe, expect, it } from "vitest";

import { buildParserOptions } from "./registry.js";
import { DOCX_SIMPLE, selectionFromBytes } from "./parser-test-fixtures.js";
import { docxParser } from "./docx-parser.js";

describe("docxParser", () => {
  it("extracts heading-based sections from DOCX", async () => {
    const result = await docxParser.parseAsync(
      selectionFromBytes(DOCX_SIMPLE, {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions(),
    );
    expect(result.parser.parserId).toBe("docx");
    expect(result.sections).toHaveLength(2);
    expect(result.units[0]).toMatchObject({
      kind: "section",
      sectionPath: ["Policy"],
    });
    expect(result.units[1]).toMatchObject({
      kind: "section",
      sectionPath: ["Policy", "Controls"],
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("reports malformed archives safely", async () => {
    const result = await docxParser.parseAsync(
      selectionFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions(),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
  });
});
