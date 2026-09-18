import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT,
  type SafeArtifactDirectoryMutationOperation,
  type SafeArtifactDirectoryMutationRequest,
} from "./safe-artifact-directory-mutation-protocol.js";
import {
  DIR_MODE,
  FILE_MODE,
  MAX_SAFE_ARTIFACT_RECOVERY_ENTRY_BYTES,
  MAX_SAFE_ARTIFACT_RECOVERY_PUBLICATION_BYTES,
  SafeArtifactFileError,
  acknowledgeSafeArtifactFileSet,
  archiveSafeArtifactFile,
  chmodIfPresent,
  ensureDirHardened,
  isSafeArtifactClass,
  isSafeArtifactFailureKind,
  openSafeArtifactFile,
  publishSafeArtifactFileSet,
  recoverSafeArtifactFileSet,
  removeSafeArtifactFile,
  replaceSafeArtifactFile,
  safeArtifactContainmentAssurance,
  safeArtifactPublicationSlot,
  safeArtifactPermissionAssurance,
} from "./fs-hardening.js";

const cleanups: string[] = [];
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.useRealTimers();
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface DirectoryMutationInvocation {
  readonly operation: SafeArtifactDirectoryMutationOperation;
  readonly sourcePath: string;
  readonly targetPath: string | undefined;
}

type DirectoryMutationHook = (
  invocation: DirectoryMutationInvocation,
  perform: () => void,
) => number;

function requestFromInput(input: unknown): SafeArtifactDirectoryMutationRequest | undefined {
  if (typeof input !== "string") return undefined;
  const value = JSON.parse(input) as unknown;
  if (typeof value !== "object" || value === null || !("operation" in value)) return undefined;
  return value as SafeArtifactDirectoryMutationRequest;
}

function invocationFromSpawnOptions(
  options: Parameters<(typeof import("node:child_process"))["spawnSync"]>[2],
): DirectoryMutationInvocation | undefined {
  const request = requestFromInput(options?.input);
  const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
  if (request === undefined || cwd === undefined) return undefined;
  return {
    operation: request.operation,
    sourcePath: join(cwd, request.source),
    targetPath: request.target === undefined ? undefined : join(cwd, request.target),
  };
}

function performMutation(
  fs: typeof import("node:fs"),
  invocation: DirectoryMutationInvocation,
): void {
  if (invocation.operation === "unlink") {
    fs.unlinkSync(invocation.sourcePath);
    return;
  }
  if (invocation.targetPath === undefined) throw new Error("expected mutation target");
  if (invocation.operation === "link") {
    fs.linkSync(invocation.sourcePath, invocation.targetPath);
  } else {
    fs.renameSync(invocation.sourcePath, invocation.targetPath);
  }
}

function mockedMutationResult(
  status: number,
): ReturnType<typeof import("node:child_process").spawnSync> {
  return {
    pid: 0,
    output: [null, null, null],
    stdout: null,
    stderr: null,
    status,
    signal: null,
  } as unknown as ReturnType<typeof import("node:child_process").spawnSync>;
}

async function mockDirectoryMutation(hook: DirectoryMutationHook): Promise<void> {
  const actualChild =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:child_process", () => ({
    ...actualChild,
    spawnSync: (
      ...args: Parameters<typeof actualChild.spawnSync>
    ): ReturnType<typeof actualChild.spawnSync> => {
      const invocation = invocationFromSpawnOptions(args[2]);
      if (invocation === undefined) {
        return Reflect.apply(actualChild.spawnSync, actualChild, args);
      }
      const status = hook(invocation, () => {
        performMutation(actualFs, invocation);
      });
      return mockedMutationResult(status);
    },
  }));
}

type MutationPredicate = (invocation: DirectoryMutationInvocation) => boolean;

async function swapBeforeDirectoryMutation(
  predicate: MutationPredicate,
  swap: (invocation: DirectoryMutationInvocation) => void,
  after: (invocation: DirectoryMutationInvocation) => void = () => undefined,
  failFsync: () => boolean = () => false,
): Promise<void> {
  const actualChild =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let swapped = false;
  const trigger = (invocation: DirectoryMutationInvocation): void => {
    if (swapped || !predicate(invocation)) return;
    swapped = true;
    swap(invocation);
  };
  vi.doMock("node:fs", () => ({
    ...actualFs,
    linkSync: (source: string, target: string): void => {
      const invocation = { operation: "link", sourcePath: source, targetPath: target } as const;
      trigger(invocation);
      actualFs.linkSync(source, target);
      after(invocation);
    },
    unlinkSync: (source: string): void => {
      const invocation = {
        operation: "unlink",
        sourcePath: source,
        targetPath: undefined,
      } as const;
      trigger(invocation);
      actualFs.unlinkSync(source);
      after(invocation);
    },
    fsyncSync: (descriptor: number): void => {
      if (failFsync()) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      actualFs.fsyncSync(descriptor);
    },
  }));
  vi.doMock("node:child_process", () => ({
    ...actualChild,
    spawnSync: (
      ...args: Parameters<typeof actualChild.spawnSync>
    ): ReturnType<typeof actualChild.spawnSync> => {
      const invocation = invocationFromSpawnOptions(args[2]);
      if (invocation !== undefined) trigger(invocation);
      const result = Reflect.apply(actualChild.spawnSync, actualChild, args);
      if (invocation !== undefined && result.status === 0) after(invocation);
      return result;
    },
  }));
}

function replaceParentWithOutsideLink(parent: string, displaced: string, outside: string): void {
  renameSync(parent, displaced);
  symlinkSync(outside, parent, "dir");
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-fs-harden-"));
  cleanups.push(dir);
  return dir;
}

function byteCountFixture(byteLength: number): Uint8Array {
  return new Proxy(new Uint8Array(0), {
    get: (target, property): unknown =>
      property === "byteLength" ? byteLength : Reflect.get(target, property, target),
  });
}

async function leaveLinkedPublication(base: string, path: string): Promise<void> {
  vi.resetModules();
  await mockDirectoryMutation((invocation, perform) => {
    if (invocation.operation === "unlink") {
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
    }
    perform();
    return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
  });
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
  vi.doUnmock("node:child_process");
  vi.resetModules();
}

function publicationStages(base: string): readonly string[] {
  return readdirSync(base).filter((name) => name.startsWith(".keiko-publish-"));
}

function artifactDirectorySnapshot(
  base: string,
): readonly { readonly name: string; readonly bytes: string; readonly mode: number }[] {
  return readdirSync(base)
    .sort()
    .map((name) => ({
      name,
      bytes: readFileSync(join(base, name)).toString("base64"),
      mode: statSync(join(base, name)).mode & 0o777,
    }));
}

async function failPublicationFsyncAt(base: string, path: string, failAt: number): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let calls = 0;
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
      calls += 1;
      if (calls === failAt)
        throw Object.assign(new Error(`fsync failed: ${path}`), { code: "EIO" });
      Reflect.apply(actual.fsyncSync, actual, args);
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
}

describe("mode constants", () => {
  it("pins DIR_MODE to 0o700 and FILE_MODE to 0o600", () => {
    expect(DIR_MODE).toBe(0o700);
    expect(FILE_MODE).toBe(0o600);
  });

  it("maps invalid runtime error fields into the closed body-free vocabulary", () => {
    const error = new SafeArtifactFileError("/private/customer/path", "raw syscall prose");
    expect(error).toMatchObject({ artifactClass: "manifest", kind: "open-failed" });
    expect(String(error)).not.toContain("customer");
    expect(String(error)).not.toContain("syscall prose");
  });

  it("exports the canonical closed-vocabulary guards for artifact failure consumers", () => {
    expect(isSafeArtifactClass("support-report")).toBe(true);
    expect(isSafeArtifactClass("customer-report")).toBe(false);
    expect(isSafeArtifactFailureKind("durability-failed")).toBe(true);
    expect(isSafeArtifactFailureKind("disk exploded")).toBe(false);
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
  it("keeps group-readable non-writable directories valid for support artifacts", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const path = join(base, "support.json");
    chmodSync(base, 0o750);

    const descriptor = openSafeArtifactFile(path, {
      artifactClass: "support-report",
      mode: "exclusive-create",
      trustedRoot: base,
    });
    closeSync(descriptor);

    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(FILE_MODE);
  });

  it("rejects a writable POSIX ancestor before creating the target", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const writable = join(base, "writable");
    const path = join(writable, "artifact");
    mkdirSync(writable, { mode: 0o777 });
    chmodSync(writable, 0o777);

    expect(() =>
      openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "exclusive-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-ancestor" }));
    expect(existsSync(path)).toBe(false);
  });

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

  it("rejects a private file owned by a different POSIX user", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const path = join(base, "artifact");
    writeFileSync(path, "existing", { mode: FILE_MODE });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      fstatSync: (
        ...args: Parameters<typeof actual.fstatSync>
      ): ReturnType<typeof actual.fstatSync> => {
        const stat = Reflect.apply(actual.fstatSync, actual, args);
        if (typeof stat.uid !== "bigint" || !stat.isFile()) return stat;
        Object.defineProperty(stat, "uid", { value: stat.uid + 1n });
        return stat;
      },
    }));
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.openSafeArtifactFile(path, {
        artifactClass: "activity-log",
        mode: "append-existing-or-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "permission-unsafe" }));
    expect(readFileSync(path, "utf8")).toBe("existing");
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
    const base = realpathSync(freshDir());
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

  it("does not chmod or write an outside append victim during a parent redirect", async () => {
    const base = freshDir();
    const parent = join(base, "reports");
    const displaced = join(base, "reports-displaced");
    const escape = freshDir();
    const path = join(parent, "report.json");
    const outside = join(escape, "report.json");
    mkdirSync(parent);
    writeFileSync(outside, "keep", { mode: 0o640 });
    chmodSync(outside, 0o640);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let redirected = false;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        if (String(args[0]) !== path) return Reflect.apply(actual.openSync, actual, args);
        renameSync(parent, displaced);
        symlinkSync(escape, parent);
        redirected = true;
        return Reflect.apply(actual.openSync, actual, args);
      },
      lstatSync: (
        ...args: Parameters<typeof actual.lstatSync>
      ): ReturnType<typeof actual.lstatSync> => {
        const result = Reflect.apply(actual.lstatSync, actual, args);
        if (redirected && String(args[0]) === parent) {
          rmSync(parent);
          renameSync(displaced, parent);
          redirected = false;
        }
        return result;
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.openSafeArtifactFile(path, {
        artifactClass: "support-report",
        mode: "append-existing-or-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    if (existsSync(displaced)) {
      rmSync(parent);
      renameSync(displaced, parent);
    }
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(statSync(outside).mode & 0o777).toBe(0o640);
    expect(existsSync(path)).toBe(false);
  });

  it("fails containment before content can escape when a missing target parent redirects", async () => {
    const base = freshDir();
    const parent = join(base, "reports");
    const displaced = join(base, "reports-displaced");
    const escape = freshDir();
    const path = join(parent, "report.json");
    const outside = join(escape, "report.json");
    mkdirSync(parent);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let redirected = false;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        if (String(args[0]) !== path) return Reflect.apply(actual.openSync, actual, args);
        renameSync(parent, displaced);
        symlinkSync(escape, parent);
        redirected = true;
        return Reflect.apply(actual.openSync, actual, args);
      },
      lstatSync: (
        ...args: Parameters<typeof actual.lstatSync>
      ): ReturnType<typeof actual.lstatSync> => {
        const result = Reflect.apply(actual.lstatSync, actual, args);
        if (redirected && String(args[0]) === parent) {
          rmSync(parent);
          renameSync(displaced, parent);
          redirected = false;
        }
        return result;
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.openSafeArtifactFile(path, {
        artifactClass: "support-report",
        mode: "exclusive-create",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    if (existsSync(displaced)) {
      rmSync(parent);
      renameSync(displaced, parent);
    }
    expect(safeArtifactContainmentAssurance()).toBe("private-root-guarded");
    expect(readFileSync(outside)).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe("publishSafeArtifactFileSet", () => {
  it("rejects reserved fixed-slot output names before writing an intent", () => {
    const base = freshDir();
    const path = join(base, ".keiko-publish-customer-output");
    const slot = safeArtifactPublicationSlot("support-export", path);
    expect(() =>
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
        publicationSlot: slot,
      }),
    ).toThrow(expect.objectContaining({ kind: "invalid-publication" }));
    expect(readdirSync(base)).toEqual([]);
  });

  it("rejects per-entry and aggregate fixed-slot byte bounds before writing an intent", () => {
    const base = freshDir();
    const paths = ["one", "two", "three"].map((name) => join(base, name));
    const first = paths[0];
    if (first === undefined) throw new Error("expected publication path");
    const slot = safeArtifactPublicationSlot("support-export", first);
    expect(() =>
      publishSafeArtifactFileSet(
        [
          {
            path: first,
            contents: byteCountFixture(MAX_SAFE_ARTIFACT_RECOVERY_ENTRY_BYTES + 1),
            artifactClass: "support-report",
          },
        ],
        { commitPath: first, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "invalid-publication" }));
    expect(() =>
      publishSafeArtifactFileSet(
        paths.map((path, index) => ({
          path,
          contents: byteCountFixture(MAX_SAFE_ARTIFACT_RECOVERY_PUBLICATION_BYTES / 2),
          artifactClass:
            index === 0 ? ("support-report" as const) : ("integrity-artifact" as const),
        })),
        { commitPath: first, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "invalid-publication" }));
    expect(readdirSync(base)).toEqual([]);
  });

  it("recovers a fixed publication slot without rebuilding the original contents", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const integrity = join(base, "support.jsonl.sha256");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const entries = [
      { path: report, contents: "old-report", artifactClass: "support-report" as const },
      {
        path: integrity,
        contents: "old-digest\n",
        artifactClass: "integrity-artifact" as const,
      },
    ];
    let links = 0;
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        links += 1;
        if (links === 2) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");

    expect(() =>
      interrupted.publishSafeArtifactFileSet(entries, {
        commitPath: report,
        trustedRoot: base,
        publicationSlot: slot,
      }),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    vi.doUnmock("node:child_process");
    vi.resetModules();

    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual(
      expect.objectContaining({ status: "recovered", commitPath: report, artifactCount: 2 }),
    );
    expect(readFileSync(report, "utf8")).toBe("old-report");
    expect(readFileSync(integrity, "utf8")).toBe("old-digest\n");
    expect(publicationStages(base)).toEqual([`.keiko-publish-${slot}.complete`]);
  });

  it("rolls back partial pre-target stages from a fixed slot", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const integrity = join(base, "support.jsonl.sha256");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const entries = [
      { path: report, contents: "report", artifactClass: "support-report" as const },
      { path: integrity, contents: "digest", artifactClass: "integrity-artifact" as const },
    ];
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let writes = 0;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      writeSync: (...args: Parameters<typeof actual.writeSync>): number => {
        writes += 1;
        if (writes === 3) throw Object.assign(new Error("stage interrupted"), { code: "EIO" });
        return Reflect.apply(actual.writeSync, actual, args);
      },
    }));
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.publishSafeArtifactFileSet(entries, {
        commitPath: report,
        trustedRoot: base,
        publicationSlot: slot,
      }),
    ).toThrow(expect.objectContaining({ kind: "write-failed" }));
    expect(existsSync(report)).toBe(false);
    expect(existsSync(integrity)).toBe(false);
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual({
      status: "rolled-back",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(readdirSync(base)).toEqual([`.keiko-publish-${slot}.consumed`]);
  });

  it("rejects a second publisher for an occupied fixed slot without creating another transaction", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const integrity = join(base, "support.jsonl.sha256");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const entries = [
      { path: report, contents: "old-report", artifactClass: "support-report" as const },
      { path: integrity, contents: "old-digest", artifactClass: "integrity-artifact" as const },
    ];
    let links = 0;
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        links += 1;
        if (links === 2) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.publishSafeArtifactFileSet(entries, {
        commitPath: report,
        trustedRoot: base,
        publicationSlot: slot,
      }),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    vi.doUnmock("node:child_process");
    vi.resetModules();
    const before = readdirSync(base).sort();

    expect(() =>
      publishSafeArtifactFileSet(
        [
          { path: report, contents: "new-report", artifactClass: "support-report" },
          { path: integrity, contents: "new-digest", artifactClass: "integrity-artifact" },
        ],
        { commitPath: report, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "recovery-conflict" }));
    expect(readdirSync(base).sort()).toEqual(before);
    expect(readFileSync(integrity, "utf8")).toBe("old-digest");
  });

  it("prevents a real peer process from rolling back a live publisher slot", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const integrity = join(base, "support.jsonl.sha256");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const entries = [
      { path: report, contents: "old-report", artifactClass: "support-report" as const },
      { path: integrity, contents: "old-digest", artifactClass: "integrity-artifact" as const },
    ];
    const peerScript = `
      import { recoverSafeArtifactFileSet } from "@oscharko-dev/keiko-security/fs-hardening";
      const mode = process.env.KEIKO_TEST_PUBLICATION_MODE;
      try {
        const result = recoverSafeArtifactFileSet({
          publicationSlot: process.env.KEIKO_TEST_PUBLICATION_SLOT,
          trustedRoot: process.env.KEIKO_TEST_PUBLICATION_ROOT,
        });
        process.exit(mode === "released" && result.status === "recovered" ? 0 : 2);
      } catch (error) {
        process.exit(mode === "active" && error?.kind === "recovery-conflict" ? 0 : 3);
      }
    `;
    const runPeer = (mode: "active" | "released"): void => {
      execFileSync(process.execPath, ["--input-type=module", "--eval", peerScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KEIKO_TEST_PUBLICATION_MODE: mode,
          KEIKO_TEST_PUBLICATION_ROOT: base,
          KEIKO_TEST_PUBLICATION_SLOT: slot,
        },
      });
    };
    let links = 0;
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        links += 1;
        if (links === 1) runPeer("active");
        if (links === 2) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.publishSafeArtifactFileSet(entries, {
        commitPath: report,
        trustedRoot: base,
        publicationSlot: slot,
      }),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    vi.doUnmock("node:child_process");
    vi.resetModules();
    expect(() => {
      runPeer("released");
    }).not.toThrow();
    expect(readFileSync(integrity, "utf8")).toBe("old-digest");
    expect(readFileSync(report, "utf8")).toBe("old-report");
    expect(publicationStages(base)).toEqual([`.keiko-publish-${slot}.complete`]);
  });

  it("never takes over an expired owner lease while the recorded PID remains live", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const integrity = join(base, "support.jsonl.sha256");
    const slot = safeArtifactPublicationSlot("support-export", report);
    let links = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        links += 1;
        if (links === 2) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".owner")) {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.publishSafeArtifactFileSet(
        [
          { path: report, contents: "report", artifactClass: "support-report" },
          { path: integrity, contents: "digest", artifactClass: "integrity-artifact" },
        ],
        { commitPath: report, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    vi.doUnmock("node:child_process");
    vi.resetModules();
    vi.useRealTimers();
    const before = readdirSync(base).sort();

    const peerScript = `
      import { recoverSafeArtifactFileSet } from "@oscharko-dev/keiko-security/fs-hardening";
      try {
        recoverSafeArtifactFileSet({
          publicationSlot: process.env.KEIKO_TEST_PUBLICATION_SLOT,
          trustedRoot: process.env.KEIKO_TEST_PUBLICATION_ROOT,
        });
        process.exit(2);
      } catch (error) {
        process.exit(error?.kind === "publish-unsupported" ? 0 : 3);
      }
    `;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "--eval", peerScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KEIKO_TEST_PUBLICATION_ROOT: base,
          KEIKO_TEST_PUBLICATION_SLOT: slot,
        },
      }),
    ).not.toThrow();
    expect(readdirSync(base).sort()).toEqual(before);
    expect(existsSync(report)).toBe(false);
    expect(readFileSync(integrity, "utf8")).toBe("digest");
  });

  it("preserves a primary durability failure when owner cleanup also fails", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let stageDescriptor: number | undefined;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        const descriptor = Reflect.apply(actual.openSync, actual, args);
        if (String(args[0]).endsWith(".stage")) stageDescriptor = descriptor;
        return descriptor;
      },
      fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
        if (args[0] === stageDescriptor) {
          throw Object.assign(new Error("stage durability failed"), { code: "EIO" });
        }
        Reflect.apply(actual.fsyncSync, actual, args);
      },
    }));
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".owner")) {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path: report, contents: "report", artifactClass: "support-report" }],
        { commitPath: report, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "durability-failed" }));
    expect(readdirSync(base)).toContain(`.keiko-publish-${slot}.owner`);
  });

  it("keeps one bounded recovery locator when hard-link publication is unsupported", async () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path: report, contents: "report", artifactClass: "support-report" }],
        { commitPath: report, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(readdirSync(base)).toEqual([`.keiko-publish-${slot}.active`]);
  });

  it("refuses hostile fixed-slot intent markers without changing their victim", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const marker = join(base, `.keiko-publish-${slot}.active`);
    const victim = join(base, "victim");
    writeFileSync(victim, "operator-owned", { mode: 0o640 });
    chmodSync(victim, 0o640);

    for (const kind of ["symlink", "hard-link", "fifo"] as const) {
      if (kind === "symlink") symlinkSync(victim, marker);
      else if (kind === "hard-link") linkSync(victim, marker);
      else execFileSync("mkfifo", [marker]);
      expect(() =>
        recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base }),
      ).toThrow(expect.objectContaining({ kind: "unsafe-target" }));
      expect(readFileSync(victim, "utf8")).toBe("operator-owned");
      expect(statSync(victim).mode & 0o777).toBe(0o640);
      rmSync(marker);
    }
  });

  it("keeps the consumed locator when acknowledgement directory fsync fails", async (ctx) => {
    // Windows has no directory descriptor to fsync, so this injected failure cannot occur there.
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    expect(
      publishSafeArtifactFileSet(
        [{ path: report, contents: "report", artifactClass: "support-report" }],
        { commitPath: report, trustedRoot: base, publicationSlot: slot },
      ),
    ).toEqual(expect.objectContaining({ status: "published" }));
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let intentUnlinked = false;
    let failed = false;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
        if (intentUnlinked && !failed) {
          failed = true;
          throw Object.assign(new Error("post-unlink directory fsync failed"), { code: "EIO" });
        }
        Reflect.apply(actual.fsyncSync, actual, args);
      },
    }));
    await mockDirectoryMutation((invocation, perform) => {
      perform();
      if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".complete")) {
        intentUnlinked = true;
      }
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.acknowledgeSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base }),
    ).toThrow(expect.objectContaining({ kind: "durability-failed" }));
    expect(readFileSync(report, "utf8")).toBe("report");
    expect(statSync(report).nlink).toBe(1);
    expect(publicationStages(base)).toHaveLength(1);
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(acknowledgeSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toBe(
      "verified",
    );
    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual({
      status: "none",
    });
    expect(readdirSync(base).sort()).toEqual([`.keiko-publish-${slot}.consumed`, "support.jsonl"]);
  });

  it("keeps a bounded receipt while acknowledged runs publish fresh snapshots", () => {
    const base = freshDir();
    const slot = safeArtifactPublicationSlot("support-export", base);
    const first = join(base, "first.jsonl");
    const second = join(base, "second.jsonl");

    expect(
      publishSafeArtifactFileSet(
        [{ path: first, contents: "first", artifactClass: "support-report" }],
        { commitPath: first, trustedRoot: base, publicationSlot: slot },
      ),
    ).toEqual(expect.objectContaining({ status: "published" }));
    acknowledgeSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base });
    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual({
      status: "none",
    });

    expect(
      publishSafeArtifactFileSet(
        [{ path: second, contents: "second", artifactClass: "support-report" }],
        { commitPath: second, trustedRoot: base, publicationSlot: slot },
      ),
    ).toEqual(expect.objectContaining({ status: "published" }));
    acknowledgeSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base });

    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(publicationStages(base)).toHaveLength(1);
  });

  it("recovers the exact unacknowledged snapshot before allowing a fresh one", () => {
    const base = freshDir();
    const slot = safeArtifactPublicationSlot("support-export", base);
    const report = join(base, "interrupted.jsonl");
    publishSafeArtifactFileSet(
      [{ path: report, contents: "before-crash", artifactClass: "support-report" }],
      { commitPath: report, trustedRoot: base, publicationSlot: slot },
    );

    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual(
      expect.objectContaining({
        status: "recovered",
        commitPath: report,
        commitSha256: createHash("sha256").update("before-crash").digest("hex"),
      }),
    );
    acknowledgeSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base });
    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual({
      status: "none",
    });
    expect(readFileSync(report, "utf8")).toBe("before-crash");
    expect(publicationStages(base)).toHaveLength(1);
  });

  it("rejects a hostile triple receipt state without mutating names, bytes, or modes", () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    publishSafeArtifactFileSet(
      [{ path: report, contents: "report", artifactClass: "support-report" }],
      { commitPath: report, trustedRoot: base, publicationSlot: slot },
    );
    const complete = join(base, `.keiko-publish-${slot}.complete`);
    const consumed = join(base, `.keiko-publish-${slot}.consumed`);
    const active = join(base, `.keiko-publish-${slot}.active`);
    const owner = join(base, `.keiko-publish-${slot}.owner`);
    linkSync(complete, consumed);
    writeFileSync(active, readFileSync(complete), { mode: FILE_MODE });
    writeFileSync(owner, readFileSync(active), { mode: FILE_MODE });
    const before = artifactDirectorySnapshot(base);

    expect(() => recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toThrow(
      expect.objectContaining({ kind: "recovery-conflict" }),
    );
    expect(artifactDirectorySnapshot(base)).toEqual(before);
  });

  it.each([
    ["active", "complete"],
    ["complete", "consumed"],
  ] as const)(
    "rejects unrelated %s + %s receipt inodes without mutation",
    (extraState, retainedState) => {
      const base = freshDir();
      const report = join(base, "support.jsonl");
      const slot = safeArtifactPublicationSlot("support-export", report);
      publishSafeArtifactFileSet(
        [{ path: report, contents: "report", artifactClass: "support-report" }],
        { commitPath: report, trustedRoot: base, publicationSlot: slot },
      );
      const complete = join(base, `.keiko-publish-${slot}.complete`);
      const extra = join(base, `.keiko-publish-${slot}.${extraState}`);
      const retained = join(base, `.keiko-publish-${slot}.${retainedState}`);
      const owner = join(base, `.keiko-publish-${slot}.owner`);
      if (retained !== complete) renameSync(complete, retained);
      writeFileSync(extra, readFileSync(retained), { mode: FILE_MODE });
      writeFileSync(owner, readFileSync(retained), { mode: FILE_MODE });
      const before = artifactDirectorySnapshot(base);

      expect(() =>
        recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base }),
      ).toThrow(expect.objectContaining({ kind: "recovery-conflict" }));
      expect(artifactDirectorySnapshot(base)).toEqual(before);
    },
  );

  it("preserves linked receipt state when a valid owner token does not match", () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    publishSafeArtifactFileSet(
      [{ path: report, contents: "report", artifactClass: "support-report" }],
      { commitPath: report, trustedRoot: base, publicationSlot: slot },
    );
    const complete = join(base, `.keiko-publish-${slot}.complete`);
    const active = join(base, `.keiko-publish-${slot}.active`);
    const owner = join(base, `.keiko-publish-${slot}.owner`);
    linkSync(complete, active);
    const mismatchedOwner = JSON.parse(readFileSync(complete, "utf8")) as Record<string, unknown>;
    const firstDifferentToken = "a".repeat(24);
    mismatchedOwner.ownerToken =
      mismatchedOwner.ownerToken === firstDifferentToken ? "b".repeat(24) : firstDifferentToken;
    writeFileSync(owner, `${JSON.stringify(mismatchedOwner)}\n`, { mode: FILE_MODE });
    const before = artifactDirectorySnapshot(base);

    expect(() => recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toThrow(
      expect.objectContaining({ kind: "recovery-conflict" }),
    );
    expect(artifactDirectorySnapshot(base)).toEqual(before);
  });

  it("recovers linked receipt state when the valid owner matches", () => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    publishSafeArtifactFileSet(
      [{ path: report, contents: "report", artifactClass: "support-report" }],
      { commitPath: report, trustedRoot: base, publicationSlot: slot },
    );
    const complete = join(base, `.keiko-publish-${slot}.complete`);
    const active = join(base, `.keiko-publish-${slot}.active`);
    const owner = join(base, `.keiko-publish-${slot}.owner`);
    linkSync(complete, active);
    writeFileSync(owner, readFileSync(complete), { mode: FILE_MODE });

    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual(
      expect.objectContaining({ status: "recovered", commitPath: report }),
    );
    expect(readFileSync(report, "utf8")).toBe("report");
    expect(publicationStages(base)).toEqual([`.keiko-publish-${slot}.complete`]);
  });

  it("cleans a new owner created before active while retaining an old consumed receipt", async () => {
    const base = freshDir();
    const first = join(base, "first.jsonl");
    const second = join(base, "second.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", base);
    publishSafeArtifactFileSet(
      [{ path: first, contents: "first", artifactClass: "support-report" }],
      { commitPath: first, trustedRoot: base, publicationSlot: slot },
    );
    acknowledgeSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        if (String(args[0]).endsWith(".active")) {
          throw Object.assign(new Error("active creation interrupted"), { code: "EIO" });
        }
        return Reflect.apply(actual.openSync, actual, args);
      },
    }));
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".owner")) {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.publishSafeArtifactFileSet(
        [{ path: second, contents: "second", artifactClass: "support-report" }],
        { commitPath: second, trustedRoot: base, publicationSlot: slot },
      ),
    ).toThrow(expect.objectContaining({ kind: "open-failed" }));
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toEqual({
      status: "none",
    });
    const peerScript = `
      import {
        acknowledgeSafeArtifactFileSet,
        publishSafeArtifactFileSet,
      } from "@oscharko-dev/keiko-security/fs-hardening";
      const result = publishSafeArtifactFileSet(
        [{
          path: process.env.KEIKO_TEST_REPORT,
          contents: "second",
          artifactClass: "support-report",
        }],
        {
          commitPath: process.env.KEIKO_TEST_REPORT,
          trustedRoot: process.env.KEIKO_TEST_PUBLICATION_ROOT,
          publicationSlot: process.env.KEIKO_TEST_PUBLICATION_SLOT,
        },
      );
      acknowledgeSafeArtifactFileSet({
        publicationSlot: process.env.KEIKO_TEST_PUBLICATION_SLOT,
        trustedRoot: process.env.KEIKO_TEST_PUBLICATION_ROOT,
      });
      process.exit(result.status === "published" ? 0 : 2);
    `;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "--eval", peerScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KEIKO_TEST_PUBLICATION_ROOT: base,
          KEIKO_TEST_PUBLICATION_SLOT: slot,
          KEIKO_TEST_REPORT: second,
        },
      }),
    ).not.toThrow();
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(publicationStages(base)).toEqual([`.keiko-publish-${slot}.consumed`]);
  });

  it.each([
    ["malformed", "not-json\n"],
    ["oversized", "x".repeat(64 * 1024 + 1)],
  ])("keeps a %s fixed-slot intent fail-closed and bounded", (_kind, contents) => {
    const base = freshDir();
    const report = join(base, "support.jsonl");
    const slot = safeArtifactPublicationSlot("support-export", report);
    const marker = join(base, `.keiko-publish-${slot}.active`);
    writeFileSync(marker, contents, { mode: FILE_MODE });

    expect(() => recoverSafeArtifactFileSet({ publicationSlot: slot, trustedRoot: base })).toThrow(
      expect.objectContaining({ kind: "recovery-conflict" }),
    );
    expect(readFileSync(marker, "utf8")).toBe(contents);
    expect(existsSync(report)).toBe(false);
    expect(readdirSync(base)).toEqual([`.keiko-publish-${slot}.active`]);
  });

  it.each(["darwin", "win32"] as const)(
    "rejects case-folded duplicate destinations on %s before writing",
    (platform) => {
      const base = freshDir();
      const upper = join(base, "Report.json");
      const lower = join(base, "report.json");
      setPlatform(platform);
      expect(() =>
        publishSafeArtifactFileSet(
          [
            { path: upper, contents: "one", artifactClass: "manifest" },
            { path: lower, contents: "two", artifactClass: "integrity-artifact" },
          ],
          { commitPath: upper, trustedRoot: base },
        ),
      ).toThrow(expect.objectContaining({ kind: "invalid-publication" }));
      expect(existsSync(upper)).toBe(false);
      expect(existsSync(lower)).toBe(false);
    },
  );

  it.each(["darwin", "win32"] as const)(
    "rejects a case-folded reserved publication basename on %s",
    (platform) => {
      const base = freshDir();
      const report = join(base, ".KEIKO-PUBLISH-customer.jsonl");
      const slot = safeArtifactPublicationSlot("support-export", report);
      setPlatform(platform);

      expect(() =>
        publishSafeArtifactFileSet(
          [{ path: report, contents: "report", artifactClass: "support-report" }],
          { commitPath: report, trustedRoot: base, publicationSlot: slot },
        ),
      ).toThrow(expect.objectContaining({ kind: "invalid-publication" }));
      expect(readdirSync(base)).toEqual([]);
    },
  );

  it("reports the reviewed Windows ACL residual as platform-inherited", () => {
    const base = realpathSync(freshDir());
    const path = join(base, "report.json");
    setPlatform("win32");
    expect(safeArtifactPermissionAssurance()).toBe("platform-inherited");
    expect(safeArtifactContainmentAssurance()).toBe("platform-inherited");
    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({
      status: "published",
      permissionAssurance: "platform-inherited",
      durabilityAssurance: "directory-sync-unavailable",
    });
  });

  it("uses a locale-independent publication order", () => {
    const base = freshDir();
    const first = join(base, "z-report.json");
    const second = join(base, "ä-report.json");
    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation((): never => {
        throw new Error("process locale must not determine publication identity");
      });

    expect(
      publishSafeArtifactFileSet(
        [
          { path: second, contents: "second", artifactClass: "integrity-artifact" },
          { path: first, contents: "first", artifactClass: "manifest" },
        ],
        { commitPath: first, trustedRoot: base },
      ),
    ).toEqual(expect.objectContaining({ status: "published" }));
    expect(localeCompare).not.toHaveBeenCalled();
  });

  it("uses a writable recovery-stage handle while exposing unavailable directory sync", async () => {
    const base = realpathSync(freshDir());
    const path = join(base, "report.json");
    await leaveLinkedPublication(base, path);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const writableDescriptors = new Set<number>();
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        const descriptor = Reflect.apply(actual.openSync, actual, args);
        const flags = args[1];
        if (
          typeof flags === "number" &&
          (flags & (actual.constants.O_WRONLY | actual.constants.O_RDWR)) !== 0
        ) {
          writableDescriptors.add(descriptor);
        }
        return descriptor;
      },
      fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
        expect(writableDescriptors.has(args[0])).toBe(true);
        Reflect.apply(actual.fsyncSync, actual, args);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    setPlatform("win32");

    // This mock pins the reviewed Node contract. Native Windows ACL/reparse and directory-flush
    // proof remains platform-owned and is deliberately reported as inherited/unavailable.
    expect(
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toEqual({
      status: "recovered",
      permissionAssurance: "platform-inherited",
      durabilityAssurance: "directory-sync-unavailable",
    });
  });

  it("publishes the commit artifact last and recovers an interrupted publication", async () => {
    const base = freshDir();
    const manifest = join(base, "manifest.json");
    const integrity = join(base, "integrity.json");
    const entries = [
      { path: manifest, contents: "manifest\n", artifactClass: "manifest" as const },
      { path: integrity, contents: "digest\n", artifactClass: "integrity-artifact" as const },
    ];
    let links = 0;
    const destinations: string[] = [];
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        links += 1;
        if (invocation.targetPath !== undefined) destinations.push(invocation.targetPath);
        if (links === 2) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(entries, { commitPath: manifest, trustedRoot: base }),
    ).toThrow(
      expect.objectContaining<Partial<InstanceType<typeof SafeArtifactFileError>>>({
        kind: "publish-failed",
      }),
    );
    expect(destinations).toEqual([integrity, manifest]);
    expect(existsSync(manifest)).toBe(false);
    expect(readFileSync(integrity, "utf8")).toBe("digest\n");
    vi.doUnmock("node:child_process");
    vi.resetModules();

    expect(
      publishSafeArtifactFileSet(entries, { commitPath: manifest, trustedRoot: base }),
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(readFileSync(manifest, "utf8")).toBe("manifest\n");
    expect(readFileSync(integrity, "utf8")).toBe("digest\n");
    expect(statSync(manifest).nlink).toBe(1);
    expect(statSync(integrity).nlink).toBe(1);
  });

  it("publishes a clean multi-artifact set with the commit artifact last", async () => {
    const base = freshDir();
    const manifest = join(base, "manifest.json");
    const integrity = join(base, "integrity.json");
    const entries = [
      { path: manifest, contents: "manifest\n", artifactClass: "manifest" as const },
      { path: integrity, contents: "digest\n", artifactClass: "integrity-artifact" as const },
    ];
    const destinations: string[] = [];
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link" && invocation.targetPath !== undefined) {
        destinations.push(invocation.targetPath);
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(
      isolated.publishSafeArtifactFileSet(entries, { commitPath: manifest, trustedRoot: base }),
    ).toEqual({
      status: "published",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(destinations).toEqual([integrity, manifest]);
    expect(readFileSync(manifest, "utf8")).toBe("manifest\n");
    expect(readFileSync(integrity, "utf8")).toBe("digest\n");
    expect(statSync(manifest).nlink).toBe(1);
    expect(statSync(integrity).nlink).toBe(1);
    expect(readdirSync(base).sort()).toEqual(["integrity.json", "manifest.json"]);
  });

  it("publishes a single support report with explicit permission assurance", () => {
    const base = freshDir();
    const path = join(base, "support.jsonl");
    expect(
      publishSafeArtifactFileSet(
        [{ path, contents: "report\n", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toEqual({
      status: "published",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(readFileSync(path, "utf8")).toBe("report\n");
  });

  it("refuses an exact pre-existing target without writing", async () => {
    const base = freshDir();
    const path = join(base, "support.jsonl");
    writeFileSync(path, "report\n", { mode: FILE_MODE });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const write = vi.fn(actual.writeSync);
    vi.resetModules();
    vi.doMock("node:fs", () => ({ ...actual, writeSync: write }));
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report\n", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-exists" }));
    expect(write).not.toHaveBeenCalled();
    expect(readdirSync(base)).toEqual(["support.jsonl"]);
  });

  it("keeps a complete target-only crash state but fails closed without its marker", async () => {
    const base = freshDir();
    const path = join(base, "support.jsonl");
    await leaveLinkedPublication(base, path);
    const [stage] = publicationStages(base);
    expect(stage).toBeDefined();
    unlinkSync(join(base, stage ?? "missing"));
    expect(statSync(path).nlink).toBe(1);

    expect(() =>
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "target-exists" }));
    expect(readFileSync(path, "utf8")).toBe("report");
    expect(readdirSync(base)).toEqual(["support.jsonl"]);
  });

  it("rejects a partial multi-file target-only state without creating missing artifacts", () => {
    const base = freshDir();
    const manifest = join(base, "manifest.json");
    const integrity = join(base, "integrity.json");
    writeFileSync(manifest, "manifest", { mode: FILE_MODE });

    expect(() =>
      publishSafeArtifactFileSet(
        [
          { path: manifest, contents: "manifest", artifactClass: "manifest" },
          { path: integrity, contents: "digest", artifactClass: "integrity-artifact" },
        ],
        { commitPath: manifest, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-exists" }));
    expect(readFileSync(manifest, "utf8")).toBe("manifest");
    expect(existsSync(integrity)).toBe(false);
    expect(publicationStages(base)).toHaveLength(0);
  });

  it("refuses a complete multi-file target set when no recovery marker remains", () => {
    const base = freshDir();
    const manifest = join(base, "manifest.json");
    const integrity = join(base, "integrity.json");
    writeFileSync(manifest, "manifest", { mode: FILE_MODE });
    writeFileSync(integrity, "digest", { mode: FILE_MODE });

    expect(() =>
      publishSafeArtifactFileSet(
        [
          { path: manifest, contents: "manifest", artifactClass: "manifest" },
          { path: integrity, contents: "digest", artifactClass: "integrity-artifact" },
        ],
        { commitPath: manifest, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-exists" }));
    expect(readdirSync(base).sort()).toEqual(["integrity.json", "manifest.json"]);
  });

  it("refuses target-only replay when an unexpected transaction stage remains", async () => {
    const base = freshDir();
    const path = join(base, "support.jsonl");
    await leaveLinkedPublication(base, path);
    const [stage] = publicationStages(base);
    expect(stage).toBeDefined();
    const stageName = stage ?? "missing";
    unlinkSync(join(base, stageName));
    writeFileSync(join(base, stageName.replace(/-0\.stage$/, "-99.stage")), "peer", {
      mode: FILE_MODE,
    });

    expect(() =>
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "target-exists" }));
    expect(readFileSync(path, "utf8")).toBe("report");
  });

  it("rejects exact bytes through hard-link and symlink targets", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const victim = join(base, "victim");
    writeFileSync(victim, "report", { mode: FILE_MODE });

    for (const kind of ["hard-link", "symlink"] as const) {
      const path = join(base, `${kind}.json`);
      if (kind === "hard-link") linkSync(victim, path);
      else symlinkSync(victim, path);
      expect(() =>
        publishSafeArtifactFileSet(
          [{ path, contents: "report", artifactClass: "support-report" }],
          { commitPath: path, trustedRoot: base },
        ),
      ).toThrow(expect.objectContaining({ kind: "target-exists" }));
    }
    expect(readFileSync(victim, "utf8")).toBe("report");
  });

  it("revalidates target identity after reading exact recovery bytes", async () => {
    const base = freshDir();
    const path = join(base, "support.jsonl");
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const interrupted = await import("./fs-hardening.js");
    expect(() =>
      interrupted.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    vi.doUnmock("node:child_process");
    vi.resetModules();
    const [stageName] = publicationStages(base);
    expect(stageName).toBeDefined();
    const stage = join(base, stageName ?? "missing");
    const displaced = join(base, "stage-displaced");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    vi.doMock("node:fs", () => ({
      ...actual,
      readSync: (...args: Parameters<typeof actual.readSync>): number => {
        const read = Reflect.apply(actual.readSync, actual, args);
        if (!swapped) {
          swapped = true;
          renameSync(stage, displaced);
          writeFileSync(stage, "report", { mode: FILE_MODE });
        }
        return read;
      },
    }));
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
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
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link" && invocation.targetPath !== undefined) {
        writeFileSync(invocation.targetPath, "attacker", { mode: FILE_MODE });
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.targetExists;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
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

  it("rejects a stage inode replaced immediately after the atomic link", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      perform();
      if (invocation.operation === "link") {
        unlinkSync(invocation.sourcePath);
        writeFileSync(invocation.sourcePath, "replacement", { mode: FILE_MODE });
      }
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    expect(readFileSync(path, "utf8")).toBe("report");
    expect(statSync(path).nlink).toBe(1);
  });

  it("rejects parent replacement across the atomic publication link", async () => {
    const base = freshDir();
    const parent = join(base, "reports");
    const displaced = join(base, "displaced-reports");
    const path = join(parent, "report.json");
    mkdirSync(parent);
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      perform();
      if (invocation.operation === "link") {
        renameSync(parent, displaced);
        mkdirSync(parent);
      }
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    expect(existsSync(path)).toBe(false);
  });

  it("keeps atomic publication links inside the pinned parent", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const container = freshDir();
    const parent = join(container, "artifacts");
    const displaced = join(container, "displaced");
    const outside = join(container, "outside");
    const path = join(parent, "report.json");
    mkdirSync(parent);
    mkdirSync(outside);
    let outsideStage: string | undefined;
    vi.resetModules();
    await swapBeforeDirectoryMutation(
      (invocation) => invocation.operation === "link" && invocation.targetPath === path,
      (invocation) => {
        outsideStage = join(outside, basename(invocation.sourcePath));
        writeFileSync(outsideStage, "outside-stage", { mode: FILE_MODE });
        replaceParentWithOutsideLink(parent, displaced, outside);
      },
    );
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: container },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    expect(outsideStage).toBeDefined();
    expect(statSync(outsideStage ?? "missing").nlink).toBe(1);
    expect(existsSync(join(outside, "report.json"))).toBe(false);
  });

  it("keeps stage cleanup unlink inside the pinned parent", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const container = freshDir();
    const parent = join(container, "artifacts");
    const displaced = join(container, "displaced");
    const outside = join(container, "outside");
    const path = join(parent, "report.json");
    mkdirSync(parent);
    mkdirSync(outside);
    let outsideStage: string | undefined;
    vi.resetModules();
    await swapBeforeDirectoryMutation(
      (invocation) => invocation.operation === "unlink" && invocation.sourcePath.endsWith(".stage"),
      (invocation) => {
        outsideStage = join(outside, basename(invocation.sourcePath));
        writeFileSync(outsideStage, "outside-stage", { mode: FILE_MODE });
        replaceParentWithOutsideLink(parent, displaced, outside);
      },
    );
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: container },
      ),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    expect(outsideStage).toBeDefined();
    expect(readFileSync(outsideStage ?? "missing", "utf8")).toBe("outside-stage");
  });

  it("keeps fixed-slot receipt cleanup inside the pinned parent", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const container = freshDir();
    const root = join(container, "artifacts");
    const displaced = join(container, "displaced");
    const outside = join(container, "outside");
    const path = join(root, "report.json");
    const slot = safeArtifactPublicationSlot("support-export", path);
    mkdirSync(root);
    mkdirSync(outside);
    const outsideOwner = join(outside, `.keiko-publish-${slot}.owner`);
    vi.resetModules();
    await swapBeforeDirectoryMutation(
      (invocation) => invocation.operation === "unlink" && invocation.sourcePath.endsWith(".owner"),
      () => {
        writeFileSync(outsideOwner, "outside-owner", { mode: FILE_MODE });
        replaceParentWithOutsideLink(root, displaced, outside);
      },
    );
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, publicationSlot: slot, trustedRoot: root },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    expect(readFileSync(outsideOwner, "utf8")).toBe("outside-owner");
  });

  it("keeps recovery-marker restoration inside the pinned parent", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const container = freshDir();
    const parent = join(container, "artifacts");
    const displaced = join(container, "displaced");
    const outside = join(container, "outside");
    const path = join(parent, "report.json");
    mkdirSync(parent);
    mkdirSync(outside);
    await leaveLinkedPublication(parent, path);
    const stageName = publicationStages(parent)[0];
    if (stageName === undefined) throw new Error("expected recovery marker");
    const outsideReport = join(outside, "report.json");
    const outsideStage = join(outside, stageName);
    let stageRemoved = false;
    let syncFailed = false;
    vi.resetModules();
    await swapBeforeDirectoryMutation(
      (invocation) =>
        invocation.operation === "link" &&
        invocation.sourcePath === path &&
        invocation.targetPath?.endsWith(".stage") === true,
      () => {
        writeFileSync(outsideReport, "outside-report", { mode: FILE_MODE });
        replaceParentWithOutsideLink(parent, displaced, outside);
      },
      (invocation) => {
        if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".stage")) {
          stageRemoved = true;
        }
      },
      () => {
        if (!stageRemoved || syncFailed) return false;
        syncFailed = true;
        return true;
      },
    );
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: parent },
      ),
    ).toThrow(expect.objectContaining({ kind: "target-mutated" }));
    expect(statSync(outsideReport).nlink).toBe(1);
    expect(existsSync(outsideStage)).toBe(false);
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
          const typed = args as unknown as [number, Uint8Array, number, number, number | null];
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
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
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
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
  });

  it("retries after the post-link directory fsync fails with markers intact", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    await failPublicationFsyncAt(base, path, 4);
    expect(publicationStages(base)).toHaveLength(1);
    expect(statSync(path).nlink).toBe(2);
    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(publicationStages(base)).toHaveLength(0);
  });

  it("restores a marker when unlink succeeds but reports failure", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    let failed = false;
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      perform();
      if (invocation.operation === "unlink" && !failed) {
        failed = true;
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      }
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    vi.doUnmock("node:fs");
    vi.resetModules();
    expect(publicationStages(base)).toHaveLength(1);
    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
  });

  it("retries after final cleanup fsync by durably restoring the commit marker", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    await failPublicationFsyncAt(base, path, 7);
    expect(publicationStages(base)).toHaveLength(1);
    expect(statSync(path).nlink).toBe(2);
    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(publicationStages(base)).toHaveLength(0);
  });

  it("recovers a file set after a non-commit stage was removed", async () => {
    const base = freshDir();
    const manifest = join(base, "manifest.json");
    const integrity = join(base, "integrity.json");
    const entries = [
      { path: manifest, contents: "manifest", artifactClass: "manifest" as const },
      { path: integrity, contents: "integrity", artifactClass: "integrity-artifact" as const },
    ];
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let removedStage = false;
    let failed = false;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
        if (removedStage && !failed) {
          failed = true;
          throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
        }
        Reflect.apply(actual.fsyncSync, actual, args);
      },
    }));
    await mockDirectoryMutation((invocation, perform) => {
      perform();
      if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".stage")) {
        removedStage = true;
      }
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(entries, { commitPath: manifest, trustedRoot: base }),
    ).toThrow(expect.objectContaining({ kind: "durability-failed" }));
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(publicationStages(base)).toHaveLength(1);
    expect(
      publishSafeArtifactFileSet(entries, { commitPath: manifest, trustedRoot: base }),
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(publicationStages(base)).toHaveLength(0);
    expect(readFileSync(manifest, "utf8")).toBe("manifest");
    expect(readFileSync(integrity, "utf8")).toBe("integrity");
    expect(statSync(manifest).nlink).toBe(1);
    expect(statSync(integrity).nlink).toBe(1);
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
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(readFileSync(path, "utf8")).toBe("report");
    expect(statSync(path).nlink).toBe(1);
  });

  it("restores the recovery marker when target revalidation fails after unlink", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    await leaveLinkedPublication(base, path);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let stageRemoved = false;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      readSync: (...args: Parameters<typeof actual.readSync>): number => {
        if (stageRemoved) {
          stageRemoved = false;
          throw Object.assign(new Error("target revalidation failed"), { code: "EIO" });
        }
        return Reflect.apply(actual.readSync, actual, args);
      },
    }));
    await mockDirectoryMutation((invocation, perform) => {
      perform();
      if (invocation.operation === "unlink" && invocation.sourcePath.endsWith(".stage")) {
        stageRemoved = true;
      }
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "read-failed" }));
    expect(publicationStages(base)).toHaveLength(1);
    expect(statSync(path).nlink).toBe(2);
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual(expect.objectContaining({ status: "recovered" }));
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
        const typed = args as unknown as [number, Uint8Array, number, number, number | null];
        return actual.readSync(typed[0], typed[1], typed[2], Math.min(2, typed[3]), typed[4]);
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toEqual({
      status: "recovered",
      permissionAssurance: safeArtifactPermissionAssurance(),
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(readFileSync(path, "utf8")).toBe("report");
  });

  it("closes linked-recovery descriptors after a read failure and retries", async () => {
    const base = freshDir();
    const path = join(base, "report.json");
    await leaveLinkedPublication(base, path);
    const stage = publicationStages(base)[0];
    if (stage === undefined) throw new Error("expected a recovery stage");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const opened = new Set<number>();
    const closed = new Set<number>();
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>): number => {
        const descriptor = Reflect.apply(actual.openSync, actual, args);
        opened.add(descriptor);
        return descriptor;
      },
      closeSync: (...args: Parameters<typeof actual.closeSync>): void => {
        closed.add(args[0]);
        Reflect.apply(actual.closeSync, actual, args);
      },
      readSync: (): never => {
        throw Object.assign(new Error("read failed"), { code: "EIO" });
      },
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() =>
      isolated.publishSafeArtifactFileSet(
        [{ path, contents: "report", artifactClass: "support-report" }],
        { commitPath: path, trustedRoot: base },
      ),
    ).toThrow(expect.objectContaining({ kind: "read-failed" }));
    expect(opened.size).toBeGreaterThan(0);
    expect([...opened].every((descriptor) => closed.has(descriptor))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("report");
    expect(statSync(path).nlink).toBe(2);
    expect(statSync(join(base, stage)).nlink).toBe(2);
    vi.doUnmock("node:fs");
    vi.resetModules();

    expect(
      publishSafeArtifactFileSet([{ path, contents: "report", artifactClass: "support-report" }], {
        commitPath: path,
        trustedRoot: base,
      }),
    ).toEqual(expect.objectContaining({ status: "recovered" }));
    expect(publicationStages(base)).toHaveLength(0);
    expect(statSync(path).nlink).toBe(1);
  });

  it.each(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"])(
    "classifies unsupported hard-link code %s without path disclosure",
    async (_code) => {
      const base = freshDir();
      const path = join(base, "report.json");
      vi.resetModules();
      await mockDirectoryMutation((invocation, perform) => {
        if (invocation.operation === "link") {
          return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported;
        }
        perform();
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
      });
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
    },
  );

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

describe("bounded Activity Log mutations", () => {
  it("publishes one hard-link archive and leaves it as a private single-link file", () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "finished-day\n", { mode: FILE_MODE });

    expect(
      archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toBe("hard-link-winner");
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(archive, "utf8")).toBe("finished-day\n");
    expect(statSync(archive).nlink).toBe(1);
    expect(statSync(archive).mode & 0o777).toBe(FILE_MODE);
  });

  it("never replaces an archive that already won the closed destination name", () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "current-day\n", { mode: FILE_MODE });
    writeFileSync(archive, "winning-day\n", { mode: FILE_MODE });

    expect(
      archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toBe("archive-exists");
    expect(readFileSync(source, "utf8")).toBe("current-day\n");
    expect(readFileSync(archive, "utf8")).toBe("winning-day\n");
  });

  it("finalizes the genuine EEXIST winner link without replacing its archive", () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "finished-day\n", { mode: FILE_MODE });
    linkSync(source, archive);

    expect(
      archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toBe("archive-exists");
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(archive, "utf8")).toBe("finished-day\n");
    expect(statSync(archive).nlink).toBe(1);
  });

  it("never deletes a log that a concurrent rotation recreated under the archived name", async () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "yesterday\n", { mode: FILE_MODE });
    // A concurrent process already won the hard link and has not yet removed server.log.
    linkSync(source, archive);
    vi.resetModules();
    await swapBeforeDirectoryMutation(
      (invocation) => invocation.operation === "unlink",
      () => {
        // The winner completes first, and a writer immediately recreates today's server.log.
        unlinkSync(source);
        writeFileSync(source, "today\n", { mode: FILE_MODE });
      },
    );
    const isolated = await import("./fs-hardening.js");

    expect(
      isolated.archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toBe("archive-exists");
    expect(readFileSync(source, "utf8")).toBe("today\n");
    expect(readFileSync(archive, "utf8")).toBe("yesterday\n");
    expect(statSync(archive).nlink).toBe(1);
  });

  it("rejects an unrelated hard-link surprise without creating an archive target", () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const unrelated = join(base, "unrelated.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "finished-day\n", { mode: FILE_MODE });
    linkSync(source, unrelated);

    expect(() =>
      archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-target" }));
    expect(existsSync(archive)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("finished-day\n");
    expect(readFileSync(unrelated, "utf8")).toBe("finished-day\n");
  });

  it("uses rename only after the hard-link helper reports unsupported", async () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "finished-day\n", { mode: FILE_MODE });
    const operations: SafeArtifactDirectoryMutationOperation[] = [];
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      operations.push(invocation.operation);
      if (invocation.operation === "link") {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported;
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(
      isolated.archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toBe("rename-fallback");
    expect(operations).toStrictEqual(["link", "rename"]);
    expect(readFileSync(archive, "utf8")).toBe("finished-day\n");
  });

  it("never replaces a concurrent rotation's archive when rename is the only primitive", async () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    const options = { artifactClass: "activity-log", trustedRoot: base } as const;
    writeFileSync(source, "yesterday\n", { mode: FILE_MODE });
    const loaded: { module?: typeof import("./fs-hardening.js") } = {};
    const racing: { started: boolean; result: string | undefined } = {
      started: false,
      result: undefined,
    };
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported;
      }
      if (invocation.operation === "rename" && !racing.started) {
        racing.started = true;
        // A second process completes its whole rotation, then a writer appends today's line.
        racing.result = loaded.module?.archiveSafeArtifactFile(source, archive, options);
        appendFileSync(source, "today\n", { mode: FILE_MODE });
      }
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    loaded.module = await import("./fs-hardening.js");

    expect(loaded.module.archiveSafeArtifactFile(source, archive, options)).toBe("rename-fallback");
    expect(racing.result).toBe("archive-exists");
    expect(readFileSync(archive, "utf8")).toBe("yesterday\ntoday\n");
    expect(existsSync(source)).toBe(false);
  });

  it("releases its own archive claim when the fallback rename fails", async () => {
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "finished-day\n", { mode: FILE_MODE });
    vi.resetModules();
    await mockDirectoryMutation((invocation, perform) => {
      if (invocation.operation === "link") {
        return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported;
      }
      if (invocation.operation === "rename") return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
      perform();
      return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success;
    });
    const isolated = await import("./fs-hardening.js");

    expect(() =>
      isolated.archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "publish-failed" }));
    expect(existsSync(archive)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("finished-day\n");
  });

  it("unlinks only an opened owner-private single-link regular file", () => {
    const base = freshDir();
    const target = join(base, "server-2026-09-16.log");
    const peer = join(base, "peer.log");
    writeFileSync(target, "archive\n", { mode: FILE_MODE });
    linkSync(target, peer);

    expect(() => {
      removeSafeArtifactFile(target, {
        artifactClass: "activity-log",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "unsafe-target" }));
    expect(readFileSync(target, "utf8")).toBe("archive\n");
    expect(readFileSync(peer, "utf8")).toBe("archive\n");

    unlinkSync(peer);
    removeSafeArtifactFile(target, {
      artifactClass: "activity-log",
      trustedRoot: base,
    });
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a group-readable trusted artifact directory before archive or removal", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const base = freshDir();
    const source = join(base, "server.log");
    const archive = join(base, "server-2026-09-17.log");
    writeFileSync(source, "finished-day\n", { mode: FILE_MODE });
    chmodSync(base, 0o750);

    expect(() =>
      archiveSafeArtifactFile(source, archive, {
        artifactClass: "activity-log",
        trustedRoot: base,
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-ancestor" }));
    expect(readFileSync(source, "utf8")).toBe("finished-day\n");
    expect(existsSync(archive)).toBe(false);
    expect(() => {
      removeSafeArtifactFile(source, {
        artifactClass: "activity-log",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "unsafe-ancestor" }));
    expect(readFileSync(source, "utf8")).toBe("finished-day\n");
  });
});

describe("replaceSafeArtifactFile", () => {
  it("fails closed before touching an existing target on every platform", () => {
    const base = freshDir();
    const path = join(base, "manifest.json");
    writeFileSync(path, "old", { mode: FILE_MODE });

    expect(() => {
      replaceSafeArtifactFile(path, "new", {
        artifactClass: "manifest",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(statSync(path).mode & 0o777).toBe(FILE_MODE);
    expect(readdirSync(base)).toEqual(["manifest.json"]);
  });

  it("creates no partial stage when the replacement target is absent", () => {
    const base = freshDir();
    const path = join(base, "manifest.json");

    expect(() => {
      replaceSafeArtifactFile(path, "new", {
        artifactClass: "manifest",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(readdirSync(base)).toEqual([]);
  });

  it("never reaches write or rename even when those operations would fail transiently", async () => {
    const base = freshDir();
    const path = join(base, "manifest.json");
    writeFileSync(path, "old", { mode: FILE_MODE });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const write = vi.fn(actual.writeSync);
    const rename = vi.fn(actual.renameSync);
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actual,
      writeSync: write,
      renameSync: rename,
    }));
    const isolated = await import("./fs-hardening.js");
    expect(() => {
      isolated.replaceSafeArtifactFile(path, "new", {
        artifactClass: "manifest",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  it("cannot redirect an unsupported replacement into an external victim", () => {
    const base = freshDir();
    const parent = join(base, "artifacts");
    const outside = freshDir();
    const path = join(parent, "manifest.json");
    mkdirSync(parent);
    writeFileSync(path, "old", { mode: FILE_MODE });
    const outsideVictim = join(outside, "manifest.json");
    const outsideStage = join(outside, ".keiko-replace-attacker.stage");
    writeFileSync(outsideVictim, "outside", { mode: FILE_MODE });
    writeFileSync(outsideStage, "attacker", { mode: FILE_MODE });

    expect(() => {
      replaceSafeArtifactFile(path, "new", {
        artifactClass: "manifest",
        trustedRoot: base,
      });
    }).toThrow(expect.objectContaining({ kind: "publish-unsupported" }));
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readFileSync(outsideVictim, "utf8")).toBe("outside");
    expect(readFileSync(outsideStage, "utf8")).toBe("attacker");
  });
});
