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

// ── 0.3.0 audit item 6: the persisted quarantine diagnostic is hardened ────────
//
// `errorRecord` output is written VERBATIM into `<db>.corrupt.<ts>.diagnostic.json` by three stores,
// so it is a persistence boundary. It used to emit the raw `cause.message`, a wholesale
// `String(cause)` for non-Errors, and an unhardened mutable `cause.name`.
describe("errorRecord hardening (persisted quarantine diagnostic)", () => {
  // Fragmented literals so this source file contains no contiguous credential pattern.
  const API_KEY = ["sk-", "proj", "_", "AbCDef0123456789", "GhIjKl"].join("");
  const DSN_PASSWORD = "hunter2SuperSecret";

  it("redacts credential-shaped content out of a SQLite error message", () => {
    const record = errorRecord(
      new Error(
        `unable to open database: dsn=postgres://ops:${DSN_PASSWORD}@db.internal:5432/keiko api_key=${API_KEY}`,
      ),
    );
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(DSN_PASSWORD);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts the SQLite code and errstr fields too, not just the message", () => {
    const record = errorRecord({
      code: `SQLITE_CANTOPEN api_key=${API_KEY}`,
      errstr: `unable to open database file for ${API_KEY}`,
      message: "open failed",
    });
    expect(JSON.stringify(record)).not.toContain(API_KEY);
  });

  it("caps an oversized message instead of persisting it whole", () => {
    const record = errorRecord(new Error("x".repeat(20_000)));
    expect(typeof record.message).toBe("string");
    expect(String(record.message).length).toBeLessThanOrEqual(513);
  });

  it("never admits request-derived text through the mutable `name` property", () => {
    const hostile = Object.assign(new Error("boom"), {
      name: `Injected ${API_KEY} <script>${"A".repeat(500)}`,
    });
    const record = errorRecord(hostile);
    expect(record.errorClass).toBe("Error");
    expect(JSON.stringify(record)).not.toContain(API_KEY);
    expect(JSON.stringify(record)).not.toContain("<script>");
  });

  it("keeps an over-long but identifier-shaped name out of the record", () => {
    const record = errorRecord(Object.assign(new Error("boom"), { name: "A".repeat(200) }));
    expect(record.errorClass).toBe("Error");
  });

  it("never invokes a hostile value's own toString", () => {
    let called = false;
    const hostile = {
      code: "SQLITE_CORRUPT",
      toString: (): string => {
        called = true;
        return API_KEY;
      },
    };
    const record = errorRecord(hostile);
    expect(called).toBe(false);
    expect(record.message).toBe("[object]");
    expect(JSON.stringify(record)).not.toContain(API_KEY);
  });

  it("does not let a throwing toString or accessor take the quarantine write down", () => {
    const throwingToString = {
      toString: (): string => {
        throw new Error("toString exploded");
      },
    };
    expect(() => errorRecord(throwingToString)).not.toThrow();

    const throwingName = new Error("boom");
    Object.defineProperty(throwingName, "name", {
      get: (): string => {
        throw new Error("name accessor exploded");
      },
    });
    expect(() => errorRecord(throwingName)).not.toThrow();
    expect(errorRecord(throwingName).errorClass).toBe("Error");
  });

  it("renders null, undefined, and primitives without stringifying an object", () => {
    expect(errorRecord(null).message).toBe("null");
    expect(errorRecord(undefined).message).toBe("undefined");
    expect(errorRecord(42).message).toBe("42");
    expect(errorRecord(true).message).toBe("true");
    expect(errorRecord([1, 2, 3]).message).toBe("[object]");
  });

  it("preserves a declared subclass name that is identifier-shaped", () => {
    expect(errorRecord(new SqliteQuickCheckError(["row 1 corrupt"])).errorClass).toBe(
      "SqliteQuickCheckError",
    );
    expect(errorRecord(new TypeError("bad type")).errorClass).toBe("TypeError");
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
