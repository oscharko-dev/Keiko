import { describe, expect, expectTypeOf, it } from "vitest";
import {
  GIT_EDITOR_BLAME_MAX_BYTES,
  GIT_EDITOR_BLAME_MAX_LINES,
  GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS,
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_DIFF_MAX_HEADER_CHARS,
  GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE,
  GIT_EDITOR_DIFF_MAX_LINE_CHARS,
  GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK,
  GIT_EDITOR_SCHEMA_VERSION,
  isGitEditorBlameLine,
  isGitEditorDiffFile,
  isGitEditorDiffFileStatus,
  isGitEditorDiffHunk,
  isGitEditorDiffLayer,
  isGitEditorDiffLine,
  isGitEditorDiffLineKind,
  isGitEditorDiffScope,
  parseGitEditorBlameRequest,
  parseGitEditorBlameResponse,
  parseGitEditorDiffRequest,
  parseGitEditorDiffResponse,
  type GitEditorDiffFile,
  type GitEditorDiffHunk,
  type GitEditorDiffLine,
} from "./git-editor.js";

function diffLine(overrides: Partial<GitEditorDiffLine> = {}): GitEditorDiffLine {
  return { kind: "ctx", oldLine: 1, newLine: 1, text: "const value = 1;", ...overrides };
}

function diffHunk(overrides: Partial<GitEditorDiffHunk> = {}): GitEditorDiffHunk {
  return {
    header: "@@ -1 +1 @@",
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    lines: [diffLine()],
    truncated: false,
    ...overrides,
  };
}

function diffFile(overrides: Partial<GitEditorDiffFile> = {}): GitEditorDiffFile {
  return {
    path: "src/app.ts",
    layer: "staged",
    status: "modified",
    binary: false,
    hunks: [diffHunk()],
    addedLines: 0,
    removedLines: 0,
    truncated: false,
    ...overrides,
  };
}

function diffResponse(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    scope: "staged",
    files: [diffFile()],
    truncated: false,
    totalFiles: 1,
    totalBytes: 128,
    maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
    maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
    ...overrides,
  };
}

function blameLine(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    line: 1,
    commitHash: "a".repeat(40),
    author: "Ada Lovelace",
    authorTime: "2026-07-10T18:00:00Z",
    summary: "Add the editor contract",
    ...overrides,
  };
}

function blameResponse(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    path: "src/app.ts",
    startLine: 1,
    lines: [blameLine()],
    truncated: false,
    totalLines: 1,
    totalBytes: 128,
    maxBytes: GIT_EDITOR_BLAME_MAX_BYTES,
    maxLines: GIT_EDITOR_BLAME_MAX_LINES,
    ...overrides,
  };
}

// Mirrors the current client declarations in diffParser.ts. The contracts leaf cannot import UI;
// child issue 6 replaces these mirrors with the real shared types during renderer consolidation.
interface ClientDiffLine {
  readonly kind: "ctx" | "add" | "del" | "meta";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

interface ClientDiffHunk {
  readonly header: string;
  readonly lines: readonly ClientDiffLine[];
}

interface ClientDiffFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly hunks: readonly ClientDiffHunk[];
  readonly addedLines: number;
  readonly removedLines: number;
}

describe("git editor diff compatibility", () => {
  it("is assignable to the current client DiffLine/DiffHunk/DiffFile family", () => {
    expectTypeOf<GitEditorDiffLine>().toExtend<ClientDiffLine>();
    expectTypeOf<GitEditorDiffHunk>().toExtend<ClientDiffHunk>();
    expectTypeOf<GitEditorDiffFile>().toExtend<ClientDiffFile>();
  });
});

describe("git editor diff guards", () => {
  it("validates every runtime enum witness", () => {
    expect(isGitEditorDiffScope("staged")).toBe(true);
    expect(isGitEditorDiffScope("all")).toBe(false);
    expect(isGitEditorDiffLayer("worktree")).toBe(true);
    expect(isGitEditorDiffLayer("unstaged")).toBe(false);
    expect(isGitEditorDiffLineKind("meta")).toBe(true);
    expect(isGitEditorDiffLineKind("change")).toBe(false);
    expect(isGitEditorDiffFileStatus("renamed")).toBe(true);
    expect(isGitEditorDiffFileStatus("binary")).toBe(false);
  });

  it("enforces exact coordinates for each line kind", () => {
    expect(isGitEditorDiffLine(diffLine())).toBe(true);
    expect(isGitEditorDiffLine(diffLine({ kind: "add", oldLine: null, newLine: 2 }))).toBe(true);
    expect(isGitEditorDiffLine(diffLine({ kind: "del", oldLine: 2, newLine: null }))).toBe(true);
    expect(isGitEditorDiffLine(diffLine({ kind: "meta", oldLine: null, newLine: null }))).toBe(
      true,
    );
    expect(isGitEditorDiffLine(diffLine({ kind: "add", oldLine: 1, newLine: 2 }))).toBe(false);
    expect(isGitEditorDiffLine(diffLine({ kind: "ctx", oldLine: null }))).toBe(false);
  });

  it("accepts line, hunk, and file cap edges and rejects one over each edge", () => {
    expect(
      isGitEditorDiffLine(diffLine({ text: "x".repeat(GIT_EDITOR_DIFF_MAX_LINE_CHARS) })),
    ).toBe(true);
    expect(
      isGitEditorDiffLine(diffLine({ text: "x".repeat(GIT_EDITOR_DIFF_MAX_LINE_CHARS + 1) })),
    ).toBe(false);
    const edgeHunk = diffHunk({
      header: "@".repeat(GIT_EDITOR_DIFF_MAX_HEADER_CHARS),
      lines: Array.from({ length: GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK }, () => diffLine()),
    });
    expect(isGitEditorDiffHunk(edgeHunk)).toBe(true);
    expect(isGitEditorDiffHunk({ ...edgeHunk, header: `${edgeHunk.header}@` })).toBe(false);
    expect(isGitEditorDiffHunk({ ...edgeHunk, lines: [...edgeHunk.lines, diffLine()] })).toBe(
      false,
    );
    const edgeFile = diffFile({
      hunks: Array.from({ length: GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE }, () => diffHunk()),
    });
    expect(isGitEditorDiffFile(edgeFile)).toBe(true);
    expect(isGitEditorDiffFile({ ...edgeFile, hunks: [...edgeFile.hunks, diffHunk()] })).toBe(
      false,
    );
  });

  it("supports rename and binary metadata while rejecting contradictory shapes", () => {
    expect(isGitEditorDiffFile(diffFile({ status: "renamed", oldPath: "src/old.ts" }))).toBe(true);
    expect(isGitEditorDiffFile(diffFile({ status: "renamed" }))).toBe(false);
    expect(
      isGitEditorDiffFile(diffFile({ binary: true, hunks: [], addedLines: 0, removedLines: 0 })),
    ).toBe(true);
    expect(isGitEditorDiffFile(diffFile({ binary: true }))).toBe(false);
  });
});

describe("parseGitEditorDiffRequest", () => {
  it("accepts valid staged and unstaged requests", () => {
    expect(
      parseGitEditorDiffRequest({ schemaVersion: GIT_EDITOR_SCHEMA_VERSION, scope: "staged" }),
    ).toMatchObject({ ok: true });
    expect(
      parseGitEditorDiffRequest({
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        scope: "unstaged",
        path: "src/app.ts",
      }),
    ).toMatchObject({ ok: true });
  });

  it("collects invalid fields and rejects traversal-shaped hostile paths", () => {
    const invalid = parseGitEditorDiffRequest({ schemaVersion: "2", scope: "all", path: "" });
    expect(invalid).toMatchObject({ ok: false });
    if (!invalid.ok) expect(invalid.errors).toHaveLength(3);
    expect(
      parseGitEditorDiffRequest({
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        scope: "staged",
        path: "../secret.txt",
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts the path byte edge, rejects one over, and never throws on a hostile getter", () => {
    expect(
      parseGitEditorDiffRequest({
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        scope: "staged",
        path: "x".repeat(4_096),
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseGitEditorDiffRequest({
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        scope: "staged",
        path: "x".repeat(4_097),
      }),
    ).toMatchObject({ ok: false });
    const hostile = Object.defineProperty({}, "schemaVersion", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(() => parseGitEditorDiffRequest(hostile)).not.toThrow();
    expect(parseGitEditorDiffRequest(hostile)).toMatchObject({ ok: false });
  });
});

describe("parseGitEditorDiffResponse", () => {
  it("accepts a valid response and the file-count boundary", () => {
    expect(parseGitEditorDiffResponse(diffResponse())).toMatchObject({ ok: true });
    const files = Array.from({ length: GIT_EDITOR_DIFF_MAX_FILES }, (_unused, index) =>
      diffFile({ path: `src/file-${String(index)}.ts`, binary: true, hunks: [] }),
    );
    expect(
      parseGitEditorDiffResponse(diffResponse({ files, totalFiles: files.length })),
    ).toMatchObject({ ok: true });
  });

  it("rejects malformed responses, oversized file lists, and false truncation markers", () => {
    expect(parseGitEditorDiffResponse(diffResponse({ files: "invalid" }))).toMatchObject({
      ok: false,
    });
    const tooMany = Array.from({ length: GIT_EDITOR_DIFF_MAX_FILES + 1 }, () => diffFile());
    expect(parseGitEditorDiffResponse(diffResponse({ files: tooMany }))).toMatchObject({
      ok: false,
    });
    expect(
      parseGitEditorDiffResponse(
        diffResponse({ totalBytes: GIT_EDITOR_DIFF_MAX_BYTES + 1, truncated: false }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects scope/layer conflicts and hostile nested paths without throwing", () => {
    expect(
      parseGitEditorDiffResponse(
        diffResponse({ scope: "unstaged", files: [diffFile({ layer: "staged" })] }),
      ),
    ).toMatchObject({ ok: false });
    expect(() =>
      parseGitEditorDiffResponse(diffResponse({ files: [diffFile({ path: "../../secret" })] })),
    ).not.toThrow();
    expect(
      parseGitEditorDiffResponse(diffResponse({ files: [diffFile({ path: "../../secret" })] })),
    ).toMatchObject({ ok: false });
  });
});

describe("git editor blame validation", () => {
  it("accepts committed SHA-1/SHA-256 and all-zero uncommitted hashes", () => {
    expect(isGitEditorBlameLine(blameLine())).toBe(true);
    expect(isGitEditorBlameLine(blameLine({ commitHash: "b".repeat(64) }))).toBe(true);
    expect(isGitEditorBlameLine(blameLine({ commitHash: "0".repeat(40) }))).toBe(true);
    expect(isGitEditorBlameLine(blameLine({ commitHash: "A".repeat(40) }))).toBe(false);
  });

  it("rejects email/source content fields and enforces the summary edge", () => {
    expect(
      isGitEditorBlameLine(blameLine({ summary: "x".repeat(GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS) })),
    ).toBe(true);
    expect(
      isGitEditorBlameLine(
        blameLine({ summary: "x".repeat(GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS + 1) }),
      ),
    ).toBe(false);
    expect(isGitEditorBlameLine(blameLine({ authorEmail: "ada@example.test" }))).toBe(false);
    expect(isGitEditorBlameLine(blameLine({ sourceLine: "const secret = true;" }))).toBe(false);
  });
});

describe("parseGitEditorBlameRequest", () => {
  it("accepts the line cap and rejects malformed or traversal-shaped requests", () => {
    expect(
      parseGitEditorBlameRequest({
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        path: "src/app.ts",
        startLine: 1,
        maxLines: GIT_EDITOR_BLAME_MAX_LINES,
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseGitEditorBlameRequest({
        schemaVersion: "2",
        path: "../app.ts",
        startLine: 0,
        maxLines: GIT_EDITOR_BLAME_MAX_LINES + 1,
      }),
    ).toMatchObject({ ok: false });
  });

  it("is throw-free for hostile objects", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "path", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(() => parseGitEditorBlameRequest(hostile)).not.toThrow();
    expect(parseGitEditorBlameRequest(hostile)).toMatchObject({ ok: false });
  });
});

describe("parseGitEditorBlameResponse", () => {
  it("accepts valid and line-count boundary responses", () => {
    expect(parseGitEditorBlameResponse(blameResponse())).toMatchObject({ ok: true });
    const lines = Array.from({ length: GIT_EDITOR_BLAME_MAX_LINES }, (_unused, index) =>
      blameLine({ line: index + 1 }),
    );
    expect(
      parseGitEditorBlameResponse(blameResponse({ lines, totalLines: lines.length })),
    ).toMatchObject({ ok: true });
  });

  it("rejects malformed, oversized, and inconsistent responses", () => {
    expect(
      parseGitEditorBlameResponse(blameResponse({ lines: [blameLine({ line: 0 })] })),
    ).toMatchObject({ ok: false });
    const tooMany = Array.from({ length: GIT_EDITOR_BLAME_MAX_LINES + 1 }, () => blameLine());
    expect(parseGitEditorBlameResponse(blameResponse({ lines: tooMany }))).toMatchObject({
      ok: false,
    });
    expect(
      parseGitEditorBlameResponse(
        blameResponse({ totalBytes: GIT_EDITOR_BLAME_MAX_BYTES + 1, truncated: false }),
      ),
    ).toMatchObject({ ok: false });
    expect(parseGitEditorBlameResponse(blameResponse({ totalLines: 0 }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects hostile paths and stays throw-free for cyclic input", () => {
    expect(
      parseGitEditorBlameResponse(blameResponse({ path: "/outside/repository.ts" })),
    ).toMatchObject({ ok: false });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseGitEditorBlameResponse(cyclic)).not.toThrow();
    expect(parseGitEditorBlameResponse(cyclic)).toMatchObject({ ok: false });
  });
});
