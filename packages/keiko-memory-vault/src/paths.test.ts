import { afterEach, describe, expect, it, vi } from "vitest";
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

// The no-explicit-dir/no-env fallback branch resolves against homedir(), so the only way to
// exercise its path guards is to point homedir() at a temp tree we control. The stub is opt-in:
// while `stubbedHome.path` is undefined every caller — including this file's own `homedir()`
// import — sees the real value, so the pre-existing cases below stay byte-identical.
const stubbedHome = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: (): string => stubbedHome.path ?? actual.homedir(),
  };
});

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), "keiko-mem-paths-"));
}

function emptyEnv(): Readonly<Record<string, string | undefined>> {
  return Object.freeze({});
}

describe("resolveMemoryDir", () => {
  afterEach(() => {
    stubbedHome.path = undefined;
  });

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

  // The default branch is the one taken by essentially every install, and it used to be the ONLY
  // branch that returned a bare join() instead of routing through guard(). A ~/.keiko that is (or
  // becomes) a symlink then silently redirects the encrypted memory DB — and, on the keyfile tier,
  // the plaintext AES-256-GCM vault key — to wherever it points. The two cases below are the
  // default-branch mirrors of the explicit-path symlink rejections already pinned above.
  it("rejects the default path when .keiko itself is a symlink", () => {
    const base = freshTmp();
    const home = join(base, "home");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(home);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, DEFAULT_STATE_DIR));
    stubbedHome.path = home;
    try {
      resolveMemoryDir(undefined, emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      // Rethrown rather than cast: toBeInstanceOf does not narrow `err`, so a cast would read
      // `.code` off whatever was actually thrown and report the wrong reason for the failure.
      if (!(err instanceof MemoryStorageError)) throw err;
      expect(err.code).toBe("invalid-path");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects the default path when .keiko/memory itself is a symlink", () => {
    const base = freshTmp();
    const home = join(base, "home");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(join(home, DEFAULT_STATE_DIR), { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, DEFAULT_STATE_DIR, MEMORY_DIR_NAME));
    stubbedHome.path = home;
    try {
      resolveMemoryDir(undefined, emptyEnv());
      expect.fail("should have thrown");
    } catch (err) {
      if (!(err instanceof MemoryStorageError)) throw err;
      expect(err.code).toBe("invalid-path");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still returns the default path when the home tree is clean", () => {
    const base = freshTmp();
    const home = join(base, "home");
    mkdirSync(join(home, DEFAULT_STATE_DIR), { recursive: true });
    stubbedHome.path = home;
    try {
      expect(resolveMemoryDir(undefined, emptyEnv())).toBe(
        join(home, DEFAULT_STATE_DIR, MEMORY_DIR_NAME),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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
