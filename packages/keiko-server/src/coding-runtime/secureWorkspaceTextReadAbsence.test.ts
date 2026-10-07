import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  proveWorkspacePathAbsent,
  type WorkspacePathLstat,
  type WorkspacePathStat,
} from "./secureWorkspaceTextReadAbsence.js";

type Entry =
  | { readonly kind: "directory"; readonly dev?: bigint }
  | { readonly kind: "file" }
  | { readonly kind: "link" }
  | { readonly kind: "fails"; readonly error: Error };

const ROOT = join(sep, "workspace");
const ROOT_DEVICE = 7n;

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: scripted`), { code });
}

function stat(directory: boolean, dev: bigint): WorkspacePathStat {
  return { dev, isDirectory: (): boolean => directory };
}

/** A scripted filesystem: an absent key is ENOENT, and every probe is recorded in order. */
function scripted(entries: Readonly<Record<string, Entry>>): {
  readonly lstat: WorkspacePathLstat;
  readonly probes: string[];
} {
  const probes: string[] = [];
  const lstat: WorkspacePathLstat = (path) => {
    probes.push(path);
    const entry = entries[path];
    if (entry === undefined) return Promise.reject(errno("ENOENT"));
    if (entry.kind === "fails") return Promise.reject(entry.error);
    // An lstat of a link reports the link itself, which is not a directory.
    const directory = entry.kind === "directory";
    return Promise.resolve(stat(directory, directory ? (entry.dev ?? ROOT_DEVICE) : ROOT_DEVICE));
  };
  return { lstat, probes };
}

const at = (...parts: string[]): string => join(ROOT, ...parts);

describe("proveWorkspacePathAbsent (scripted filesystem)", () => {
  const REAL_ROOT: Record<string, Entry> = { [ROOT]: { kind: "directory" } };

  it.each([
    ["a file at the root", "new.ts", {}, [ROOT, at("new.ts")]],
    [
      "a file in an existing directory",
      "src/new.ts",
      { [at("src")]: { kind: "directory" } },
      [ROOT, at("src"), at("src", "new.ts")],
    ],
    [
      "a file below a missing directory: nothing beneath it is probed",
      "a/b/c/new.ts",
      { [at("a")]: { kind: "directory" } },
      [ROOT, at("a"), at("a", "b")],
    ],
  ] as const)("proves %s absent", async (_label, relativePath, below, expectedProbes) => {
    const { lstat, probes } = scripted({ ...REAL_ROOT, ...below });

    await expect(proveWorkspacePathAbsent({ root: ROOT, relativePath, lstat })).resolves.toBe(
      "absent",
    );
    expect(probes).toEqual(expectedProbes);
  });

  it.each([
    ["a file that exists", "src/present.ts", { [at("src", "present.ts")]: { kind: "file" } }],
    ["a directory at the final component", "src", {}],
    [
      "a link at the final component",
      "src/alias.ts",
      { [at("src", "alias.ts")]: { kind: "link" } },
    ],
  ] as const)("leaves %s undecided", async (_label, relativePath, extra) => {
    const { lstat } = scripted({ ...REAL_ROOT, [at("src")]: { kind: "directory" }, ...extra });

    await expect(proveWorkspacePathAbsent({ root: ROOT, relativePath, lstat })).resolves.toBe(
      "undecided",
    );
  });

  it("never looks past a link: a linked directory ends the walk", async () => {
    const { lstat, probes } = scripted({ ...REAL_ROOT, [at("link")]: { kind: "link" } });

    await expect(
      proveWorkspacePathAbsent({ root: ROOT, relativePath: "link/deeper/new.ts", lstat }),
    ).resolves.toBe("undecided");
    expect(probes).toEqual([ROOT, at("link")]);
  });

  it("never looks past a file used as a directory", async () => {
    const { lstat, probes } = scripted({ ...REAL_ROOT, [at("src")]: { kind: "file" } });

    await expect(
      proveWorkspacePathAbsent({ root: ROOT, relativePath: "src/new.ts", lstat }),
    ).resolves.toBe("undecided");
    expect(probes).toEqual([ROOT, at("src")]);
  });

  it("leaves a walk that crossed onto another device undecided, comparing devices exactly", async () => {
    // Two devices that differ only below double precision: a number comparison would equate them.
    const device = 2n ** 60n;
    const { lstat, probes } = scripted({
      [ROOT]: { kind: "directory", dev: device },
      [at("mount")]: { kind: "directory", dev: device + 1n },
    });

    await expect(
      proveWorkspacePathAbsent({ root: ROOT, relativePath: "mount/new.ts", lstat }),
    ).resolves.toBe("undecided");
    expect(probes).toEqual([ROOT, at("mount")]);
  });

  it.each([
    "EACCES",
    "EPERM",
    "ENOTDIR",
    "ELOOP",
    "ENAMETOOLONG",
    "EIO",
    "EBUSY",
    "EINVAL",
    "EMFILE",
  ])("leaves a probe that failed with %s undecided, at the final component", async (code) => {
    const { lstat } = scripted({
      ...REAL_ROOT,
      [at("src")]: { kind: "directory" },
      [at("src", "new.ts")]: { kind: "fails", error: errno(code) },
    });

    await expect(
      proveWorkspacePathAbsent({ root: ROOT, relativePath: "src/new.ts", lstat }),
    ).resolves.toBe("undecided");
  });

  it.each(["EACCES", "ENOTDIR", "EIO"])(
    "leaves a probe that failed with %s undecided, in the middle of the chain",
    async (code) => {
      const { lstat, probes } = scripted({
        ...REAL_ROOT,
        [at("src")]: { kind: "fails", error: errno(code) },
      });

      await expect(
        proveWorkspacePathAbsent({ root: ROOT, relativePath: "src/deeper/new.ts", lstat }),
      ).resolves.toBe("undecided");
      expect(probes).toEqual([ROOT, at("src")]);
    },
  );

  it.each([
    ["a string", "ENOENT"],
    ["undefined", undefined],
    ["null", null],
    ["an object without a code", { message: "gone" }],
    ["an object with another code", { code: "ENOENT_LIKE" }],
  ])("reads a rejection that is %s as undecided, never as absent", async (_label, rejection) => {
    // Deliberately not an Error: the probe port is a seam, and the walk must survive any reason.
    const { lstat } = scripted({
      ...REAL_ROOT,
      [at("new.ts")]: { kind: "fails", error: rejection as unknown as Error },
    });

    await expect(
      proveWorkspacePathAbsent({ root: ROOT, relativePath: "new.ts", lstat }),
    ).resolves.toBe("undecided");
  });

  it.each([
    ["missing", {}],
    ["a file", { [ROOT]: { kind: "file" } }],
    ["a link", { [ROOT]: { kind: "link" } }],
    ["unreadable", { [ROOT]: { kind: "fails", error: errno("EACCES") } }],
  ] as const)(
    "leaves a workspace root that is %s undecided, and probes nothing below it",
    async (_label, entries) => {
      const { lstat, probes } = scripted(entries);

      await expect(
        proveWorkspacePathAbsent({ root: ROOT, relativePath: "src/new.ts", lstat }),
      ).resolves.toBe("undecided");
      expect(probes).toEqual([ROOT]);
    },
  );

  it("proves nothing for a request that was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { lstat, probes } = scripted({ ...REAL_ROOT, [at("src")]: { kind: "directory" } });

    await expect(
      proveWorkspacePathAbsent({
        root: ROOT,
        relativePath: "src/deeper/new.ts",
        signal: controller.signal,
        lstat,
      }),
    ).resolves.toBe("undecided");
    // Only the root was probed: the first directory is never reached once the request is aborted.
    expect(probes).toEqual([ROOT]);
  });

  it("discards an absence concluded after the request was aborted", async () => {
    const controller = new AbortController();
    const probes: string[] = [];
    const lstat: WorkspacePathLstat = (path) => {
      probes.push(path);
      if (path === ROOT) return Promise.resolve(stat(true, ROOT_DEVICE));
      controller.abort();
      return Promise.reject(errno("ENOENT"));
    };

    await expect(
      proveWorkspacePathAbsent({
        root: ROOT,
        relativePath: "new.ts",
        signal: controller.signal,
        lstat,
      }),
    ).resolves.toBe("undecided");
    expect(probes).toEqual([ROOT, at("new.ts")]);
  });
});

describe("proveWorkspacePathAbsent (real filesystem)", () => {
  const bases: string[] = [];

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  function workspace(): { readonly root: string; readonly outside: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-absence-")));
    bases.push(base);
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "src", "present.ts"), "export {};\n");
    return { root, outside };
  }

  it("proves a missing file absent and a present one undecided", async () => {
    const { root } = workspace();

    await expect(proveWorkspacePathAbsent({ root, relativePath: "src/new.ts" })).resolves.toBe(
      "absent",
    );
    await expect(proveWorkspacePathAbsent({ root, relativePath: "no/such/new.ts" })).resolves.toBe(
      "absent",
    );
    await expect(proveWorkspacePathAbsent({ root, relativePath: "src/present.ts" })).resolves.toBe(
      "undecided",
    );
    await expect(proveWorkspacePathAbsent({ root, relativePath: "src" })).resolves.toBe(
      "undecided",
    );
  });

  it("does not look through a symlinked directory at what lies outside the root", async () => {
    const { root, outside } = workspace();
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");

    for (const relativePath of ["link", "link/absent.ts", "link/deeper/absent.ts"]) {
      await expect(proveWorkspacePathAbsent({ root, relativePath })).resolves.toBe("undecided");
    }
  });
});
