import { describe, expect, it } from "vitest";
import { parseGitBlamePorcelain } from "./gitBlameParser.js";

function record(
  hash: string,
  line: number,
  author: string,
  epoch: number,
  summary: string,
  source: string,
): string {
  return [
    `${hash} ${String(line)} ${String(line)} 1`,
    `author ${author}`,
    "author-mail <private@example.test>",
    `author-time ${String(epoch)}`,
    "author-tz +0000",
    `summary ${summary}`,
    "filename src/app.ts",
    `\t${source}`,
  ].join("\n");
}

describe("parseGitBlamePorcelain", () => {
  it("returns privacy-minimized committed and uncommitted line metadata", () => {
    const committed = "a".repeat(40);
    const uncommitted = "0".repeat(40);
    const parsed = parseGitBlamePorcelain(
      [
        record(committed, 4, "Ada Lovelace", 1_752_172_800, "Add parser", "const secret = 1;"),
        record(uncommitted, 5, "Not Committed Yet", 1_752_172_801, "", "private source"),
        "",
      ].join("\n"),
      { maxLines: 2, processTruncated: false },
    );

    expect(parsed).toMatchObject({ totalLines: 2, truncated: false });
    expect(parsed.lines).toEqual([
      {
        line: 4,
        commitHash: committed,
        author: "Ada Lovelace",
        authorTime: "2025-07-10T18:40:00.000Z",
        summary: "Add parser",
      },
      {
        line: 5,
        commitHash: uncommitted,
        author: "Not Committed Yet",
        authorTime: "2025-07-10T18:40:01.000Z",
        summary: "",
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("private@example.test");
    expect(JSON.stringify(parsed)).not.toContain("private source");
  });

  it("drops malformed, incomplete, and invalid UTF-8 records", () => {
    const valid = record("b".repeat(40), 8, "Grace Hopper", 1_752_172_800, "Valid", "source");
    const parsed = parseGitBlamePorcelain(
      [valid, "not-a-hash 9 9 1\nauthor Mallory\nauthor-time nope\t\ufffd"].join("\n"),
      { maxLines: 10, processTruncated: true },
    );

    expect(parsed).toMatchObject({ totalLines: 2, truncated: true });
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({ line: 8, author: "Grace Hopper" });
  });

  it("enforces the requested line cap while preserving the pre-cap count", () => {
    const input = [1, 2, 3]
      .map((line) => record("c".repeat(40), line, "Author", 1_752_172_800, "Summary", "source"))
      .join("\n");
    const parsed = parseGitBlamePorcelain(input, { maxLines: 2, processTruncated: false });

    expect(parsed).toMatchObject({ totalLines: 3, truncated: true });
    expect(parsed.lines).toHaveLength(2);
  });

  it.each([
    "private@example.invalid",
    "<private@example.invalid>",
    "Maintainer <private@example.invalid>",
  ])("redacts an email-shaped author display name: %s", (author) => {
    const parsed = parseGitBlamePorcelain(
      record("d".repeat(40), 1, author, 1_752_172_800, "Summary", "source"),
      { maxLines: 1, processTruncated: false },
    );

    expect(parsed.lines[0]?.author).toBe("Private author");
    expect(JSON.stringify(parsed)).not.toContain("private@example.invalid");
  });
});
