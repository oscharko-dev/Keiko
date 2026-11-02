import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  LibraryParserTripleIdentityExpected,
  LibraryParserTripleIdentityFacts,
} from "./__tests__/support/library-parser-type-facts.js";
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
  GIT_EDITOR_PATH_MAX_BYTES,
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
  type GitEditorDiffRequest,
  type GitEditorDiffResponse,
  type GitEditorBlameRequest,
  type GitEditorBlameResponse,
  type GitEditorParseResult,
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

// Mirrors the GitEditorDiffLine/Hunk/File family that packages/keiko-ui's diffParser.ts already
// type-aliases directly (DiffLine = GitEditorDiffLine, DiffFile = GitEditorDiffFile). The contracts
// leaf cannot import from keiko-ui, so this is a structural compatibility pin, not a guard against
// an independently-evolving client type.
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

import {
  isGitEditorDiffScope as publicDiffScopeGuard,
  isGitEditorDiffLayer as publicDiffLayerGuard,
  isGitEditorDiffLineKind as publicDiffLineKindGuard,
  isGitEditorDiffFileStatus as publicDiffFileStatusGuard,
  parseGitEditorDiffRequest as publicDiffRequest,
  parseGitEditorDiffResponse as publicDiffResponse,
  parseGitEditorBlameRequest as publicBlameRequest,
  parseGitEditorBlameResponse as publicBlameResponse,
  type GitEditorDiffRequest as PublicGitEditorDiffRequest,
  type GitEditorDiffResponse as PublicGitEditorDiffResponse,
  type GitEditorBlameRequest as PublicGitEditorBlameRequest,
  type GitEditorBlameResponse as PublicGitEditorBlameResponse,
  type GitEditorParseResult as PublicGitEditorParseResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";

describe("G1 physical Git read collections", () => {
  for (const [name, parseDiff, parseBlame] of [
    ["source", parseGitEditorDiffResponse, parseGitEditorBlameResponse],
    ["public", publicDiffResponse, publicBlameResponse],
  ] as const) {
    it(`${name} preserves healthy original diff and blame references`, () => {
      const diff = diffResponse();
      const blame = blameResponse();
      const diffResult = parseDiff(diff);
      const blameResult = parseBlame(blame);
      expect(diffResult.ok).toBe(true);
      expect(blameResult.ok).toBe(true);
      if (!diffResult.ok || !blameResult.ok) throw new Error("healthy read fixture was refused");
      expect(diffResult.value).toBe(diff);
      expect(blameResult.value).toBe(blame);
    });
    it(`${name} preserves an inherited present line and its original array reference`, () => {
      const lines = new Array<GitEditorDiffLine>(1);
      Object.setPrototypeOf(lines, [diffLine()]);
      const input = diffResponse({ files: [diffFile({ hunks: [diffHunk({ lines })] })] });
      const result = parseDiff(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("healthy inherited line was refused");
      expect(result.value.files[0]?.hunks[0]?.lines).toBe(lines);
    });
    it(`${name} refuses an absent file`, () => {
      expect(parseDiff(diffResponse({ files: new Array<unknown>(1) }))).toEqual({
        ok: false,
        errors: ["files contain an invalid entry"],
      });
    });
    it(`${name} refuses an absent nested hunk`, () => {
      expect(
        parseDiff(diffResponse({ files: [diffFile({ hunks: new Array<GitEditorDiffHunk>(1) })] })),
      ).toEqual({ ok: false, errors: ["files contain an invalid entry"] });
    });
    it(`${name} refuses an absent nested line`, () => {
      expect(
        parseDiff(
          diffResponse({
            files: [diffFile({ hunks: [diffHunk({ lines: new Array<GitEditorDiffLine>(1) })] })],
          }),
        ),
      ).toEqual({ ok: false, errors: ["files contain an invalid entry"] });
    });
    it(`${name} refuses an absent blame line`, () => {
      expect(parseBlame(blameResponse({ lines: new Array<unknown>(1) }))).toEqual({
        ok: false,
        errors: ["lines contain an invalid entry"],
      });
    });
    it(`${name} refuses a physical malformed file even with overridden every`, () => {
      const files = [{}];
      Object.defineProperty(files, "every", { value: (): boolean => true });
      expect(parseDiff(diffResponse({ files }))).toEqual({
        ok: false,
        errors: ["files contain an invalid entry"],
      });
    });
  }
});

describe("G1 final Editor collection observation", () => {
  for (const [name, parse] of [
    ["source", parseGitEditorDiffResponse],
    ["public", publicDiffResponse],
  ] as const) {
    it(`${name} preserves healthy changing final files observation and input reference`, () => {
      const input = diffResponse();
      if (typeof input !== "object" || input === null)
        throw new TypeError("fixture is not an object");
      const original = [diffFile()];
      const later = [diffFile({ path: "src/later.ts" })];
      let reads = 0;
      Object.defineProperty(input, "files", {
        enumerable: true,
        get: (): unknown => (++reads === 4 ? later : original),
      });
      const result = parse(input);
      expect(reads).toBe(6);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("healthy changing files were refused");
      expect(result.value).toBe(input);
    });
    it(`${name} refuses incomplete member at the final files observation`, () => {
      const input = diffResponse();
      if (typeof input !== "object" || input === null)
        throw new TypeError("fixture is not an object");
      const original = [diffFile()];
      let reads = 0;
      Object.defineProperty(input, "files", {
        enumerable: true,
        get: (): unknown => (++reads === 4 ? [{ layer: "staged" }] : original),
      });
      const result = parse(input);
      expect(reads).toBe(6);
      expect(result).toEqual({ ok: false, errors: ["files contain an invalid entry"] });
    });
  }
});

function hostileInspectionFailures(): readonly { thrown: unknown; errorClass: string }[] {
  const privateName = Object.defineProperty(new Error(), "name", { value: "fixture-private-name" });
  const hostileFields = Object.defineProperties(new Error(), {
    name: {
      get: (): never => {
        throw new Error("fixture-private-name-read");
      },
    },
    message: {
      get: (): never => {
        throw new Error("fixture-private-message-read");
      },
    },
    stack: {
      get: (): never => {
        throw new Error("fixture-private-stack-read");
      },
    },
  });
  const privateTypeName = Object.defineProperty(new TypeError(), "name", {
    value: "fixture-private-type-name",
  });
  const hostilePrototype = new Proxy(new Error(), {
    getPrototypeOf: (): never => {
      throw new Error("fixture-private-prototype-read");
    },
  });
  const opaquePrototype: unknown = Object.create(hostilePrototype);
  const revoked = Proxy.revocable(new Error(), {});
  revoked.revoke();
  return [
    { thrown: privateName, errorClass: "Error" },
    { thrown: hostileFields, errorClass: "Error" },
    { thrown: privateTypeName, errorClass: "TypeError" },
    { thrown: hostilePrototype, errorClass: "unknown error" },
    { thrown: revoked.proxy, errorClass: "unknown error" },
    { thrown: opaquePrototype, errorClass: "unknown error" },
    { thrown: "fixture-private-thrown-value", errorClass: "unknown error" },
    { thrown: null, errorClass: "unknown error" },
  ];
}

/** Each parser closes every hostile getter failure with the same body-free refusal. */
function expectHostileInspectionClosed(
  ...parsers: readonly ((input: object) => GitEditorParseResult<object>)[]
): void {
  for (const failure of hostileInspectionFailures()) {
    const input = Object.defineProperty({}, "schemaVersion", {
      get: (): never => {
        throw failure.thrown;
      },
    });
    const expected = {
      ok: false,
      errors: [`payload could not be inspected: ${failure.errorClass}`],
    };
    for (const parse of parsers) expect(parse(input)).toEqual(expected);
  }
}

export function parsePublicGitEditorDiffRequest(
  input: unknown,
): PublicGitEditorParseResult<PublicGitEditorDiffRequest> {
  const result = publicDiffRequest(input);
  return result;
}

describe("Git DiffRequest public parser (#3918)", () => {
  it("closes hostile thrown values without reading private error fields", () => {
    expectHostileInspectionClosed(parseGitEditorDiffRequest, parsePublicGitEditorDiffRequest);
  });
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf<
      LibraryParserTripleIdentityFacts<
        typeof parseGitEditorDiffRequest,
        typeof publicDiffRequest,
        typeof parsePublicGitEditorDiffRequest
      >
    >().toEqualTypeOf<
      LibraryParserTripleIdentityExpected<
        GitEditorParseResult<GitEditorDiffRequest>,
        PublicGitEditorParseResult<PublicGitEditorDiffRequest>
      >
    >();
  });

  it("retains original staged unstaged and optional-path presence", () => {
    const inputs: readonly GitEditorDiffRequest[] = [
      { schemaVersion: GIT_EDITOR_SCHEMA_VERSION, scope: "staged" },
      { schemaVersion: GIT_EDITOR_SCHEMA_VERSION, scope: "unstaged", path: "src/app.ts" },
      { schemaVersion: GIT_EDITOR_SCHEMA_VERSION, scope: "staged", path: undefined },
    ];
    for (const input of inputs) {
      const result = parsePublicGitEditorDiffRequest(input);
      expect(result).toEqual({ ok: true, value: input });
      if (!result.ok) throw new TypeError("healthy public diff request refused");
      expect(result.value).toBe(input);
      expect(Object.hasOwn(result.value, "path")).toBe(Object.hasOwn(input, "path"));
    }
  });

  it("preserves ordered schema scope and path refusals", () => {
    expect(
      parsePublicGitEditorDiffRequest({ schemaVersion: "2", scope: "all", path: "../x" }),
    ).toEqual({
      ok: false,
      errors: [
        "schemaVersion invalid",
        "scope must be staged or unstaged",
        "path must be a bounded workspace-relative path when present",
      ],
    });
  });

  it("enforces the owning path byte cap and refuses traversal", () => {
    const input = { schemaVersion: GIT_EDITOR_SCHEMA_VERSION, scope: "staged" };
    expect(
      parsePublicGitEditorDiffRequest({ ...input, path: "x".repeat(GIT_EDITOR_PATH_MAX_BYTES) }),
    ).toMatchObject({ ok: true });
    for (const path of [
      "x".repeat(GIT_EDITOR_PATH_MAX_BYTES + 1),
      "é".repeat(GIT_EDITOR_PATH_MAX_BYTES),
      "../x",
      "/x",
      "x\\y",
      "x//y",
    ]) {
      expect(parsePublicGitEditorDiffRequest({ ...input, path })).toEqual({
        ok: false,
        errors: ["path must be a bounded workspace-relative path when present"],
      });
    }
  });

  it("refuses unknown fields and getter failures without retaining private text", () => {
    expect(
      parsePublicGitEditorDiffRequest({
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        scope: "staged",
        extra: "fixture-private-body",
      }),
    ).toEqual({
      ok: false,
      errors: ["request has unknown fields"],
    });
    const input = Object.defineProperty({}, "schemaVersion", {
      get: (): never => {
        throw new TypeError("fixture-private-body");
      },
    });
    expect(parsePublicGitEditorDiffRequest(input)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: TypeError"],
    });
    expect(parsePublicGitEditorDiffRequest(null)).toEqual({
      ok: false,
      errors: ["request must be an object"],
    });
  });
});

export function parsePublicGitEditorDiffResponse(
  input: unknown,
): PublicGitEditorParseResult<PublicGitEditorDiffResponse> {
  const result = publicDiffResponse(input);
  return result;
}

describe("Git DiffResponse public parser (#3918)", () => {
  it("closes hostile thrown values without reading private error fields", () => {
    expectHostileInspectionClosed(parseGitEditorDiffResponse, parsePublicGitEditorDiffResponse);
  });
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf<
      LibraryParserTripleIdentityFacts<
        typeof parseGitEditorDiffResponse,
        typeof publicDiffResponse,
        typeof parsePublicGitEditorDiffResponse
      >
    >().toEqualTypeOf<
      LibraryParserTripleIdentityExpected<
        GitEditorParseResult<GitEditorDiffResponse>,
        PublicGitEditorParseResult<PublicGitEditorDiffResponse>
      >
    >();
  });

  it("retains original response and nested collection references", () => {
    const lines = [diffLine()];
    const hunks = [diffHunk({ lines })];
    const files = [diffFile({ hunks })];
    const input = diffResponse({ files });
    const result = parsePublicGitEditorDiffResponse(input);
    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) throw new TypeError("healthy public diff response refused");
    expect(result.value).toBe(input);
    expect(result.value.files).toBe(files);
    expect(result.value.files[0]?.hunks).toBe(hunks);
    expect(result.value.files[0]?.hunks[0]?.lines).toBe(lines);
  });

  it("enforces the owning file cap and exact scope layer separation", () => {
    const files = Array.from({ length: GIT_EDITOR_DIFF_MAX_FILES }, () => diffFile());
    expect(
      parsePublicGitEditorDiffResponse(diffResponse({ files, totalFiles: files.length })),
    ).toMatchObject({ ok: true });
    files.push(diffFile());
    expect(
      parsePublicGitEditorDiffResponse(diffResponse({ files, totalFiles: files.length })),
    ).toEqual({
      ok: false,
      errors: [`files must be an array of at most ${String(GIT_EDITOR_DIFF_MAX_FILES)} entries`],
    });
    expect(parsePublicGitEditorDiffResponse(diffResponse({ scope: "unstaged" }))).toEqual({
      ok: false,
      errors: ["file layers must match the response scope"],
    });
    expect(
      parsePublicGitEditorDiffResponse(
        diffResponse({ scope: "unstaged", files: [diffFile({ layer: "worktree" })] }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("requires truthful totals and explicit byte truncation", () => {
    expect(parsePublicGitEditorDiffResponse(diffResponse({ totalFiles: 0 }))).toEqual({
      ok: false,
      errors: ["totalFiles must not be smaller than files.length"],
    });
    expect(
      parsePublicGitEditorDiffResponse(diffResponse({ totalBytes: GIT_EDITOR_DIFF_MAX_BYTES + 1 })),
    ).toEqual({ ok: false, errors: ["truncated must be true when totalBytes exceeds maxBytes"] });
    expect(
      parsePublicGitEditorDiffResponse(
        diffResponse({ totalBytes: GIT_EDITOR_DIFF_MAX_BYTES + 1, truncated: true }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("retains nested structural cap edges and refuses one over", () => {
    const edgeHunk = diffHunk({
      header: "@".repeat(GIT_EDITOR_DIFF_MAX_HEADER_CHARS),
      lines: Array.from({ length: GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK }, () => diffLine()),
    });
    const edgeHunks = Array.from({ length: GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE }, () => diffHunk());
    const edgeLine = diffLine({ text: "x".repeat(GIT_EDITOR_DIFF_MAX_LINE_CHARS) });
    for (const file of [
      diffFile({ hunks: [edgeHunk] }),
      diffFile({ hunks: edgeHunks }),
      diffFile({ hunks: [diffHunk({ lines: [edgeLine] })] }),
    ]) {
      expect(parsePublicGitEditorDiffResponse(diffResponse({ files: [file] }))).toMatchObject({
        ok: true,
      });
    }
    const invalidFiles = [
      diffFile({ hunks: [diffHunk({ ...edgeHunk, header: `${edgeHunk.header}@` })] }),
      diffFile({ hunks: [diffHunk({ ...edgeHunk, lines: [...edgeHunk.lines, diffLine()] })] }),
      diffFile({ hunks: [...edgeHunks, diffHunk()] }),
      diffFile({ hunks: [diffHunk({ lines: [diffLine({ text: `${edgeLine.text}x` })] })] }),
    ];
    for (const file of invalidFiles) {
      expect(parsePublicGitEditorDiffResponse(diffResponse({ files: [file] }))).toEqual({
        ok: false,
        errors: ["files contain an invalid entry"],
      });
    }
  });

  it("refuses contradictory coordinates rename and binary payloads", () => {
    const invalidFiles = [
      diffFile({ hunks: [diffHunk({ lines: [diffLine({ kind: "add", oldLine: 1 })] })] }),
      diffFile({ status: "renamed" }),
      diffFile({ binary: true }),
      diffFile({ path: "../secret" }),
    ];
    for (const file of invalidFiles) {
      expect(parsePublicGitEditorDiffResponse(diffResponse({ files: [file] }))).toEqual({
        ok: false,
        errors: ["files contain an invalid entry"],
      });
    }
  });

  it("refuses unknown response fields and closed getter failures", () => {
    expect(
      parsePublicGitEditorDiffResponse(diffResponse({ extra: "fixture-private-body" })),
    ).toEqual({ ok: false, errors: ["response has unknown fields"] });
    const input = Object.defineProperty({}, "files", {
      get: (): never => {
        throw new TypeError("fixture-private-body");
      },
    });
    expect(parsePublicGitEditorDiffResponse(input)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: TypeError"],
    });
  });
});

export function parsePublicGitEditorBlameRequest(
  input: unknown,
): PublicGitEditorParseResult<PublicGitEditorBlameRequest> {
  const result = publicBlameRequest(input);
  return result;
}

describe("Git BlameRequest public parser (#3918)", () => {
  it("closes hostile thrown values without reading private error fields", () => {
    expectHostileInspectionClosed(parseGitEditorBlameRequest, parsePublicGitEditorBlameRequest);
  });
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf<
      LibraryParserTripleIdentityFacts<
        typeof parseGitEditorBlameRequest,
        typeof publicBlameRequest,
        typeof parsePublicGitEditorBlameRequest
      >
    >().toEqualTypeOf<
      LibraryParserTripleIdentityExpected<
        GitEditorParseResult<GitEditorBlameRequest>,
        PublicGitEditorParseResult<PublicGitEditorBlameRequest>
      >
    >();
  });

  it("retains original request at the positive range and cap boundaries", () => {
    for (const maxLines of [1, GIT_EDITOR_BLAME_MAX_LINES]) {
      const input = {
        schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
        path: "src/app.ts",
        startLine: 1,
        maxLines,
      };
      const result = parsePublicGitEditorBlameRequest(input);
      expect(result).toEqual({ ok: true, value: input });
      if (!result.ok) throw new TypeError("healthy public blame request refused");
      expect(result.value).toBe(input);
    }
  });

  it("preserves exact ordered invalid range and path errors", () => {
    expect(
      parsePublicGitEditorBlameRequest({
        schemaVersion: "2",
        path: "../x",
        startLine: 0,
        maxLines: GIT_EDITOR_BLAME_MAX_LINES + 1,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "schemaVersion invalid",
        "path must be a bounded workspace-relative path",
        "startLine must be a positive integer",
        `maxLines must be between 1 and ${String(GIT_EDITOR_BLAME_MAX_LINES)}`,
      ],
    });
  });

  it("refuses noninteger nonfinite and nonpositive ranges", () => {
    const input = {
      schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
      path: "src/app.ts",
      startLine: 1,
      maxLines: 1,
    };
    for (const startLine of [0, 0.5, Number.POSITIVE_INFINITY, "1"]) {
      expect(parsePublicGitEditorBlameRequest({ ...input, startLine })).toEqual({
        ok: false,
        errors: ["startLine must be a positive integer"],
      });
    }
    for (const maxLines of [0, 0.5, Number.POSITIVE_INFINITY, GIT_EDITOR_BLAME_MAX_LINES + 1]) {
      expect(parsePublicGitEditorBlameRequest({ ...input, maxLines })).toEqual({
        ok: false,
        errors: [`maxLines must be between 1 and ${String(GIT_EDITOR_BLAME_MAX_LINES)}`],
      });
    }
  });

  it("refuses unknown fields and getter failures without retaining private text", () => {
    const input = {
      schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
      path: "src/app.ts",
      startLine: 1,
      maxLines: 1,
    };
    expect(parsePublicGitEditorBlameRequest({ ...input, extra: "fixture-private-body" })).toEqual({
      ok: false,
      errors: ["request has unknown fields"],
    });
    const hostile = Object.defineProperty({}, "path", {
      get: (): never => {
        throw new TypeError("fixture-private-body");
      },
    });
    expect(parsePublicGitEditorBlameRequest(hostile)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: TypeError"],
    });
    expect(parsePublicGitEditorBlameRequest(null)).toEqual({
      ok: false,
      errors: ["request must be an object"],
    });
  });
});

export function parsePublicGitEditorBlameResponse(
  input: unknown,
): PublicGitEditorParseResult<PublicGitEditorBlameResponse> {
  const result = publicBlameResponse(input);
  return result;
}

describe("Git BlameResponse public parser (#3918)", () => {
  it("closes hostile thrown values without reading private error fields", () => {
    expectHostileInspectionClosed(parseGitEditorBlameResponse, parsePublicGitEditorBlameResponse);
  });
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf<
      LibraryParserTripleIdentityFacts<
        typeof parseGitEditorBlameResponse,
        typeof publicBlameResponse,
        typeof parsePublicGitEditorBlameResponse
      >
    >().toEqualTypeOf<
      LibraryParserTripleIdentityExpected<
        GitEditorParseResult<GitEditorBlameResponse>,
        PublicGitEditorParseResult<PublicGitEditorBlameResponse>
      >
    >();
  });

  it("retains original response and blame line collection references", () => {
    const lines = [blameLine()];
    const input = blameResponse({ lines });
    const result = parsePublicGitEditorBlameResponse(input);
    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) throw new TypeError("healthy public blame response refused");
    expect(result.value).toBe(input);
    expect(result.value.lines).toBe(lines);
    expect(result.value.lines[0]).toBe(lines[0]);
  });

  it("enforces the owning line cap and explicit byte truncation", () => {
    const lines = Array.from({ length: GIT_EDITOR_BLAME_MAX_LINES }, (_unused, index) =>
      blameLine({ line: index + 1 }),
    );
    expect(
      parsePublicGitEditorBlameResponse(blameResponse({ lines, totalLines: lines.length })),
    ).toMatchObject({ ok: true });
    lines.push(blameLine());
    expect(
      parsePublicGitEditorBlameResponse(blameResponse({ lines, totalLines: lines.length })),
    ).toEqual({
      ok: false,
      errors: [`lines must be an array of at most ${String(GIT_EDITOR_BLAME_MAX_LINES)} entries`],
    });
    expect(
      parsePublicGitEditorBlameResponse(
        blameResponse({ totalBytes: GIT_EDITOR_BLAME_MAX_BYTES + 1 }),
      ),
    ).toEqual({ ok: false, errors: ["truncated must be true when totalBytes exceeds maxBytes"] });
    expect(
      parsePublicGitEditorBlameResponse(
        blameResponse({ totalBytes: GIT_EDITOR_BLAME_MAX_BYTES + 1, truncated: true }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses email source bodies and malformed blame metadata", () => {
    expect(
      parsePublicGitEditorBlameResponse(
        blameResponse({
          lines: [blameLine({ summary: "x".repeat(GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS) })],
        }),
      ),
    ).toMatchObject({ ok: true });

    for (const patch of [
      { authorEmail: "fixture-private-body" },
      { sourceLine: "fixture-private-body" },
      { line: 0 },
      { commitHash: "A".repeat(40) },
      { summary: "x".repeat(GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS + 1) },
    ]) {
      expect(
        parsePublicGitEditorBlameResponse(blameResponse({ lines: [blameLine(patch)] })),
      ).toEqual({ ok: false, errors: ["lines contain an invalid entry"] });
    }
  });

  it("requires consistent totals and refuses hostile response getters", () => {
    expect(parsePublicGitEditorBlameResponse(blameResponse({ totalLines: 0 }))).toEqual({
      ok: false,
      errors: ["totalLines must not be smaller than lines.length"],
    });
    expect(parsePublicGitEditorBlameResponse(blameResponse({ path: "/outside" }))).toEqual({
      ok: false,
      errors: ["path must be a bounded workspace-relative path"],
    });
    const input = Object.defineProperty({}, "lines", {
      get: (): never => {
        throw new TypeError("fixture-private-body");
      },
    });
    expect(parsePublicGitEditorBlameResponse(input)).toEqual({
      ok: false,
      errors: ["payload could not be inspected: TypeError"],
    });
  });
});

// Characterize the existing byte-limit contract through both production entry points.
const responseByteOwners = [
  {
    name: "source diff",
    parse: parseGitEditorDiffResponse,
    create: diffResponse,
    maximum: GIT_EDITOR_DIFF_MAX_BYTES,
    countField: "totalFiles",
    countError: "totalFiles must not be smaller than files.length",
  },
  {
    name: "public diff",
    parse: parsePublicGitEditorDiffResponse,
    create: diffResponse,
    maximum: GIT_EDITOR_DIFF_MAX_BYTES,
    countField: "totalFiles",
    countError: "totalFiles must not be smaller than files.length",
  },
  {
    name: "source blame",
    parse: parseGitEditorBlameResponse,
    create: blameResponse,
    maximum: GIT_EDITOR_BLAME_MAX_BYTES,
    countField: "totalLines",
    countError: "totalLines must not be smaller than lines.length",
  },
  {
    name: "public blame",
    parse: parsePublicGitEditorBlameResponse,
    create: blameResponse,
    maximum: GIT_EDITOR_BLAME_MAX_BYTES,
    countField: "totalLines",
    countError: "totalLines must not be smaller than lines.length",
  },
];

describe("Git Editor response byte consistency (#3918)", () => {
  it.each(responseByteOwners)(
    "$name retains its own byte ceiling and ordered errors",
    ({ parse, create, maximum }) => {
      for (const totalBytes of [0, maximum - 1, maximum]) {
        const input = create({ totalBytes, truncated: false });
        const result = parse(input);
        expect(result).toEqual({ ok: true, value: input });
        if (result.ok) expect(result.value).toBe(input);
      }
      expect(parse(create({ totalBytes: maximum + 1, truncated: false }))).toEqual({
        ok: false,
        errors: ["truncated must be true when totalBytes exceeds maxBytes"],
      });
      const truncated = create({ totalBytes: maximum + 1, truncated: true });
      expect(parse(truncated)).toEqual({ ok: true, value: truncated });
      for (const totalBytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
        expect(parse(create({ totalBytes, truncated: false }))).toEqual({
          ok: false,
          errors: ["totalBytes must be a non-negative integer"],
        });
      }
      expect(parse(create({ totalBytes: maximum + 1, truncated: "invalid", maxBytes: 0 }))).toEqual(
        {
          ok: false,
          errors: [
            "truncated must be a boolean",
            "maxBytes invalid",
            "truncated must be true when totalBytes exceeds maxBytes",
          ],
        },
      );
    },
  );

  it.each(responseByteOwners)(
    "$name retains byte rejection after an earlier collection-count refusal",
    ({ parse, create, maximum, countField, countError }) => {
      const input = create({ [countField]: 0, totalBytes: maximum + 1, truncated: false });
      expect(parse(input)).toEqual({
        ok: false,
        errors: [countError, "truncated must be true when totalBytes exceeds maxBytes"],
      });
    },
  );

  it.each(responseByteOwners)(
    "$name preserves repeated byte reads and short-circuited truncation reads",
    ({ parse, create, maximum }) => {
      for (const scenario of [
        { totalBytes: maximum, reads: ["truncated", "totalBytes", "totalBytes", "totalBytes"] },
        {
          totalBytes: maximum + 1,
          reads: ["truncated", "totalBytes", "totalBytes", "totalBytes", "truncated"],
        },
        { totalBytes: -1, reads: ["truncated", "totalBytes", "totalBytes"] },
      ]) {
        const reads: string[] = [];
        const input = Object.defineProperties(create(), {
          totalBytes: {
            get: (): number => {
              reads.push("totalBytes");
              return scenario.totalBytes;
            },
          },
          truncated: {
            get: (): boolean => {
              reads.push("truncated");
              return false;
            },
          },
        });
        parse(input);
        expect(reads).toEqual(scenario.reads);
      }
    },
  );

  it.each(responseByteOwners)(
    "$name keeps a late byte-read failure opaque after an earlier refusal",
    ({ parse, create, countField }) => {
      let reads = 0;
      const input = Object.defineProperty(create({ [countField]: 0 }), "totalBytes", {
        get: (): number => {
          reads++;
          if (reads === 3) throw new TypeError("fixture-private-body");
          return 1;
        },
      });
      expect(parse(input)).toEqual({
        ok: false,
        errors: ["payload could not be inspected: TypeError"],
      });
      expect(reads).toBe(3);
    },
  );
});

function admissionDiffRequest(): unknown {
  return { schemaVersion: GIT_EDITOR_SCHEMA_VERSION, scope: "staged" };
}

function admissionBlameRequest(): unknown {
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    path: "src/app.ts",
    startLine: 1,
    maxLines: 1,
  };
}

const parserAdmissionOwners = [
  {
    name: "source diff request",
    parse: parseGitEditorDiffRequest,
    create: admissionDiffRequest,
    nonRecordError: "request must be an object",
  },
  {
    name: "public diff request",
    parse: parsePublicGitEditorDiffRequest,
    create: admissionDiffRequest,
    nonRecordError: "request must be an object",
  },
  {
    name: "source blame request",
    parse: parseGitEditorBlameRequest,
    create: admissionBlameRequest,
    nonRecordError: "request must be an object",
  },
  {
    name: "public blame request",
    parse: parsePublicGitEditorBlameRequest,
    create: admissionBlameRequest,
    nonRecordError: "request must be an object",
  },
  {
    name: "source diff response",
    parse: parseGitEditorDiffResponse,
    create: diffResponse,
    nonRecordError: "response must be an object",
  },
  {
    name: "public diff response",
    parse: parsePublicGitEditorDiffResponse,
    create: diffResponse,
    nonRecordError: "response must be an object",
  },
  {
    name: "source blame response",
    parse: parseGitEditorBlameResponse,
    create: blameResponse,
    nonRecordError: "response must be an object",
  },
  {
    name: "public blame response",
    parse: parsePublicGitEditorBlameResponse,
    create: blameResponse,
    nonRecordError: "response must be an object",
  },
];

describe("Git Editor parser admission (#3918)", () => {
  it.each(parserAdmissionOwners)(
    "$name keeps admission within the exception boundary",
    ({ parse, create, nonRecordError }) => {
      const input = create();
      const result = parse(input);
      expect(result).toEqual({ ok: true, value: input });
      if (result.ok) expect(result.value).toBe(input);
      for (const rejected of [null, undefined, true, 1, "fixture", []]) {
        expect(parse(rejected)).toEqual({ ok: false, errors: [nonRecordError] });
      }
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(parse(revoked.proxy)).toEqual({
        ok: false,
        errors: ["payload could not be inspected: TypeError"],
      });
    },
  );

  it.each(parserAdmissionOwners)(
    "$name retains fresh per-call diagnostic arrays",
    ({ parse, create }) => {
      const input = Object.defineProperty(create(), "schemaVersion", { value: "invalid" });
      const first = parse(input);
      const second = parse(input);
      expect(first).toEqual({ ok: false, errors: ["schemaVersion invalid"] });
      expect(second).toEqual(first);
      if (!first.ok && !second.ok) expect(first.errors).not.toBe(second.errors);
    },
  );
});

type CardinalityObservationOwner = (typeof responseByteOwners)[number];
type CardinalityObservationMode =
  "healthy" | "mismatch" | "array-refusal" | "count-refusal" | "count-throw" | "array-throw";

interface CardinalityObservation {
  readonly input: unknown;
  readonly trace: readonly string[];
  readonly receivers: readonly unknown[];
}

function observeCardinalityByteFields(
  input: unknown,
  owner: CardinalityObservationOwner,
  mode: CardinalityObservationMode,
  trace: string[],
  receivers: unknown[],
): void {
  Object.defineProperty(input, "totalBytes", {
    get(this: unknown): number {
      trace.push("bytes");
      receivers.push(this);
      return mode === "healthy" ? owner.maximum : owner.maximum + 1;
    },
  });
  Object.defineProperty(input, "truncated", {
    get(this: unknown): boolean {
      trace.push("truncated");
      receivers.push(this);
      return false;
    },
  });
}

function observeResponseCardinality(
  owner: CardinalityObservationOwner,
  mode: CardinalityObservationMode,
): CardinalityObservation {
  const collectionField = owner.countField === "totalFiles" ? "files" : "lines";
  const guardRead = owner.countField === "totalFiles" ? 5 : 4;
  const members = owner.countField === "totalFiles" ? [diffFile()] : [blameLine()];
  const input = owner.create({ truncated: false });
  const trace: string[] = [];
  const receivers: unknown[] = [];
  let collectionReads = 0;
  let countReads = 0;
  Object.defineProperty(input, collectionField, {
    get(this: unknown): unknown {
      trace.push("collection");
      receivers.push(this);
      collectionReads += 1;
      if (mode === "array-refusal" && collectionReads === guardRead) return null;
      if (mode === "array-throw" && collectionReads === guardRead + 1)
        throw new TypeError("cardinality probe refusal");
      return members;
    },
  });
  Object.defineProperty(input, owner.countField, {
    get(this: unknown): unknown {
      trace.push("count");
      receivers.push(this);
      countReads += 1;
      if (mode === "count-refusal" && countReads === 2) return "invalid";
      if (mode === "count-throw" && countReads === 3)
        throw new TypeError("cardinality probe refusal");
      return mode === "mismatch" && countReads === 3 ? 0 : 1;
    },
  });
  observeCardinalityByteFields(input, owner, mode, trace, receivers);
  return { input, trace, receivers };
}

describe("Git Editor temporal response cardinality (#3918)", (): void => {
  it.each(responseByteOwners)(
    "$name retains later count reads and original receivers",
    (owner): void => {
      const earlier =
        owner.countField === "totalFiles"
          ? ["collection", "collection", "collection", "collection"]
          : ["collection", "collection", "collection"];
      for (const mode of ["healthy", "mismatch"] as const) {
        const probe = observeResponseCardinality(owner, mode);
        const result = owner.parse(probe.input);
        const expected = [
          ...earlier,
          "truncated",
          "count",
          "bytes",
          "collection",
          "count",
          "count",
          "collection",
          "bytes",
          "bytes",
        ];
        if (mode === "mismatch") expected.push("truncated");
        expect(probe.trace).toEqual(expected);
        expect(probe.receivers).toHaveLength(probe.trace.length);
        for (const receiver of probe.receivers) expect(receiver).toBe(probe.input);
        if (mode === "healthy") {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value).toBe(probe.input);
        } else {
          expect(result).toEqual({
            ok: false,
            errors: [owner.countError, "truncated must be true when totalBytes exceeds maxBytes"],
          });
        }
      }
    },
  );

  it.each(responseByteOwners)(
    "$name short-circuits count guards while retaining the byte check",
    (owner): void => {
      const earlier =
        owner.countField === "totalFiles"
          ? ["collection", "collection", "collection", "collection"]
          : ["collection", "collection", "collection"];
      for (const mode of ["array-refusal", "count-refusal"] as const) {
        const probe = observeResponseCardinality(owner, mode);
        expect(owner.parse(probe.input)).toEqual({
          ok: false,
          errors: ["truncated must be true when totalBytes exceeds maxBytes"],
        });
        expect(probe.trace).toEqual(
          mode === "array-refusal"
            ? [
                ...earlier,
                "truncated",
                "count",
                "bytes",
                "collection",
                "bytes",
                "bytes",
                "truncated",
              ]
            : [
                ...earlier,
                "truncated",
                "count",
                "bytes",
                "collection",
                "count",
                "bytes",
                "bytes",
                "truncated",
              ],
        );
      }
    },
  );

  it.each(responseByteOwners)(
    "$name closes late cardinality inspection before the byte check",
    (owner): void => {
      const earlier =
        owner.countField === "totalFiles"
          ? ["collection", "collection", "collection", "collection"]
          : ["collection", "collection", "collection"];
      for (const mode of ["count-throw", "array-throw"] as const) {
        const probe = observeResponseCardinality(owner, mode);
        expect(owner.parse(probe.input)).toEqual({
          ok: false,
          errors: ["payload could not be inspected: TypeError"],
        });
        expect(probe.trace).toEqual(
          mode === "count-throw"
            ? [...earlier, "truncated", "count", "bytes", "collection", "count", "count"]
            : [
                ...earlier,
                "truncated",
                "count",
                "bytes",
                "collection",
                "count",
                "count",
                "collection",
              ],
        );
      }
    },
  );
});

function responsePhaseRefusal(owner: CardinalityObservationOwner): unknown {
  const common = {
    schemaVersion: "invalid",
    extra: true,
    truncated: "invalid",
    totalBytes: -1,
    maxBytes: 0,
  };
  if (owner.countField === "totalFiles") {
    return owner.create({ ...common, scope: "all", files: null, totalFiles: -1, maxFiles: 0 });
  }
  return owner.create({
    ...common,
    path: "../outside",
    startLine: 0,
    lines: null,
    totalLines: -1,
    maxLines: 0,
  });
}

function responsePhaseRefusalErrors(owner: CardinalityObservationOwner): readonly string[] {
  if (owner.countField === "totalFiles") {
    return [
      "response has unknown fields",
      "schemaVersion invalid",
      "scope must be staged or unstaged",
      "files must be an array of at most 400 entries",
      "truncated must be a boolean",
      "totalFiles must be a non-negative integer",
      "totalBytes must be a non-negative integer",
      "maxBytes invalid",
      "maxFiles invalid",
    ];
  }
  return [
    "response has unknown fields",
    "schemaVersion invalid",
    "path must be a bounded workspace-relative path",
    "startLine must be a positive integer",
    "lines must be an array of at most 2000 entries",
    "truncated must be a boolean",
    "totalLines must be a non-negative integer",
    "totalBytes must be a non-negative integer",
    "maxBytes invalid",
    "maxLines invalid",
  ];
}

interface ResponsePhaseFrontier {
  readonly input: unknown;
  readonly trace: readonly string[];
  readonly receivers: readonly unknown[];
}

function observeResponsePhaseFrontier(
  owner: CardinalityObservationOwner,
  mode: "shape-refusal" | "member-refusal",
): ResponsePhaseFrontier {
  const input = owner.create();
  const trace: string[] = [];
  const receivers: unknown[] = [];
  const failure: Error = Object.freeze(new TypeError("synthetic response phase refusal"));
  const collectionField = owner.countField === "totalFiles" ? "files" : "lines";
  Object.defineProperty(input, "schemaVersion", {
    get(this: unknown): string {
      trace.push("shape");
      receivers.push(this);
      return mode === "shape-refusal" ? "invalid" : GIT_EDITOR_SCHEMA_VERSION;
    },
  });
  Object.defineProperty(input, collectionField, {
    get(this: unknown): unknown {
      trace.push("members");
      receivers.push(this);
      if (mode === "shape-refusal") throw failure;
      return null;
    },
  });
  Object.defineProperty(input, "truncated", {
    get(this: unknown): boolean {
      trace.push("totals");
      receivers.push(this);
      if (mode === "member-refusal") throw failure;
      return false;
    },
  });
  return { input, trace, receivers };
}

describe("Git Editor eager response phases (#3918)", (): void => {
  it.each(responseByteOwners)(
    "$name accumulates ordered shape member and totals refusals",
    (owner): void => {
      expect(owner.parse(responsePhaseRefusal(owner))).toEqual({
        ok: false,
        errors: responsePhaseRefusalErrors(owner),
      });
    },
  );

  it.each(responseByteOwners)(
    "$name inspects members after a shape refusal and stops on their throw",
    (owner): void => {
      const probe = observeResponsePhaseFrontier(owner, "shape-refusal");
      expect(owner.parse(probe.input)).toEqual({
        ok: false,
        errors: ["payload could not be inspected: TypeError"],
      });
      expect(probe.trace).toEqual(["shape", "members"]);
      expect(probe.receivers).toHaveLength(probe.trace.length);
      for (const receiver of probe.receivers) expect(receiver).toBe(probe.input);
    },
  );

  it.each(responseByteOwners)(
    "$name inspects totals after a member refusal and closes their throw",
    (owner): void => {
      const probe = observeResponsePhaseFrontier(owner, "member-refusal");
      expect(owner.parse(probe.input)).toEqual({
        ok: false,
        errors: ["payload could not be inspected: TypeError"],
      });
      expect(probe.trace).toEqual(["shape", "members", "totals"]);
      expect(probe.receivers).toHaveLength(probe.trace.length);
      for (const receiver of probe.receivers) expect(receiver).toBe(probe.input);
    },
  );
});

import {
  GIT_EDITOR_DIFF_SCOPES,
  GIT_EDITOR_DIFF_LAYERS,
  GIT_EDITOR_DIFF_LINE_KINDS,
  GIT_EDITOR_DIFF_FILE_STATUSES,
} from "./git-editor.js";

const gitEditorEnumGuardWitnesses = [
  ["scope", GIT_EDITOR_DIFF_SCOPES, isGitEditorDiffScope, publicDiffScopeGuard],
  ["layer", GIT_EDITOR_DIFF_LAYERS, isGitEditorDiffLayer, publicDiffLayerGuard],
  ["line kind", GIT_EDITOR_DIFF_LINE_KINDS, isGitEditorDiffLineKind, publicDiffLineKindGuard],
  [
    "file status",
    GIT_EDITOR_DIFF_FILE_STATUSES,
    isGitEditorDiffFileStatus,
    publicDiffFileStatusGuard,
  ],
] as const;

describe("GitEditor catalog guard boundaries (#3918)", () => {
  for (const [name, catalog, sourceGuard, publicGuard] of gitEditorEnumGuardWitnesses) {
    for (const [surface, guard] of [
      ["source", sourceGuard],
      ["public", publicGuard],
    ] as const) {
      it(`${surface} ${name} admits its catalog and refuses foreign values without coercion`, () => {
        for (const member of catalog) expect(guard(member)).toBe(true);
        expect(guard("not-a-git-editor-value")).toBe(false);
        expect(guard("")).toBe(false);
        let conversions = 0;
        const hostile = {
          [Symbol.toPrimitive](): never {
            conversions += 1;
            throw new TypeError("unexpected GitEditor enum coercion");
          },
        };
        const boxed: unknown = Reflect.construct(String, ["staged"]);
        const refused: readonly unknown[] = [
          undefined,
          null,
          0,
          false,
          Symbol("git-editor-enum"),
          [],
          {},
          boxed,
          hostile,
        ];
        for (const value of refused) expect(guard(value)).toBe(false);
        expect(conversions).toBe(0);
      });
    }
  }
});
