// Barrel test for the parser surface (Epic #189, Issue #266). Two contracts:
//   1. Every shipped adapter is reachable from `./parsers/index.js`.
//   2. The default registry composes the four real adapters in a deterministic order, and
//      falls through to the unsupported adapter for known-unsupported formats.

import { describe, expect, it } from "vitest";

import * as parsers from "./index.js";
import {
  DOCX_SIMPLE,
  PDF_TEXT_LAYER,
  selectionFromBytes,
  selectionFromText,
} from "./parser-test-fixtures.js";

describe("parsers barrel", () => {
  it("exposes every shipped adapter", () => {
    expect(parsers.textParser).toBeDefined();
    expect(parsers.jsonParser).toBeDefined();
    expect(parsers.csvParser).toBeDefined();
    expect(parsers.htmlParser).toBeDefined();
    expect(parsers.pdfParser).toBeDefined();
    expect(parsers.docxParser).toBeDefined();
    expect(parsers.unsupportedParser).toBeDefined();
  });

  it("exposes the registry factory functions", () => {
    expect(typeof parsers.createParserRegistry).toBe("function");
    expect(typeof parsers.registerParser).toBe("function");
    expect(typeof parsers.resolveParser).toBe("function");
    expect(typeof parsers.buildParserOptions).toBe("function");
    expect(typeof parsers.createDefaultParserRegistry).toBe("function");
  });

  it("exposes the documented limit constants", () => {
    expect(parsers.DEFAULT_MAX_BYTES).toBeGreaterThan(0);
    expect(parsers.DEFAULT_MAX_UNITS).toBeGreaterThan(0);
    expect(parsers.DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(parsers.PARSER_ERROR_CODES).toContain("OVERSIZED_FILE");
  });
});

describe("createDefaultParserRegistry", () => {
  it("routes JSON to the JSON parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(selectionFromText("{}", { extension: "json" }));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("json");
  });

  it("routes CSV to the CSV parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(selectionFromText("a,b\n1,2", { extension: "csv" }));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("csv");
  });

  it("routes HTML to the HTML parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(selectionFromText("<html></html>", { extension: "html" }));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("html");
  });

  it("routes plain text to the text parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(selectionFromText("hello", { extension: "txt" }));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("text");
  });

  it("routes markdown to the text parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(
      selectionFromText("# H", { extension: "md", mediaType: "text/markdown" }),
    );
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("text");
  });

  it("routes PDF to the PDF parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(selectionFromBytes(PDF_TEXT_LAYER, { extension: "pdf" }));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("pdf");
  });

  it("routes DOCX to the DOCX parser", () => {
    const registry = parsers.createDefaultParserRegistry();
    const resolution = registry.resolve(
      selectionFromBytes(DOCX_SIMPLE, {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("docx");
  });
});
