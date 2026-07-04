import { describe, expect, it } from "vitest";
import {
  SqliteQuickCheckError,
  errorRecord,
  isSqliteCorruptionError,
  sqliteErrorLike,
  sqliteErrorText,
} from "./sqlite-corruption.js";

describe("isSqliteCorruptionError", () => {
  const positives: readonly { readonly name: string; readonly error: unknown }[] = [
    { name: "SQLITE_CORRUPT code", error: { code: "SQLITE_CORRUPT" } },
    { name: "SQLITE_NOTADB code", error: { code: "SQLITE_NOTADB" } },
    { name: "errcode 11 (SQLITE_CORRUPT)", error: { errcode: 11 } },
    { name: "errcode 26 (SQLITE_NOTADB)", error: { errcode: 26 } },
    { name: 'message "file is not a database"', error: new Error("file is not a database") },
    {
      name: "message 'database disk image is malformed'",
      error: new Error("database disk image is malformed"),
    },
    { name: "quick_check failure", error: new SqliteQuickCheckError(["row 1 corrupt"]) },
  ];

  for (const { name, error } of positives) {
    it(`classifies ${name} as corruption`, () => {
      expect(isSqliteCorruptionError(error)).toBe(true);
    });
  }

  const negatives: readonly { readonly name: string; readonly error: unknown }[] = [
    { name: "SQLITE_BUSY code", error: { code: "SQLITE_BUSY" } },
    { name: "errcode 5 (SQLITE_BUSY)", error: { errcode: 5 } },
    { name: "generic Error", error: new Error("disk full") },
    { name: "null", error: null },
    { name: "undefined", error: undefined },
    { name: "plain string", error: "some failure" },
  ];

  for (const { name, error } of negatives) {
    it(`does NOT classify ${name} as corruption`, () => {
      expect(isSqliteCorruptionError(error)).toBe(false);
    });
  }
});

describe("shape helpers", () => {
  it("sqliteErrorLike returns the object for object inputs and {} otherwise", () => {
    const e = { code: "SQLITE_CORRUPT", errcode: 11 };
    expect(sqliteErrorLike(e)).toBe(e);
    expect(sqliteErrorLike("nope")).toEqual({});
    expect(sqliteErrorLike(null)).toEqual({});
  });

  it("sqliteErrorText concatenates the string-valued code/errstr/message", () => {
    const text = sqliteErrorText({
      code: "SQLITE_NOTADB",
      errstr: "file is not a database",
      message: "open failed",
    });
    expect(text).toContain("SQLITE_NOTADB");
    expect(text).toContain("file is not a database");
    expect(text).toContain("open failed");
  });

  it("errorRecord captures class, code, errcode, errstr, and message", () => {
    const record = errorRecord(
      Object.assign(new Error("boom"), { code: "SQLITE_NOTADB", errcode: 26, errstr: "notadb" }),
    );
    expect(record.errorClass).toBe("Error");
    expect(record.code).toBe("SQLITE_NOTADB");
    expect(record.errcode).toBe(26);
    expect(record.errstr).toBe("notadb");
    expect(record.message).toBe("boom");
  });

  it("errorRecord falls back to typeof/String for non-Error inputs", () => {
    const record = errorRecord("plain failure");
    expect(record.errorClass).toBe("string");
    expect(record.message).toBe("plain failure");
    expect(record.code).toBeUndefined();
    expect(record.errcode).toBeUndefined();
  });
});

// The optional unwrap hook lets a wrapping domain error (e.g. keiko-local-knowledge's
// KnowledgeStoreError, which carries the real SQLite error on `.cause`) be classified by its
// underlying cause rather than the wrapper. Without unwrap the wrapper's own (non-corruption) shape
// is inspected; with unwrap the sealed SQLite error underneath drives the verdict.
describe("unwrap hook", () => {
  class WrappingError extends Error {
    constructor(
      message: string,
      override readonly cause: unknown,
    ) {
      super(message);
    }
  }

  const unwrap = (error: unknown): unknown =>
    error instanceof WrappingError && error.cause !== undefined ? error.cause : error;

  it("does NOT see corruption through a wrapper without the hook", () => {
    const wrapped = new WrappingError("store open failed", { code: "SQLITE_CORRUPT" });
    expect(isSqliteCorruptionError(wrapped)).toBe(false);
  });

  it("classifies corruption via the unwrapped cause when the hook is supplied", () => {
    const wrapped = new WrappingError("store open failed", { code: "SQLITE_CORRUPT" });
    expect(isSqliteCorruptionError(wrapped, unwrap)).toBe(true);
  });

  it("errorRecord reports the unwrapped cause's fields when a hook is supplied", () => {
    const inner = Object.assign(new Error("malformed"), { errcode: 11, code: "SQLITE_CORRUPT" });
    const wrapped = new WrappingError("store open failed", inner);
    const record = errorRecord(wrapped, unwrap);
    expect(record.errcode).toBe(11);
    expect(record.code).toBe("SQLITE_CORRUPT");
    expect(record.message).toBe("malformed");
    expect(record.errorClass).toBe("Error");
  });
});
