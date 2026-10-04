import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSqliteStatePath, SqliteStatePathError } from "./fs-hardening.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const roots: string[] = [];
afterEach((): void => {
  vi.mocked(lstatSync).mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-sqlite-failure-"));
  roots.push(root);
  return join(root, "state.db");
}

describe("SQLite path preflight failures", (): void => {
  it("accepts missing database and sidecar paths without creating them", (): void => {
    const path = databasePath();
    expect(() => {
      assertSqliteStatePath(path);
    }).not.toThrow();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(() => lstatSync(`${path}${suffix}`)).toThrow();
    }
  });

  it("accepts regular single-link database and sidecar files without changing them", (): void => {
    const path = databasePath();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      writeFileSync(`${path}${suffix}`, "preserved");
    }
    expect(() => {
      assertSqliteStatePath(path);
    }).not.toThrow();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(readFileSync(`${path}${suffix}`, "utf8")).toBe("preserved");
    }
  });

  it("refuses NUL paths even without a diagnostic sink", (): void => {
    expect(() => {
      assertSqliteStatePath("state\0.db");
    }).toThrow(new SqliteStatePathError("unsafe-target"));
  });

  it("preserves refusal when the diagnostic sink throws and reports logging loss", (): void => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
    const write = vi.fn((): never => {
      throw new Error("sink unavailable");
    });
    expect(() => {
      assertSqliteStatePath("state\0.db", { store: "ui", sink: { write } });
    }).toThrow(new SqliteStatePathError("unsafe-target"));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "sqlite.state-path.refused",
        extra: {
          store: "ui",
          failureKind: "unsafe-target",
          completeness: "complete",
          loss: "none",
        },
      }),
    );
    expect(warning).toHaveBeenCalledExactlyOnceWith("SQLite path refusal logging failed.", {
      code: "KEIKO_LOG_SINK_FAILED",
    });
  });

  it("refuses unreadable metadata instead of treating it as a missing path", (): void => {
    const path = databasePath();
    vi.mocked(lstatSync).mockImplementationOnce((): never => {
      throw Object.assign(new Error("metadata denied"), { code: "EACCES" });
    });
    const write = vi.fn();
    expect(() => {
      assertSqliteStatePath(path, { store: "memory-vault", sink: { write } });
    }).toThrow(new SqliteStatePathError("open-failed"));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: {
          store: "memory-vault",
          failureKind: "open-failed",
          completeness: "complete",
          loss: "none",
        },
      }),
    );
    expect(JSON.stringify(write.mock.calls)).not.toContain(path);
  });

  it("refuses a file in the ancestor chain", (): void => {
    const path = databasePath();
    writeFileSync(path, "");
    expect(() => {
      assertSqliteStatePath(join(path, "nested.db"));
    }).toThrow(new SqliteStatePathError("unsafe-ancestor"));
  });

  it.each(["", "-wal", "-shm", "-journal"])(
    "refuses a directory at the database or %s sidecar path",
    (suffix): void => {
      const path = databasePath();
      mkdirSync(`${path}${suffix}`);
      expect(() => {
        assertSqliteStatePath(path);
      }).toThrow(new SqliteStatePathError("unsafe-target"));
    },
  );
});
