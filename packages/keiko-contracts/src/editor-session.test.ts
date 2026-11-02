import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EDITOR_SESSION_ERROR_CODES,
  EDITOR_SESSION_SCHEMA_VERSION,
  isEditorDocumentVersion,
  parseEditorDocumentVersion,
  type EditorDocumentVersion,
  type EditorSessionValidation,
} from "./editor-session.js";

const VALID_HASH = "a".repeat(64);

function validVersion(): EditorDocumentVersion {
  return { sizeBytes: 12, modifiedAt: 1_700_000_000_000, contentHash: VALID_HASH };
}

describe("editor-session schema and error codes", () => {
  it("pins the schema version", () => {
    expect(EDITOR_SESSION_SCHEMA_VERSION).toBe("1");
  });

  it("enumerates the stable editor-session error codes in a fixed order", () => {
    // Pins membership, order, and completeness. STALE_SESSION is the new code added by #1197;
    // the first four mirror the codes the file routes already emit.
    expect(EDITOR_SESSION_ERROR_CODES).toEqual([
      "UNSUPPORTED_FILE",
      "FILE_TOO_LARGE",
      "WRITE_CONFLICT",
      "DENIED",
      "STALE_SESSION",
    ]);
  });
});

describe("isEditorDocumentVersion", () => {
  it("accepts a well-formed version and tolerates extra forward-compatible keys", () => {
    expect(isEditorDocumentVersion(validVersion())).toBe(true);
    expect(isEditorDocumentVersion({ ...validVersion(), futureField: "x" })).toBe(true);
  });

  it("accepts the zero boundary for an empty document", () => {
    expect(isEditorDocumentVersion({ sizeBytes: 0, modifiedAt: 0, contentHash: VALID_HASH })).toBe(
      true,
    );
  });

  it("rejects non-objects", () => {
    expect(isEditorDocumentVersion(null)).toBe(false);
    expect(isEditorDocumentVersion("v")).toBe(false);
    expect(isEditorDocumentVersion([validVersion()])).toBe(false);
  });

  it("rejects an invalid sizeBytes, including fractional byte counts", () => {
    expect(isEditorDocumentVersion({ ...validVersion(), sizeBytes: -1 })).toBe(false);
    expect(isEditorDocumentVersion({ ...validVersion(), sizeBytes: 1.5 })).toBe(false);
    expect(isEditorDocumentVersion({ ...validVersion(), sizeBytes: Number.NaN })).toBe(false);
    expect(isEditorDocumentVersion({ ...validVersion(), sizeBytes: "12" })).toBe(false);
  });

  it("rejects an invalid modifiedAt", () => {
    expect(isEditorDocumentVersion({ ...validVersion(), modifiedAt: -5 })).toBe(false);
    expect(
      isEditorDocumentVersion({ ...validVersion(), modifiedAt: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });

  it("rejects a contentHash that is not a 64-char lowercase hex string", () => {
    expect(isEditorDocumentVersion({ ...validVersion(), contentHash: "a".repeat(63) })).toBe(false);
    expect(isEditorDocumentVersion({ ...validVersion(), contentHash: "A".repeat(64) })).toBe(false);
    expect(isEditorDocumentVersion({ ...validVersion(), contentHash: "g".repeat(64) })).toBe(false);
    expect(isEditorDocumentVersion({ ...validVersion(), contentHash: 123 })).toBe(false);
  });
});

describe("parseEditorDocumentVersion", () => {
  it("returns the normalized value on the happy path, dropping extra keys", () => {
    const result = parseEditorDocumentVersion({ ...validVersion(), futureField: "x" });
    expect(result).toEqual({ ok: true, value: validVersion() });
  });

  it("reports the object-shape failure", () => {
    const result = parseEditorDocumentVersion(42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(["baseVersion must be an object"]);
    }
  });

  it("round-trips the zero boundary for an empty document", () => {
    const empty = { sizeBytes: 0, modifiedAt: 0, contentHash: VALID_HASH };
    expect(parseEditorDocumentVersion(empty)).toEqual({ ok: true, value: empty });
  });

  it("accumulates one error per failed invariant", () => {
    const result = parseEditorDocumentVersion({
      sizeBytes: -1,
      modifiedAt: "soon",
      contentHash: "short",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(3);
      expect(result.errors).toContain("baseVersion.sizeBytes must be a non-negative integer");
      expect(result.errors).toContain(
        "baseVersion.modifiedAt must be a finite non-negative number",
      );
      expect(result.errors).toContain(
        "baseVersion.contentHash must be a lowercase hex SHA-256 string",
      );
    }
  });

  it("rejects a fractional sizeBytes with the integer-specific message", () => {
    const result = parseEditorDocumentVersion({ ...validVersion(), sizeBytes: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(["baseVersion.sizeBytes must be a non-negative integer"]);
    }
  });

  it("reports only the single failed invariant when the rest are valid", () => {
    const result = parseEditorDocumentVersion({ ...validVersion(), contentHash: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "baseVersion.contentHash must be a lowercase hex SHA-256 string",
      ]);
    }
  });
});

// #3918 original-first public contract controls.
import {
  parseEditorDocumentVersion as publicDocumentVersionParser,
  type EditorDocumentVersion as PublicEditorDocumentVersion,
  type EditorSessionValidation as PublicEditorSessionValidation,
} from "@oscharko-dev/keiko-contracts/runtime/editor-session";

describe("#3918 actual public owner preservation", () => {
  it("retains the owning result and declared refusal", () => {
    const version = validVersion();
    const parsed = publicDocumentVersionParser(version);
    expect(parsed).toEqual({ ok: true, value: version });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).not.toBe(version);
    expect(publicDocumentVersionParser({ ...version, sizeBytes: 0.5 })).toEqual({
      ok: false,
      errors: ["baseVersion.sizeBytes must be a non-negative integer"],
    });
  });
});

describe.each([
  ["source", parseEditorDocumentVersion],
  ["public", publicDocumentVersionParser],
] as const)("3918 captured document version %s", (_surface, parse) => {
  it.each([
    ["sizeBytes", 0.5, "baseVersion.sizeBytes must be a non-negative integer"],
    ["modifiedAt", Number.NaN, "baseVersion.modifiedAt must be a finite non-negative number"],
    ["contentHash", "bad", "baseVersion.contentHash must be a lowercase hex SHA-256 string"],
  ] as const)("refuses actual copied %s", (field, invalid, diagnostic) => {
    const value = validVersion();
    const initial: unknown = value[field];
    let reads = 0;
    Object.defineProperty(value, field, {
      get: (): unknown => (++reads === 1 ? initial : invalid),
    });
    expect(parse(value)).toEqual({ ok: false, errors: [diagnostic] });
    expect(reads).toBe(2);
  });
  it("preserves fractional modifiedAt and copied field ordering", () => {
    const value = validVersion();
    let reads = 0;
    Object.defineProperty(value, "modifiedAt", { get: (): number => (++reads === 1 ? 1 : 2.5) });
    const parsed = parse(value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("healthy copied version refused");
    expect(parsed.value.modifiedAt).toBe(2.5);
    expect(Object.keys(parsed.value)).toEqual(["sizeBytes", "modifiedAt", "contentHash"]);
    expect(reads).toBe(2);
  });
});

export function parsePublicEditorDocumentVersion(
  input: unknown,
): PublicEditorSessionValidation<PublicEditorDocumentVersion> {
  const result = publicDocumentVersionParser(input);
  return result;
}

describe("editor document version public parser (#3918)", () => {
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf(parseEditorDocumentVersion).parameter(0).toBeUnknown();
    expectTypeOf(publicDocumentVersionParser).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicEditorDocumentVersion).parameter(0).toBeUnknown();
    expectTypeOf(parseEditorDocumentVersion).parameter(0).not.toBeAny();
    expectTypeOf(publicDocumentVersionParser).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicEditorDocumentVersion).parameter(0).not.toBeAny();
    expectTypeOf(parseEditorDocumentVersion).returns.toEqualTypeOf<
      EditorSessionValidation<EditorDocumentVersion>
    >();
    expectTypeOf(publicDocumentVersionParser).returns.toEqualTypeOf<
      PublicEditorSessionValidation<PublicEditorDocumentVersion>
    >();
    expectTypeOf(parsePublicEditorDocumentVersion).returns.toEqualTypeOf<
      PublicEditorSessionValidation<PublicEditorDocumentVersion>
    >();
    expectTypeOf(publicDocumentVersionParser).returns.toEqualTypeOf<
      EditorSessionValidation<EditorDocumentVersion>
    >();
    expectTypeOf(parsePublicEditorDocumentVersion).returns.toEqualTypeOf<
      EditorSessionValidation<EditorDocumentVersion>
    >();
    expectTypeOf(parseEditorDocumentVersion).returns.not.toBeAny();
    expectTypeOf(publicDocumentVersionParser).returns.not.toBeAny();
    expectTypeOf(parsePublicEditorDocumentVersion).returns.not.toBeAny();
    const result = parsePublicEditorDocumentVersion(validVersion());
    if (!result.ok) throw new TypeError("healthy public document version refused");
    expectTypeOf(result.value).toEqualTypeOf<PublicEditorDocumentVersion>();
    expectTypeOf(result.value).not.toBeAny();
    expectTypeOf(result.value.sizeBytes).toEqualTypeOf<number>();
    expectTypeOf(result.value.modifiedAt).toEqualTypeOf<number>();
    expectTypeOf(result.value.contentHash).toEqualTypeOf<string>();
  });

  it("normalizes extra keys into a fresh unfrozen scalar copy", () => {
    const input = { ...validVersion(), futureField: "fixture-private-extra" };
    const result = parsePublicEditorDocumentVersion(input);
    expect(result).toEqual({ ok: true, value: validVersion() });
    if (!result.ok) throw new TypeError("healthy public document version refused");
    expect(result.value).not.toBe(input);
    expect(Object.keys(result.value)).toEqual(["sizeBytes", "modifiedAt", "contentHash"]);
    expect(Object.isFrozen(result.value)).toBe(false);
    expect(input.futureField).toBe("fixture-private-extra");
  });

  it("retains zero size and finite fractional modification times", () => {
    for (const modifiedAt of [0, 0.5, Number.MAX_VALUE]) {
      const input = { sizeBytes: 0, modifiedAt, contentHash: VALID_HASH };
      expect(parsePublicEditorDocumentVersion(input)).toEqual({ ok: true, value: input });
    }
    const input = { ...validVersion(), sizeBytes: Number.MAX_VALUE };
    expect(parsePublicEditorDocumentVersion(input)).toEqual({ ok: true, value: input });
  });

  it("refuses noninteger nonfinite negative and nonnumeric byte sizes", () => {
    for (const sizeBytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "12", null]) {
      expect(parsePublicEditorDocumentVersion({ ...validVersion(), sizeBytes })).toEqual({
        ok: false,
        errors: ["baseVersion.sizeBytes must be a non-negative integer"],
      });
    }
  });

  it("refuses nonfinite negative and nonnumeric modification times", () => {
    for (const modifiedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, "soon", null]) {
      expect(parsePublicEditorDocumentVersion({ ...validVersion(), modifiedAt })).toEqual({
        ok: false,
        errors: ["baseVersion.modifiedAt must be a finite non-negative number"],
      });
    }
  });

  it("admits only lowercase sixty-four-character hexadecimal hashes", () => {
    for (const contentHash of [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      1,
      `${VALID_HASH}\n`,
      `${VALID_HASH}\r`,
      `${VALID_HASH}\r\n`,
      `${VALID_HASH}\u2028`,
      `${VALID_HASH}\u2029`,
    ]) {
      expect(parsePublicEditorDocumentVersion({ ...validVersion(), contentHash })).toEqual({
        ok: false,
        errors: ["baseVersion.contentHash must be a lowercase hex SHA-256 string"],
      });
    }
  });

  it("retains exact ordered errors for missing and malformed members", () => {
    for (const input of [{}, { sizeBytes: -1, modifiedAt: "soon", contentHash: "short" }]) {
      expect(parsePublicEditorDocumentVersion(input)).toEqual({
        ok: false,
        errors: [
          "baseVersion.sizeBytes must be a non-negative integer",
          "baseVersion.modifiedAt must be a finite non-negative number",
          "baseVersion.contentHash must be a lowercase hex SHA-256 string",
        ],
      });
    }
  });

  it("refuses nonrecord inputs before field observation", () => {
    for (const input of [null, undefined, 42, "version", [validVersion()]]) {
      expect(parsePublicEditorDocumentVersion(input)).toEqual({
        ok: false,
        errors: ["baseVersion must be an object"],
      });
    }
  });
});
