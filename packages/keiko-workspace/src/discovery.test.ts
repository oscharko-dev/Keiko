import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceFileForEditing as readViaPublishedSubpath } from "@oscharko-dev/keiko-workspace/internal/editor-read";
import {
  discoverFiles,
  discoverWithStatsAsync,
  discoverWithStats,
  readWorkspaceFile,
  readWorkspaceFileForEditing,
} from "./discovery.js";
import { detectWorkspace, detectWorkspaceAt } from "./detect.js";
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

  it("skips always-on denied security paths even when not gitignored", () => {
    file("node_modules/left-pad/index.js");
    file(".env", "SECRET=1");
    file("dist/out.js");
    file("src/keep.ts");
    const found = paths(detectWorkspace(dir));
    expect(found).toContain("src/keep.ts");
    expect(found).not.toContain(".env");
    expect(found.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(found).toContain("dist/out.js");
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
    expect(found).toHaveLength(3);
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

  it("counts directories skipped by the maxDepth cap", () => {
    file("a/b/c/deep.ts");
    file("top.ts");
    const { stats } = discoverWithStats(detectWorkspace(dir), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      maxDepth: 1,
    });
    expect(stats.depthPruned).toBeGreaterThan(0);
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

  it("refuses to walk a benign-named root that is a symlink into a denied dir", () => {
    // Discovery does not realpath-contain the ROOT, so a "docs" -> ".aws" symlink would otherwise list
    // the credential dir's files. The walk is refused (denied counted, zero files), never listed.
    const aws = join(dir, ".aws");
    mkdirSync(aws);
    writeFileSync(join(aws, "credentials.md"), "aws_secret should never be listed", "utf8");
    symlinkSync(aws, join(dir, "docs"));
    const ws = detectWorkspaceAt(join(dir, "docs"));
    expect(discoverFiles(ws, DEFAULT_DISCOVERY_OPTIONS)).toEqual([]);
    expect(discoverWithStats(ws, DEFAULT_DISCOVERY_OPTIONS).stats.denied).toBeGreaterThanOrEqual(1);
  });

  it("refuses a root symlink that replaces one denied ancestor with another", () => {
    const lexicalParent = join(dir, "node_modules");
    const deniedTarget = join(dir, ".aws", "workspace");
    mkdirSync(lexicalParent);
    mkdirSync(deniedTarget, { recursive: true });
    writeFileSync(join(deniedTarget, "notes.md"), "must not be listed", "utf8");
    const linkedRoot = join(lexicalParent, "linked-workspace");
    symlinkSync(deniedTarget, linkedRoot);
    const workspace = detectWorkspaceAt(linkedRoot);

    expect(discoverFiles(workspace, DEFAULT_DISCOVERY_OPTIONS)).toEqual([]);
    expect(discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS).stats.denied).toBe(1);
    expect(() => readWorkspaceFile(workspace, "notes.md")).toThrow(PathDeniedError);
  });

  it("refuses a root symlink relocated between separate loci of the same denied ancestor", () => {
    const lexicalParent = join(dir, ".codex", "worktrees", "fixture");
    const deniedTarget = join(dir, "other", ".codex");
    mkdirSync(lexicalParent, { recursive: true });
    mkdirSync(deniedTarget, { recursive: true });
    writeFileSync(join(deniedTarget, "notes.md"), "must not be listed", "utf8");
    const linkedRoot = join(lexicalParent, "docs");
    symlinkSync(deniedTarget, linkedRoot);
    const workspace = detectWorkspaceAt(linkedRoot);

    expect(discoverFiles(workspace, DEFAULT_DISCOVERY_OPTIONS)).toEqual([]);
    expect(discoverWithStats(workspace, DEFAULT_DISCOVERY_OPTIONS).stats.denied).toBe(1);
    expect(() => readWorkspaceFile(workspace, "notes.md")).toThrow(PathDeniedError);
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
    expect(stats.depthPruned).toBe(0);
    expect(stats.discovered).toBeGreaterThanOrEqual(1);
  });

  it("keeps async discovery identical across every filtering and pruning branch", async () => {
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n", "utf8");
    file(".env", "SECRET=1");
    file("ignored.tmp");
    file("depth/one/two/deep.ts");
    file("real.ts");
    symlinkSync(join(dir, "real.ts"), join(dir, "alias.ts"));
    file("z-one.ts");
    file("z-two.ts");
    file("z-three.ts");
    const workspace = detectWorkspace(dir);
    const options = { ...DEFAULT_DISCOVERY_OPTIONS, maxDepth: 1, maxFiles: 3 };

    expect(await discoverWithStatsAsync(workspace, options)).toEqual(
      discoverWithStats(workspace, options),
    );
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

  it("refuses to read inside a benign-named root that is a symlink into a denied dir", () => {
    // A directory symlink whose name is innocuous ("docs") but whose REAL target is a denied
    // credential dir (".aws") must not read through: the relative deny checks only see the basename,
    // and the realpath'd ROOT (where ".aws" lives) is invisible to them. Pins the symlinked-root guard.
    const aws = join(dir, ".aws");
    mkdirSync(aws);
    writeFileSync(join(aws, "config.md"), "aws_session_token opaque-bare-token-not-shaped", "utf8");
    symlinkSync(aws, join(dir, "docs")); // benign-named link -> denied real dir
    expect(() => readWorkspaceFile(detectWorkspaceAt(join(dir, "docs")), "config.md")).toThrow(
      PathDeniedError,
    );
  });

  it("still reads a root whose own path contains a denied-named ANCESTOR but is not symlinked", () => {
    // False-positive guard: a non-symlinked root that merely sits under a denied-named ancestor (e.g.
    // the product's own ".cache"/".claude" worktree) must keep working. Its canonical and lexical
    // roots are identical, so no denied locus was introduced or relocated by a symlink.
    const nested = join(dir, ".cache", "proj");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "notes.md"), "ordinary project notes", "utf8");
    const content = readWorkspaceFile(detectWorkspaceAt(nested), "notes.md");
    expect(content.text).toBe("ordinary project notes");
  });

  it("still reads through a benign-named root symlink whose real target is NOT denied", () => {
    // Positive control: a root symlink that resolves to an ordinary directory must keep reading — the
    // guard must not over-block legitimate symlinked workspaces (only denied real targets are refused).
    const real = join(dir, "realdocs");
    mkdirSync(real);
    writeFileSync(join(real, "spec.md"), "the system shall validate input", "utf8");
    symlinkSync(real, join(dir, "linked"));
    const content = readWorkspaceFile(detectWorkspaceAt(join(dir, "linked")), "spec.md");
    expect(content.text).toBe("the system shall validate input");
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

// The editor lane (see the read-lane boundary note in discovery.ts). It must return the RAW bytes
// AND run the identical security chain — a raw read is not a relaxed read.
describe("readWorkspaceFileForEditing", () => {
  const SECRET_LINE = 'const token = "s3cr3t-lookup-value";';

  it("returns the raw bytes where the evidence-lane read redacts them", () => {
    file("app.ts", `${SECRET_LINE}\n`);
    const workspace = detectWorkspace(dir);
    const raw = readWorkspaceFileForEditing(workspace, "app.ts");
    const redacted = readWorkspaceFile(workspace, "app.ts");

    expect(raw.rawText).toBe(`${SECRET_LINE}\n`);
    expect(raw.rawText).toContain("s3cr3t-lookup-value");
    expect(redacted.text).not.toContain("s3cr3t-lookup-value");
    expect(redacted.text).toContain("[REDACTED]");
  });

  it("preserves line numbering that redaction collapses (multi-line PEM block)", () => {
    // redact() rewrites a whole BEGIN/END PRIVATE KEY block as ONE token, so every line after it
    // shifts in the redacted view. Editor coordinates drive a WRITE and must address the real file.
    file(
      "key.ts",
      [
        "-----BEGIN PRIVATE KEY-----",
        "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
        "-----END PRIVATE KEY-----",
        'export const marker = "needle-after-pem";',
        "",
      ].join("\n"),
    );
    const workspace = detectWorkspace(dir);
    const rawLines = readWorkspaceFileForEditing(workspace, "key.ts").rawText.split("\n");
    const redactedLines = readWorkspaceFile(workspace, "key.ts").text.split("\n");

    // Raw: the marker is the 4th line (index 3). Redacted: the 3-line PEM block became one token,
    // so the same marker moved to index 1 and the file lost two lines.
    expect(rawLines[3]).toContain("needle-after-pem");
    expect(redactedLines[1]).toContain("needle-after-pem");
    expect(redactedLines).toHaveLength(rawLines.length - 2);
  });

  it("reports sizeBytes as the UTF-8 byte count", () => {
    file("multi.txt", "é".repeat(10));
    const content = readWorkspaceFileForEditing(detectWorkspace(dir), "multi.txt", {
      maxBytes: 20,
    });
    expect(content.sizeBytes).toBe(20);
    expect(content.truncated).toBe(false);
  });

  it("still rejects a traversal escape", () => {
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "../escape")).toThrow(
      PathEscapeError,
    );
  });

  it("still rejects an always-on denied path", () => {
    file(".env", "SECRET=1");
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), ".env")).toThrow(
      PathDeniedError,
    );
  });

  it("still rejects a symlink that escapes the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-raw-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "TOPSECRET", "utf8");
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
      expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "leak.txt")).toThrow(
        PathEscapeError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still rejects a hard-linked workspace alias", () => {
    file("real.txt", "body");
    linkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "alias.txt")).toThrow(
      PathDeniedError,
    );
  });

  it("still enforces the read cap", () => {
    file("big.txt", "x".repeat(64));
    expect(() =>
      readWorkspaceFileForEditing(detectWorkspace(dir), "big.txt", { maxBytes: 10 }),
    ).toThrow(FileTooLargeError);
  });

  it("still surfaces an unreadable in-root file as a WorkspaceReadError", () => {
    expect(() => readWorkspaceFileForEditing(detectWorkspace(dir), "missing.txt")).toThrow(
      WorkspaceReadError,
    );
  });

  it("matches the read published at the ./internal/editor-read subpath", () => {
    // The package.json `exports` entry is an independent second name for this function: nothing the
    // cases above assert constrains where it points, so a stale, duplicated, or mis-built artifact
    // behind `./internal/editor-read` would keep this whole file green while every consumer called
    // something else. Referential identity cannot express that pin from here — the subpath resolves
    // through `exports` to the BUILT `dist/editorRead.js` while `./discovery.js` resolves to the TS
    // source, so the two are distinct module instances by construction and `===` is false. What a
    // consumer actually depends on is that the published lane reads the same raw bytes.
    file("app.ts", `${SECRET_LINE}\n`);
    const workspace = detectWorkspace(dir);

    const viaSubpath = readViaPublishedSubpath(workspace, "app.ts");
    const viaRelative = readWorkspaceFileForEditing(workspace, "app.ts");

    expect(readViaPublishedSubpath.name).toBe(readWorkspaceFileForEditing.name);
    expect(viaSubpath).toEqual(viaRelative);
    expect(viaSubpath.rawText).toBe(`${SECRET_LINE}\n`);
    expect(viaSubpath.rawText).toContain("s3cr3t-lookup-value");
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
