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
import { dirname, join } from "node:path";
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

async function leaveLinkedPublication(base: string, path: string): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    ...actual,
    unlinkSync: (): never => {
      throw new Error(`unlink failed: ${path}`);
    },
  }));
  const isolated = await import("./fs-hardening.js");
  let thrown: unknown;
  try {
    isolated.publishSafeArtifactFileSet(
      [{ path, contents: "report", artifactClass: "support-report" }],
      { commitPath: path, trustedRoot: base },
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toEqual(expect.objectContaining({ kind: "publish-failed" }));
  expect(String(thrown)).not.toContain(base);
  expect(statSync(path).nlink).toBe(2);
  vi.doUnmock("node:fs");
  vi.resetModules();
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
  it("rejects paths outside the declared root and symlinked ancestors", () => {
    const base = freshDir();
    const outside = freshDir();
    expect(() =>
      openSafeArtifactFile(join(outside, "artifact"), {
        artifactClass: "activity-log",
        mode: "exclusive-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-ancestor" }));

    const realParent = join(base, "real-parent");
    const linkedParent = join(base, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    expect(() =>
      openSafeArtifactFile(join(linkedParent, "artifact"), {
        artifactClass: "activity-log",
        mode: "exclusive-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-ancestor" }));
  });

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
          trustedRoot: base,
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
      artifactClass: "support-report",
      mode: "exclusive-create",
      trustedRoot: dirname(path),
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
        if (String(args[0]) === path) {
          renameSync(path, displaced);
          writeFileSync(path, "replacement", { mode: FILE_MODE });
        }
        return descriptor;
      },
    }));
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "append-existing-or-create",
        trustedRoot: base,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "target-mutated",
      }),
    );
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("rejects a parent directory replaced after the target is opened", async () => {
    const base = freshDir();
    const parent = join(base, "parent");
    const displaced = join(base, "displaced-parent");
    const path = join(parent, "artifact");
    mkdirSync(parent);
    writeFileSync(path, "original", { mode: FILE_MODE });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        const descriptor = Reflect.apply(actual.openSync, actual, args);
        if (String(args[0]) === path) {
          renameSync(parent, displaced);
          mkdirSync(parent);
          writeFileSync(path, "replacement", { mode: FILE_MODE });
        }
        return descriptor;
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "append-existing-or-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
  });

  it("uses the explicit symlink fallback for mocked Windows reparse points", async () => {
    const base = freshDir();
    const victim = join(base, "victim");
    const target = join(base, "reparse");
    writeFileSync(victim, "keep", { mode: FILE_MODE });
    symlinkSync(victim, target);
    vi.resetModules();
    const isolated = await import("./fs-hardening.js");
    setPlatform("win32");
    expect(() =>
      isolated.openSafeArtifactFile(target, {
        artifactClass: "activity-log",
        mode: "append-existing-or-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-target" }));
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  it("maps descriptor close failures without echoing paths", async () => {
    const base = freshDir();
    const path = join(base, "artifact");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      closeSync: (): never => {
        throw new Error(`close failed: ${path}`);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    let thrown: unknown;
    try {
      isolated.openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "exclusive-create",
        trustedRoot: base,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(expect.objectContaining({ kind: "close-failed" }));
    expect(String(thrown)).not.toContain(base);
  });
});

describe("publishSafeArtifactFileSet", () => {
  it("publishes the commit artifact last and recovers an interrupted publication", async () => {
    const base = freshDir();
    const bundle = join(base, "bundle.jsonl");
    const sidecar = `${bundle}.sha256`;
    const entries = [
      { path: bundle, contents: "bundle\n", artifactClass: "support-report" as const },
      { path: sidecar, contents: "digest\n", artifactClass: "integrity-artifact" as const },
    ];
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let links = 0;
    const destinations: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      linkSync: (...args: Parameters<typeof actual.linkSync>): void => {
        links += 1;
        destinations.push(String(args[1]));
        if (links === 2) throw Object.assign(new Error("interrupted"), { code: "EINTR" });
        Reflect.apply(actual.linkSync, actual, args);
      },
    }));
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(entries, { commitPath: bundle, trustedRoot: base }),
    ).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "publish-failed",
      }),
    );
    expect(destinations).toEqual([sidecar, bundle]);
    expect(existsSync(bundle)).toBe(false);
    expect(readFileSync(sidecar, "utf8")).toBe("digest\n");
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(publishSafeArtifactFileSet(entries, { commitPath: bundle, trustedRoot: base })).toEqual({
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
        trustedRoot: base,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "target-exists",
      }),
    );
    expect(readFileSync(path, "utf8")).toBe("keep");
  });

  it("refuses a target that appears at the atomic link boundary", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      linkSync: (...args: Parameters<typeof actual.linkSync>): void => {
        writeFileSync(String(args[1]), "attacker", { mode: FILE_MODE });
        Reflect.apply(actual.linkSync, actual, args);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    let thrown: unknown;
    try {
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(expect.objectContaining({ kind: "target-exists" }));
    expect(String(thrown)).not.toContain(base);
    expect(readFileSync(path, "utf8")).toBe("attacker");
  });

  it("rejects parent replacement across the atomic publication link", async () => {
    const base = freshDir();
    const parent = join(base, "reports");
    const displaced = join(base, "displaced-reports");
    const path = join(parent, "report.json");
    mkdirSync(parent);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      linkSync: (...args: Parameters<typeof actual.linkSync>): void => {
        Reflect.apply(actual.linkSync, actual, args);
        renameSync(parent, displaced);
        mkdirSync(parent);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    expect(existsSync(path)).toBe(false);
  });

  it("recovers a partial stage left by a body-free write failure", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let calls = 0;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
        calls += 1;
        if (calls === 1) {
          const typed = args as [number, Uint8Array, number, number, number | null];
          return actual.writeSync(typed[0], typed[1], typed[2], 2, typed[4]);
        }
        throw Object.assign(new Error(`write failed: ${path}`), { code: "EIO" });
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "write-failed" }));
    vi.doUnmock("node:fs");
    vi.resetModules();
    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({ status: "recovered" });
    expect(readFileSync(path, "utf8")).toBe("report");
  });

  it("recovers a complete stage after an fsync failure", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      fsyncSync: (): never => {
        throw new Error(`fsync failed: ${path}`);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "durability-failed" }));
    vi.doUnmock("node:fs");
    vi.resetModules();
    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({ status: "recovered" });
  });

  it("recovers a crash after link and before recovery-marker unlink", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    await leaveLinkedPublication(base, path);

    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({ status: "recovered" });
    expect(readFileSync(path, "utf8")).toBe("report");
    expect(statSync(path).nlink).toBe(1);
  });

  it("loops short reads while validating linked recovery content", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    await leaveLinkedPublication(base, path);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      readSync: (...args: Parameters<typeof actual.readSync>): number => {
        const typed = args as [number, Uint8Array, number, number, number | null];
        return actual.readSync(typed[0], typed[1], typed[2], Math.min(2, typed[3]), typed[4]);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toEqual({ status: "recovered" });
    expect(readFileSync(path, "utf8")).toBe("report");
  });

  it("classifies unsupported hard-link publication without path disclosure", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      linkSync: (): never => {
        throw Object.assign(new Error(`cross-device: ${path}`), { code: "EXDEV" });
      },
    }));
    const isolated = await import("./fs-hardening.js");
    let thrown: unknown;
    try {
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(String(thrown)).not.toContain(base);
  });

  it("maps an initial path inspection failure without path disclosure", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      lstatSync: (
        ...args: Parameters<typeof actual.lstatSync>
      ): ReturnType<typeof actual.lstatSync> => {
        if (String(args[0]).includes(".keiko-publish-")) {
          throw Object.assign(new Error(`inspect failed: ${path}`), { code: "EPERM" });
        }
        return Reflect.apply(actual.lstatSync, actual, args);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    let thrown: unknown;
    try {
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(expect.objectContaining({ kind: "open-failed" }));
    expect(String(thrown)).not.toContain(base);
  });
});

describe("replaceSafeArtifactFile", () => {
  it("fails closed when atomic verified replacement is unsupported on Windows", () => {
    const base = freshDir();
    const path = join(base, "manifest.json");
    writeFileSync(path, "old", { mode: FILE_MODE });
    setPlatform("win32");

    expect(() => {
      replaceSafeArtifactFile(path, "new", {
        artifactClass: "manifest",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  it("atomically replaces only a verified private regular file", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const path = join(freshDir(), "manifest.json");
    writeFileSync(path, "old", { mode: FILE_MODE });

    replaceSafeArtifactFile(path, "new", {
      artifactClass: "manifest",
      trustedRoot: dirname(path),
    });

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
      replaceSafeArtifactFile(target, "replacement", {
        artifactClass: "manifest",
        trustedRoot: base,
      });
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
        replaceSafeArtifactFile(target, "replacement", {
          artifactClass: "manifest",
          trustedRoot: base,
        });
      }).toThrow(
        expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
          kind: "unsafe-target",
        }),
      );
    }
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });
});
