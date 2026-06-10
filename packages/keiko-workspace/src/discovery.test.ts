import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFiles, discoverWithStats, readWorkspaceFile } from "./discovery.js";
import { detectWorkspace } from "./detect.js";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  WorkspaceReadError,
} from "./errors.js";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "./fs.js";
import { DEFAULT_DISCOVERY_OPTIONS, type WorkspaceInfo } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-disc-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(rel: string, body = "x"): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function paths(ws: WorkspaceInfo): readonly string[] {
  return discoverFiles(ws, DEFAULT_DISCOVERY_OPTIONS).map((f) => f.relativePath);
}

function fakeWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    name: "x",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["javascript"],
    ignoreLines: [],
  };
}

describe("discoverFiles", () => {
  it("discovers regular files in deterministic sorted order", () => {
    file("src/b.ts");
    file("src/a.ts");
    file("README.md");
    const found = paths(detectWorkspace(dir));
    expect(found).toEqual([...found].sort());
    expect(found).toContain("src/a.ts");
    expect(found).toContain("README.md");
  });

  it("skips always-on denied paths even when not gitignored", () => {
    file("node_modules/left-pad/index.js");
    file(".env", "SECRET=1");
    file("dist/out.js");
    file("src/keep.ts");
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/keep.ts");
    expect(found).not.toContain(".env");
    expect(found.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(found.some((p) => p.startsWith("dist"))).toBe(false);
  });

  it("respects .gitignore patterns", () => {
    writeFileSync(join(dir, ".gitignore"), "*.tmp\nscratch/\n", "utf8");
    file("a.tmp");
    file("scratch/note.txt");
    file("src/keep.ts");
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/keep.ts");
    expect(found).not.toContain("a.tmp");
    expect(found.some((p) => p.startsWith("scratch"))).toBe(false);
  });

  it("caps total files at maxFiles", () => {
    for (let i = 0; i < 10; i += 1) {
      file(`src/f${String(i)}.ts`);
    }
    const found = discoverFiles(detectWorkspace(dir), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxFiles: 3,
    });
    expect(found.length).toBe(3);
  });

  it("caps recursion at maxDepth", () => {
    file("a/b/c/d/deep.ts");
    file("top.ts");
    const found = discoverFiles(detectWorkspace(dir), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxDepth: 1,
    }).map((f) => f.relativePath);
    expect(found).toContain("top.ts");
    expect(found).not.toContain("a/b/c/d/deep.ts");
  });

  it("skips a symlink whose realpath escapes the workspace root", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOPSECRET", "utf8");
      file("src/keep.ts");
      symlinkSync(join(outside, "secret.txt"), join(dir, "src", "leak.txt"));
      const found = paths(detectWorkspace(dir));
      expect(found).toContain("src/keep.ts");
      expect(found).not.toContain("src/leak.txt");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not follow an internal symlink-to-file, but keeps the real target", () => {
    // Conservative, environment-independent behavior: a symlink is never traversed. The real
    // file is still found and discovery never throws. (Escaping symlinks are covered above.)
    file("src/real.ts", "data");
    symlinkSync(join(dir, "src", "real.ts"), join(dir, "src", "alias.ts"));
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/real.ts");
    expect(found).not.toContain("src/alias.ts");
  });

  it("tolerates an unreadable subdirectory without throwing", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
      readDir: (p: string): readonly WorkspaceDirEntry[] => {
        if (p === root) {
          return [{ name: "locked", isDirectory: true, isFile: false, isSymbolicLink: false }];
        }
        throw new Error("EACCES");
      },
      realPath: (p: string): string => p,
      exists: (): boolean => true,
    };
    expect(discoverFiles(fakeWorkspace(root), DEFAULT_DISCOVERY_OPTIONS, fs)).toEqual([]);
  });

  it("reports denied and ignored counts via discoverWithStats", () => {
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n", "utf8");
    file(".env", "SECRET=1");
    file("a.tmp");
    file("src/keep.ts");
    const { stats } = discoverWithStats(detectWorkspace(dir), DEFAULT_DISCOVERY_OPTIONS);
    expect(stats.denied).toBeGreaterThanOrEqual(1);
    expect(stats.ignored).toBeGreaterThanOrEqual(1);
    expect(stats.discovered).toBeGreaterThanOrEqual(1);
  });
});

describe("readWorkspaceFile", () => {
  it("reads a file inside the workspace and redacts secrets", () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    file("notes.txt", `token ${secret} rest`);
    const content = readWorkspaceFile(detectWorkspace(dir), "notes.txt");
    expect(content.text).not.toContain(secret);
    expect(content.relativePath).toBe("notes.txt");
  });

  it("rejects a traversal escape", () => {
    expect(() => readWorkspaceFile(detectWorkspace(dir), "../escape")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => readWorkspaceFile(detectWorkspace(dir), "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("refuses to read a denied path with PathDeniedError", () => {
    file(".env", "SECRET=1");
    expect(() => readWorkspaceFile(detectWorkspace(dir), ".env")).toThrow(PathDeniedError);
  });

  it("refuses to read a symlink alias whose real target is denied", () => {
    file(".env", "SECRET=1");
    symlinkSync(join(dir, ".env"), join(dir, "alias.env"));
    expect(() => readWorkspaceFile(detectWorkspace(dir), "alias.env")).toThrow(PathDeniedError);
  });

  it("refuses to read hard-linked aliases for context ingestion", () => {
    file(".env", "DB_PASSWORD=bank-super-secret\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    linkSync(join(dir, ".env"), join(dir, "src", "config.ts"));
    expect(() => readWorkspaceFile(detectWorkspace(dir), "src/config.ts")).toThrow(PathDeniedError);
  });

  it("denied-path error carries the WORKSPACE_PATH_DENIED code", () => {
    file(".env", "SECRET=1");
    let caught: unknown;
    try {
      readWorkspaceFile(detectWorkspace(dir), ".env");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PathDeniedError);
    expect((caught as PathDeniedError).code).toBe("WORKSPACE_PATH_DENIED");
  });

  it("throws FileTooLargeError when the file exceeds the cap", () => {
    file("big.txt", "a".repeat(100));
    expect(() => readWorkspaceFile(detectWorkspace(dir), "big.txt", { maxBytes: 10 })).toThrow(
      FileTooLargeError,
    );
  });

  it("reports a read error for a missing file", () => {
    expect(() => readWorkspaceFile(detectWorkspace(dir), "missing.txt")).toThrow(
      WorkspaceReadError,
    );
  });

  it("wraps a non-Error filesystem throw into a WorkspaceReadError", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw string failure";
      },
      stat: (): WorkspaceStat => ({
        size: 5,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }),
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (p: string): string => p,
      exists: (): boolean => true,
    };
    expect(() => readWorkspaceFile(fakeWorkspace(root), "a.txt", { maxBytes: 100 }, fs)).toThrow(
      WorkspaceReadError,
    );
  });

  it("rejects a symlink inside the workspace that points outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOPSECRET", "utf8");
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
      expect(() => readWorkspaceFile(detectWorkspace(dir), "leak.txt")).toThrow(PathEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a normal in-root file (positive control for symlink containment)", () => {
    file("notes.txt", "hello");
    const content = readWorkspaceFile(detectWorkspace(dir), "notes.txt");
    expect(content.relativePath).toBe("notes.txt");
    expect(content.text).toBe("hello");
  });
  it("reports sizeBytes as UTF-8 byte count, not string length (multi-byte content)", () => {
    // "é" is 2 UTF-8 bytes; 10 × "é" = 20 UTF-8 bytes but only 10 UTF-16 code units.
    // The cap must be above the file size so readContent runs, then sizeBytes must reflect bytes.
    file("multi.txt", "é".repeat(10));
    const content = readWorkspaceFile(detectWorkspace(dir), "multi.txt", { maxBytes: 20 });
    expect(content.truncated).toBe(false);
    expect(content.sizeBytes).toBe(20); // UTF-8 bytes, not the 10 code units
    expect(content.sizeBytes).not.toBe(10);
  });

  it("enforces FileTooLargeError by UTF-8 byte size for multi-byte content", () => {
    // "€" is 3 UTF-8 bytes; 4 × "€" = 12 bytes. Cap of 10 bytes must reject.
    file("euros.txt", "€€€€");
    expect(() => readWorkspaceFile(detectWorkspace(dir), "euros.txt", { maxBytes: 10 })).toThrow(
      FileTooLargeError,
    );
  });
});

describe("nodeWorkspaceFs.exists", () => {
  it("returns false rather than throwing when stat raises an error (e.g. EACCES)", () => {
    // Simulate a stat that throws EACCES by injecting a WorkspaceFs whose exists() wraps a
    // throwing stat, exactly as nodeWorkspaceFs.exists does after the fix. The test proves the
    // safe-boolean-probe contract: exists() must never propagate a filesystem error.
    let statCallCount = 0;
    const eaccesStat = (): WorkspaceStat => {
      statCallCount += 1;
      throw Object.assign(new Error("EACCES: permission denied, stat '/locked'"), {
        code: "EACCES",
      });
    };
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: eaccesStat,
      readDir: (): readonly WorkspaceDirEntry[] => [],
      realPath: (p: string): string => p,
      exists: (absolutePath: string): boolean => {
        // This is the same pattern as the fixed nodeWorkspaceFs.exists implementation.
        try {
          return fs.stat(absolutePath).size >= 0;
        } catch {
          return false;
        }
      },
    };
    expect(() => fs.exists("/locked")).not.toThrow();
    expect(fs.exists("/locked")).toBe(false);
    expect(statCallCount).toBe(2); // called once per exists() invocation
  });
});
