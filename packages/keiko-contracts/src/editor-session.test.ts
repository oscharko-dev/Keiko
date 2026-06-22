import { describe, expect, it } from "vitest";
import {
  EDITOR_SESSION_ERROR_CODES,
  EDITOR_SESSION_SCHEMA_VERSION,
  isEditorDocumentVersion,
  parseEditorDocumentVersion,
  type EditorDocumentVersion,
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
