import { describe, expect, it } from "vitest";

import { buildParserOptions } from "./registry.js";
import {
  DOCX_SIMPLE,
  DOCX_WITH_PREAMBLE,
  selectionFromBytes,
} from "./parser-test-fixtures.js";
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
    expect("normalizedText" in result ? result.normalizedText : undefined).toContain("Policy");
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a root section for paragraphs before the first heading", async () => {
    const result = await docxParser.parseAsync(
      selectionFromBytes(DOCX_WITH_PREAMBLE, {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions(),
    );
    expect(result.units[0]).toMatchObject({
      kind: "section",
      sectionPath: [],
      characterStart: 0,
    });
    expect(result.units[1]).toMatchObject({
      kind: "section",
      sectionPath: ["Policy"],
    });
    expect("normalizedText" in result ? result.normalizedText : undefined).toContain(
      "Intro paragraph",
    );
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
