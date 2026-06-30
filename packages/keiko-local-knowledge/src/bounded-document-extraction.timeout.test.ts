import { describe, expect, it, vi } from "vitest";

import type { BoundedDocumentExtractionOptions } from "./bounded-document-extraction.js";

vi.mock(
  "./parsers/docx-parser.js",
  (): {
    readonly docxParser: {
      readonly capability: {
        readonly parserId: "docx";
        readonly parserVersion: "test";
        readonly matches: () => boolean;
      };
      readonly parse: () => never;
      readonly parseAsync: () => Promise<never>;
    };
  } => ({
    docxParser: {
      capability: {
        parserId: "docx",
        parserVersion: "test",
        matches: (): boolean => true,
      },
      parse: (): never => {
        throw new Error("sync parser is not used by bounded extraction");
      },
      parseAsync: (): Promise<never> => new Promise<never>(() => undefined),
    },
  }),
);

function options(
  overrides: Partial<BoundedDocumentExtractionOptions> = {},
): BoundedDocumentExtractionOptions {
  return {
    maxInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 32 * 1024,
    maxUnits: 5_000,
    timeoutMs: 10,
    now: () => 0,
    ...overrides,
  };
}

describe("extractBoundedDocumentText timeout deadline", () => {
  it("returns timed-out even when the parser ignores the abort signal", async () => {
    const { extractBoundedDocumentText } = await import("./bounded-document-extraction.js");
    const result = await extractBoundedDocumentText(
      { bytes: new Uint8Array([1, 2, 3]), extension: "docx" },
      options(),
    );

    expect(result.outcome).toBe("timed-out");
    expect(result.format).toBe("docx");
    expect(result.text).toBe("");
  });
});
