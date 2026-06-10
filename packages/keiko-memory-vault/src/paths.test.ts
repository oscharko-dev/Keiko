import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { MemoryStorageError } from "./errors.js";
import {
  DEFAULT_STATE_DIR,
  MEMORY_DB_FILENAME,
  MEMORY_DIR_NAME,
  resolveMemoryDbPath,
  resolveMemoryDir,
} from "./paths.js";

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), "keiko-mem-paths-"));
}

function emptyEnv(): Readonly<Record<string, string | undefined>> {
  return Object.freeze({});
}

describe("resolveMemoryDir", () => {
  it("uses the explicit option when present", () => {
    const dir = freshTmp();
    try {
      expect(resolveMemoryDir(dir, emptyEnv())).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to KEIKO_MEMORY_DIR when no explicit option", () => {
    const dir = freshTmp();
    try {
      expect(resolveMemoryDir(undefined, { KEIKO_MEMORY_DIR: dir })).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("joins KEIKO_STATE_DIR with memory/", () => {
    const dir = freshTmp();
    try {
      expect(resolveMemoryDir(undefined, { KEIKO_STATE_DIR: dir })).toBe(
        join(dir, MEMORY_DIR_NAME),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects KEIKO_STATE_DIR when the derived memory/ directory is a symlink", () => {
    const base = freshTmp();
    const stateDir = join(base, "state");
    const real = join(base, "real-memory");
    mkdirSync(stateDir);
    mkdirSync(real);
    symlinkSync(real, join(stateDir, MEMORY_DIR_NAME));
    try {
      resolveMemoryDir(undefined, { KEIKO_STATE_DIR: stateDir });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MemoryStorageError).code).toBe("invalid-path");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to homedir()/.keiko/memory when nothing configured", () => {
    expect(resolveMemoryDir(undefined, emptyEnv())).toBe(
      join(homedir(), DEFAULT_STATE_DIR, MEMORY_DIR_NAME),
    );
  });

  it("rejects relative paths", () => {
    try {
      resolveMemoryDir("relative/path", emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryStorageError);
      expect((err as MemoryStorageError).code).toBe("invalid-path");
    }
  });

  it("rejects paths inside the current working directory", () => {
    const inside = join(process.cwd(), "child");
    try {
      resolveMemoryDir(inside, emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MemoryStorageError).code).toBe("invalid-path");
    }
  });

  it("allows the gitignored workspace .keiko runtime root", () => {
    const runtimeDir = join(process.cwd(), DEFAULT_STATE_DIR, MEMORY_DIR_NAME);
    expect(resolveMemoryDir(runtimeDir, emptyEnv())).toBe(runtimeDir);
  });

  it("rejects a symlinked target", () => {
    const base = freshTmp();
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      resolveMemoryDir(link, emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MemoryStorageError).code).toBe("invalid-path");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects an explicit path containing a NUL byte (CWE-22 path-traversal bypass)", () => {
    try {
      resolveMemoryDir("/tmp/legit\0/etc/passwd", emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryStorageError);
      expect((err as MemoryStorageError).code).toBe("invalid-path");
      expect((err as MemoryStorageError).message).toMatch(/NUL bytes/);
    }
  });

  it("rejects KEIKO_MEMORY_DIR containing a NUL byte", () => {
    try {
      resolveMemoryDir(undefined, { KEIKO_MEMORY_DIR: "/tmp/legit\0/etc" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MemoryStorageError).code).toBe("invalid-path");
    }
  });

  it("rejects a path under a symlinked ancestor", () => {
    const base = freshTmp();
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      resolveMemoryDir(join(link, "child"), emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MemoryStorageError).code).toBe("invalid-path");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("resolveMemoryDbPath", () => {
  it("composes the resolver with the DB filename", () => {
    const dir = freshTmp();
    try {
      expect(resolveMemoryDbPath(dir, emptyEnv())).toBe(join(dir, MEMORY_DB_FILENAME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
