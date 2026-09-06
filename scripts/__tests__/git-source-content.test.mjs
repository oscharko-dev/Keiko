import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { readGitSourceContent } from "../lib/git-source-content.mjs";

function blob(content) {
  return Buffer.concat([
    Buffer.from(`${"a".repeat(40)} blob ${Buffer.byteLength(content)}\n`),
    Buffer.from(content),
    Buffer.from("\n"),
  ]);
}

describe("Git source batch framing", () => {
  it("keeps distinct invalid UTF-8 source bytes distinct", () => {
    const first = readGitSourceContent("HEAD", ["src/a.ts"], ".", () => blob(Buffer.from([0x80])));
    const second = readGitSourceContent("HEAD", ["src/a.ts"], ".", () => blob(Buffer.from([0x81])));
    expect(first).not.toEqual(second);
  });
  it("preserves UTF-8 source bytes and header-like body text in path order", () => {
    const content = `ä🙂\n${"b".repeat(40)} blob 999\n`;
    const execute = (_command, args, options) => {
      expect(args).toEqual(["cat-file", "--batch"]);
      expect(options.input).toBe("HEAD:src/a.ts\nHEAD:src/b.ts\n");
      return Buffer.concat([blob(content), blob("")]);
    };
    expect(readGitSourceContent("HEAD", ["src/a.ts", "src/b.ts"], ".", execute)).toEqual([
      { path: "src/a.ts", contentBase64: Buffer.from(content).toString("base64") },
      { path: "src/b.ts", contentBase64: "" },
    ]);
  });

  it.each([
    Buffer.from("HEAD:missing.ts missing\n"),
    Buffer.from(`${"a".repeat(40)} tree 0\n\n`),
    blob("hello").subarray(0, -1),
    Buffer.concat([blob("hello"), Buffer.from("extra")]),
    Buffer.from(`${"a".repeat(40)} blob 9007199254740992\n\n`),
  ])("rejects missing, non-blob, truncated and extra data", (output) => {
    expect(() => readGitSourceContent("HEAD", ["src/a.ts"], ".", () => output)).toThrow(TypeError);
  });

  it("rejects a second batch instruction injected into an object name", () => {
    expect(() => readGitSourceContent("HEAD\nHEAD", ["src/a.ts"], ".")).toThrow(TypeError);
    expect(() => readGitSourceContent("HEAD", ["src/a.ts\0"], ".")).toThrow(TypeError);
  });

  it("does not spawn Git for an empty owned set", () => {
    expect(readGitSourceContent("HEAD", [], ".")).toEqual([]);
  });
});
