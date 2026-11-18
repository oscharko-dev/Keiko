import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import { detectWorkspaceAt } from "./detect.js";
import { readExcerpt, type SearchScope } from "./repoSearch.js";
import { buildWorkspaceIndexLexicalRecord } from "./workspaceIndex.js";

// #4439: excerpts, Coding repository hits and index lines of a file with Windows, mixed or lone-CR
// line endings carry no terminator bytes and keep exactly the line numbers of the LF equivalent.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scopeWith(content: string): SearchScope {
  const root = mkdtempSync(join(tmpdir(), "keiko-line-endings-"));
  roots.push(root);
  writeFileSync(join(root, "source.ts"), content);
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "line-endings",
    relativePaths: [],
  };
}

const LINES = ["export function alpha(): number {", "  return 1;", "}", "", "const beta = 2;"];
const LF = LINES.join("\n");
const CASES: readonly (readonly [string, string])[] = [
  ["crlf", LINES.join("\r\n")],
  ["crlf with trailing terminator", `${LINES.join("\r\n")}\r\n`],
  ["mixed", LINES.map((line, index) => line + (index % 2 === 0 ? "\r\n" : "\n")).join("")],
];

async function excerptOf(
  content: string,
  startLine: number,
  endLine: number,
  contentLane?: "editor",
): Promise<{ readonly content: string; readonly endLine: number | undefined }> {
  const result = await readExcerpt(
    scopeWith(content),
    { scopePath: "source.ts", startLine, endLine, maxBytes: 4096 },
    contentLane === undefined ? {} : { contentLane },
  );
  return { content: result.content, endLine: result.atom.lineRange?.endLine };
}

describe("line endings in excerpts and index lines (#4439)", () => {
  it.each(CASES)("reads the LF excerpt from a %s file on both lanes", async (_label, content) => {
    const lfTrailing = content.endsWith("\n") ? `${LF}\n` : LF;
    for (const lane of [undefined, "editor"] as const) {
      expect(await excerptOf(content, 1, 5, lane)).toEqual(await excerptOf(lfTrailing, 1, 5, lane));
      expect(await excerptOf(content, 2, 3, lane)).toEqual({
        content: "  return 1;\n}",
        endLine: 3,
      });
      expect((await excerptOf(content, 5, 5, lane)).content).toBe("const beta = 2;");
    }
  });

  it.each(CASES)("projects the LF Coding repository hit from a %s file", (_label, content) => {
    const lfTrailing = content.endsWith("\n") ? `${LF}\n` : LF;
    for (const [start, end] of [
      [1, 5],
      [2, 3],
      [4, 4],
      [5, 9],
    ] as const) {
      expect(codingRepositoryExcerpt("source.ts", content, start, end, 4096)).toEqual(
        codingRepositoryExcerpt("source.ts", lfTrailing, start, end, 4096),
      );
    }
    expect(codingRepositoryExcerpt("source.ts", content, 2, 3, 4096).snippet).toBe(
      "  return 1;\n}",
    );
  });

  it.each(CASES)("indexes the LF lexical lines of a %s file", (_label, content) => {
    const lfTrailing = content.endsWith("\n") ? `${LF}\n` : LF;
    expect(buildWorkspaceIndexLexicalRecord(content, "source.ts")).toEqual(
      buildWorkspaceIndexLexicalRecord(lfTrailing, "source.ts"),
    );
  });

  it("keeps a lone carriage return as line content, as every line count does", async () => {
    const content = "alpha\rbeta\r\ngamma";
    expect(await excerptOf(content, 1, 2)).toEqual({ content: "alpha\rbeta\ngamma", endLine: 2 });
    expect(codingRepositoryExcerpt("source.ts", content, 2, 2, 4096)).toMatchObject({
      snippet: "gamma",
      endLine: 2,
    });
  });

  it("returns an empty line for blank CRLF lines and an empty file", async () => {
    expect(await excerptOf("\r\n\r\n", 2, 3)).toEqual({ content: "\n", endLine: 3 });
    expect(codingRepositoryExcerpt("source.ts", "\r\n\r\n", 1, 3, 4096).snippet).toBe("\n\n");
    expect(codingRepositoryExcerpt("source.ts", "", 1, 1, 4096)).toMatchObject({
      snippet: "",
      endLine: 1,
    });
  });

  it("clamps the normalized excerpt, never a terminator byte, to the byte budget", () => {
    const content = LINES.join("\r\n");
    const clamped = codingRepositoryExcerpt("source.ts", content, 1, 2, 35);
    expect(clamped).toEqual(codingRepositoryExcerpt("source.ts", LF, 1, 2, 35));
    expect(clamped.snippet).not.toContain("\r");
  });
});
