import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIR_MODE,
  FILE_MODE,
  SafeArtifactFileError,
  chmodIfPresent,
  ensureDirHardened,
  openSafeArtifactFile,
  publishSafeArtifactFileSet,
  replaceSafeArtifactFile,
} from "./fs-hardening.js";

const cleanups: string[] = [];
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-fs-harden-"));
  cleanups.push(dir);
  return dir;
}

describe("mode constants", () => {
  it("pins DIR_MODE to 0o700 and FILE_MODE to 0o600", () => {
    expect(DIR_MODE).toBe(0o700);
    expect(FILE_MODE).toBe(0o600);
  });
});

describe("ensureDirHardened", () => {
  it("creates a missing directory at 0o700 (POSIX)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const target = join(base, "nested", "vault");
    expect(existsSync(target)).toBe(false);
    ensureDirHardened(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("tightens a loose existing directory to 0o700 (POSIX)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const target = join(base, "loose");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o777);
    expect(statSync(target).mode & 0o777).toBe(0o777);
    ensureDirHardened(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("does not throw when the directory already exists and is already tight (POSIX)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const target = join(base, "already-700");
    mkdirSync(target, { mode: 0o700 });
    expect(() => {
      ensureDirHardened(target);
    }).not.toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("does not chmod on win32 (no-op tighten), only ensures existence", () => {
    // Create the dir on the real platform first so mkdir semantics are honoured, then flip to win32
    // and assert ensureDirHardened neither throws nor attempts POSIX tightening.
    const base = freshDir();
    const target = join(base, "win-dir");
    mkdirSync(target);
    setPlatform("win32");
    expect(() => {
      ensureDirHardened(target);
    }).not.toThrow();
    expect(existsSync(target)).toBe(true);
  });
});

describe("chmodIfPresent", () => {
  it("applies the requested mode to an existing file (POSIX)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const file = join(base, "keyfile");
    writeFileSync(file, "x", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    chmodIfPresent(file, FILE_MODE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("swallows ENOENT when the path is absent (best-effort sidecar hardening)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const missing = join(base, "does-not-exist-wal");
    expect(existsSync(missing)).toBe(false);
    expect(() => {
      chmodIfPresent(missing, FILE_MODE);
    }).not.toThrow();
  });

  it("is a no-op on win32 (never invokes chmod)", () => {
    const base = freshDir();
    const missing = join(base, "sidecar-shm");
    setPlatform("win32");
    // On win32 the function must return before touching the filesystem; a missing path must not throw.
    expect(() => {
      chmodIfPresent(missing, FILE_MODE);
    }).not.toThrow();
  });
});

// The chmod-error swallow (a directory/file we cannot chmod) is exercised deterministically by mocking
// node:fs so chmodSync throws EPERM. Both hardening helpers must catch and continue rather than
// propagate — a parent-owned path we cannot tighten beats a hard failure that blocks the store/vault.
describe("chmod-failure swallow (mocked node:fs)", () => {
  it("ensureDirHardened swallows a chmodSync EPERM on an existing dir (POSIX)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: (): boolean => true,
      mkdirSync: (): void => undefined,
      chmodSync: (): never => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    }));
    const mod = await import("./fs-hardening.js");
    setPlatform("linux");
    expect(() => {
      mod.ensureDirHardened("/some/dir");
    }).not.toThrow();
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("chmodIfPresent swallows a chmodSync EPERM (POSIX)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: (): boolean => true,
      mkdirSync: (): void => undefined,
      chmodSync: (): never => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    }));
    const mod = await import("./fs-hardening.js");
    setPlatform("linux");
    expect(() => {
      mod.chmodIfPresent("/some/file", 0o600);
    }).not.toThrow();
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});

describe("openSafeArtifactFile", () => {
  it("refuses final symlinks, hard links, and FIFOs without leaking the target path", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const victim = join(base, "victim");
    writeFileSync(victim, "unchanged", { mode: FILE_MODE });
    chmodSync(victim, 0o640);

    const symlink = join(base, "symlink");
    symlinkSync(victim, symlink);
    const hardLink = join(base, "hard-link");
    linkSync(victim, hardLink);
    const fifo = join(base, "fifo");
    execFileSync("mkfifo", [fifo]);

    for (const hostile of [symlink, hardLink, fifo]) {
      let thrown: unknown;
      try {
        openSafeArtifactFile(hostile, {
          artifactClass: "activity-log",
          mode: "append-existing-or-create",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SafeArtifactFileError);
      expect(String(thrown)).not.toContain(hostile);
      expect(String(thrown)).not.toContain("unchanged");
    }
    expect(readFileSync(victim, "utf8")).toBe("unchanged");
    expect(statSync(victim).mode & 0o777).toBe(0o640);
  });

  it("creates an owner-only regular single-link file", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const path = join(freshDir(), "artifact");
    const descriptor = openSafeArtifactFile(path, {
      artifactClass: "support-bundle",
      mode: "exclusive-create",
    });
    closeSync(descriptor);

    const stat = statSync(path);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o777).toBe(FILE_MODE);
  });

  it("rejects a final pathname replaced after open instead of trusting a precheck", async () => {
    const base = freshDir();
    const path = join(base, "artifact");
    const displaced = join(base, "displaced");
    writeFileSync(path, "original", { mode: FILE_MODE });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        const descriptor = Reflect.apply(actual.openSync, actual, args);
        renameSync(path, displaced);
        writeFileSync(path, "replacement", { mode: FILE_MODE });
        return descriptor;
      },
    }));
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "append-existing-or-create",
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "target-mutated",
      }),
    );
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});

describe("publishSafeArtifactFileSet", () => {
  it("publishes the commit artifact last and recovers an interrupted publication", async () => {
    const base = freshDir();
    const bundle = join(base, "bundle.jsonl");
    const sidecar = `${bundle}.sha256`;
    const entries = [
      { path: sidecar, contents: "digest\n", artifactClass: "support-integrity" as const },
      { path: bundle, contents: "bundle\n", artifactClass: "support-bundle" as const },
    ];
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let links = 0;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      linkSync: (...args: Parameters<typeof actual.linkSync>): void => {
        links += 1;
        if (links === 2) throw Object.assign(new Error("interrupted"), { code: "EINTR" });
        Reflect.apply(actual.linkSync, actual, args);
      },
    }));
    const isolated = await import("./fs-hardening.js");

    expect(() => isolated.publishSafeArtifactFileSet(entries, { commitPath: bundle })).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "publish-failed",
      }),
    );
    expect(existsSync(bundle)).toBe(false);
    expect(readFileSync(sidecar, "utf8")).toBe("digest\n");
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(publishSafeArtifactFileSet(entries, { commitPath: bundle })).toEqual({
      status: "recovered",
    });
    expect(readFileSync(bundle, "utf8")).toBe("bundle\n");
    expect(readFileSync(sidecar, "utf8")).toBe("digest\n");
    expect(statSync(bundle).nlink).toBe(1);
    expect(statSync(sidecar).nlink).toBe(1);
  });

  it("refuses an existing target by default without replacing its bytes", () => {
    const base = freshDir();
    const path = join(base, "fixture.ts");
    writeFileSync(path, "keep", { mode: FILE_MODE });

    expect(() =>
      publishSafeArtifactFileSet([{ path, contents: "replace", artifactClass: "replay-fixture" }], {
        commitPath: path,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "target-exists",
      }),
    );
    expect(readFileSync(path, "utf8")).toBe("keep");
  });
});

describe("replaceSafeArtifactFile", () => {
  it("atomically replaces only a verified private regular file", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const path = join(freshDir(), "manifest.json");
    writeFileSync(path, "old", { mode: FILE_MODE });

    replaceSafeArtifactFile(path, "new", { artifactClass: "manifest" });

    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).nlink).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(FILE_MODE);
  });

  it("refuses a hard-linked replacement target without changing its bytes or mode", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const victim = join(base, "victim");
    const target = join(base, "manifest.json");
    writeFileSync(victim, "keep", { mode: 0o640 });
    chmodSync(victim, 0o640);
    linkSync(victim, target);

    expect(() => {
      replaceSafeArtifactFile(target, "replacement", { artifactClass: "manifest" });
    }).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "unsafe-target",
      }),
    );
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(statSync(victim).mode & 0o777).toBe(0o640);
  });

  it("refuses symlink and non-regular replacement targets", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const victim = join(base, "victim");
    writeFileSync(victim, "keep", { mode: FILE_MODE });
    const symlink = join(base, "manifest-link");
    symlinkSync(victim, symlink);
    const fifo = join(base, "manifest-fifo");
    execFileSync("mkfifo", [fifo]);

    for (const target of [symlink, fifo]) {
      expect(() => {
        replaceSafeArtifactFile(target, "replacement", { artifactClass: "manifest" });
      }).toThrow(
        expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
          kind: "unsafe-target",
        }),
      );
    }
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });
});
