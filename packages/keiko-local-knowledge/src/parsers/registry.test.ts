import { describe, expect, it } from "vitest";

import {
  buildParserOptions,
  createParserRegistry,
  registerParser,
  resolveParser,
  unsupportedParser,
} from "./registry.js";
import {
  GZIP_MAGIC,
  PDF_MAGIC,
  PNG_MAGIC,
  ZIP_MAGIC,
  selectionFromBytes,
  selectionFromText,
} from "./parser-test-fixtures.js";
import type { ParserAdapter, ParserOptions, ParserSelectionInput } from "./types.js";
import { emptyResult } from "./_internal.js";

function fakeAdapter(
  parserId: string,
  accept: (input: ParserSelectionInput) => boolean,
): ParserAdapter {
  const capability = { parserId, parserVersion: "1", matches: accept };
  return Object.freeze({
    capability: Object.freeze(capability),
    parse: (input: ParserSelectionInput, options: ParserOptions) =>
      emptyResult(capability, input.documentId, options),
  });
}

function expectUnsupported(unit: import("@oscharko-dev/keiko-contracts").ParsedUnit | undefined): {
  readonly reason: string;
} {
  if (unit?.kind !== "unsupported-media") {
    throw new Error(`expected unsupported-media unit, got ${unit?.kind ?? "undefined"}`);
  }
  return { reason: unit.reason };
}

describe("createParserRegistry", () => {
  it("is empty by default", () => {
    const registry = createParserRegistry();
    expect(registry.list()).toEqual([]);
  });

  it("registers adapters in order without mutating callers", () => {
    const empty = createParserRegistry();
    const one = registerParser(
      empty,
      fakeAdapter("a", () => false),
    );
    const two = registerParser(
      one,
      fakeAdapter("b", () => true),
    );

    expect(empty.list()).toEqual([]);
    expect(one.list()).toHaveLength(1);
    expect(two.list()).toHaveLength(2);
    expect(two.list().map((adapter) => adapter.capability.parserId)).toEqual(["a", "b"]);
  });

  it("returns the first matching adapter", () => {
    let registry = createParserRegistry();
    registry = registerParser(
      registry,
      fakeAdapter("first", () => false),
    );
    registry = registerParser(
      registry,
      fakeAdapter("second", () => true),
    );
    registry = registerParser(
      registry,
      fakeAdapter("third", () => true),
    );

    const resolution = resolveParser(registry, selectionFromText("hello"));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("second");
  });

  it("falls through to the unsupported adapter when no real adapter matches", () => {
    let registry = createParserRegistry();
    registry = registerParser(
      registry,
      fakeAdapter("never", () => false),
    );

    const resolution = resolveParser(
      registry,
      selectionFromBytes(PDF_MAGIC, { extension: "pdf", mediaType: "application/pdf" }),
    );
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("unsupported");
  });

  it("returns unsupported sentinel when no adapter (real or unsupported) matches", () => {
    const registry = createParserRegistry();
    // A bare text/plain selection with no body bytes is NOT classified as unsupported by the
    // unsupported adapter (no extension hit, no magic-byte hit), so resolution returns the
    // explicit no-match branch.
    const input: ParserSelectionInput = {
      documentId: "doc-x" as ReturnType<typeof selectionFromText>["documentId"],
      bytes: new Uint8Array(0),
      extension: "unknown-ext",
      mediaType: "application/x-unknown",
    };
    const resolution = resolveParser(registry, input);
    expect(resolution.kind).toBe("unsupported");
  });

  it("never delegates to the unsupported adapter when a real adapter matches first", () => {
    let registry = createParserRegistry();
    registry = registerParser(
      registry,
      fakeAdapter("real", () => true),
    );
    const resolution = resolveParser(registry, selectionFromBytes(PDF_MAGIC, { extension: "pdf" }));
    expect(resolution.kind).toBe("matched");
    if (resolution.kind !== "matched") throw new Error("unreachable");
    expect(resolution.adapter.capability.parserId).toBe("real");
  });
});

describe("buildParserOptions", () => {
  it("applies defaults", () => {
    const options = buildParserOptions();
    expect(options.maxBytes).toBeGreaterThan(0);
    expect(options.maxUnitsPerDocument).toBeGreaterThan(0);
    expect(options.maxNestingDepth).toBeGreaterThan(0);
    expect(options.maxObjectsPerDocument).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(typeof options.now()).toBe("number");
  });

  it("respects overrides", () => {
    const options = buildParserOptions({
      maxBytes: 10,
      maxNestingDepth: 3,
      maxObjectsPerDocument: 7,
      timeoutMs: 5,
      now: () => 42,
    });
    expect(options.maxBytes).toBe(10);
    expect(options.maxNestingDepth).toBe(3);
    expect(options.maxObjectsPerDocument).toBe(7);
    expect(options.timeoutMs).toBe(5);
    expect(options.now()).toBe(42);
  });

  it("forwards an AbortSignal when supplied", () => {
    const ac = new AbortController();
    const options = buildParserOptions({ signal: ac.signal });
    expect(options.signal).toBe(ac.signal);
  });
});

describe("unsupportedParser", () => {
  function options(): ParserOptions {
    return buildParserOptions({ now: () => 1_000 });
  }

  it("classifies known unsupported extensions", () => {
    const input = selectionFromText("dummy", { extension: "pdf", mediaType: "application/pdf" });
    const result = unsupportedParser.parse(input, options());
    expect(result.units).toHaveLength(1);
    expect(expectUnsupported(result.units[0]).reason).toBe("pdf-not-implemented");
    expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_FORMAT");
    expect(result.diagnostics[0]?.severity).toBe("info");
    expect(result.extractedAt).toBe(1_000);
  });

  it("detects archives via magic bytes without decompression", () => {
    const zipResult = unsupportedParser.parse(selectionFromBytes(ZIP_MAGIC), options());
    expect(zipResult.units).toHaveLength(1);
    expect(expectUnsupported(zipResult.units[0]).reason).toBe("archive-not-decompressed");

    const gzipResult = unsupportedParser.parse(selectionFromBytes(GZIP_MAGIC), options());
    expect(expectUnsupported(gzipResult.units[0]).reason).toBe("archive-not-decompressed");
  });

  it("detects PDF magic bytes even when the extension says .txt", () => {
    const result = unsupportedParser.parse(
      selectionFromBytes(PDF_MAGIC, { extension: "txt", mediaType: "text/plain" }),
      options(),
    );
    expect(expectUnsupported(result.units[0]).reason).toBe("pdf-not-implemented");
  });

  it("detects images via magic bytes", () => {
    const result = unsupportedParser.parse(selectionFromBytes(PNG_MAGIC), options());
    expect(expectUnsupported(result.units[0]).reason).toBe("image-not-supported");
  });

  it("returns unknown-format reason when the adapter is invoked directly without any signal", () => {
    const result = unsupportedParser.parse(selectionFromBytes(new Uint8Array(0)), options());
    expect(expectUnsupported(result.units[0]).reason).toBe("unknown-format");
  });

  it("does not match arbitrary text", () => {
    expect(unsupportedParser.capability.matches(selectionFromText("plain text"))).toBe(false);
  });

  it(".docx with ZIP magic bytes reports docx-not-implemented (extension wins over magic bytes)", () => {
    // .docx files are ZIPs, so without extension precedence they would fall through to
    // the magic-byte path and return "archive-not-decompressed" instead of "docx-not-implemented".
    const result = unsupportedParser.parse(
      selectionFromBytes(ZIP_MAGIC, { extension: "docx" }),
      options(),
    );
    expect(expectUnsupported(result.units[0]).reason).toBe("docx-not-implemented");
  });
});
