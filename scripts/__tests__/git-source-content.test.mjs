import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGitSourceContent } from "../lib/git-source-content.mjs";

function blob(content) {
  return Buffer.concat([
    Buffer.from(`${"a".repeat(40)} blob ${Buffer.byteLength(content)}\n`),
    Buffer.from(content),
    Buffer.from("\n"),
  ]);
}

function inventory(paths, mode = "100644") {
  return Buffer.from(paths.map((path) => `${mode} blob ${"a".repeat(40)}\t${path}\0`).join(""));
}

function gitOutput(paths, content, mode = "100644") {
  return (_command, args, options) => {
    if (args[0] === "ls-tree") return inventory(paths, mode);
    expect(args).toEqual(["cat-file", "--batch"]);
    return content(options);
  };
}

describe("Git source batch framing", () => {
  it("keeps distinct invalid UTF-8 source bytes distinct", () => {
    const path = "src/a.ts";
    const first = readGitSourceContent(
      "HEAD",
      [path],
      ".",
      gitOutput([path], () => blob(Buffer.from([0x80]))),
    );
    const second = readGitSourceContent(
      "HEAD",
      [path],
      ".",
      gitOutput([path], () => blob(Buffer.from([0x81]))),
    );
    expect(first).not.toEqual(second);
  });
  it("preserves UTF-8 source bytes and header-like body text in path order", () => {
    const content = `ä🙂\n${"b".repeat(40)} blob 999\n`;
    const execute = gitOutput(["src/a.ts", "src/b.ts"], (options) => {
      expect(options.input).toBe("HEAD:src/a.ts\nHEAD:src/b.ts\n");
      return Buffer.concat([blob(content), blob("")]);
    });
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
    expect(() =>
      readGitSourceContent(
        "HEAD",
        ["src/a.ts"],
        ".",
        gitOutput(["src/a.ts"], () => output),
      ),
    ).toThrow(TypeError);
  });

  it("rejects Git symlinks and an incomplete source inventory", () => {
    expect(() =>
      readGitSourceContent(
        "HEAD",
        ["src/a.ts"],
        ".",
        gitOutput(["src/a.ts"], () => blob("target"), "120000"),
      ),
    ).toThrow(TypeError);
    expect(() =>
      readGitSourceContent(
        "HEAD",
        ["src/a.ts"],
        ".",
        gitOutput([], () => blob("source")),
      ),
    ).toThrow(TypeError);
  });

  it("rejects a real historical Git symlink entry before reading its blob", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-h1-git-symlink-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "fixture@keiko.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Keiko Fixture"], { cwd: root });
      const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        encoding: "utf8",
        input: "outside.ts",
      }).trim();
      execFileSync("git", ["update-index", "--add", "--cacheinfo", "120000", oid, "src/a.ts"], {
        cwd: root,
      });
      execFileSync("git", ["commit", "--quiet", "-m", "symlink source"], { cwd: root });
      expect(() => readGitSourceContent("HEAD", ["src/a.ts"], root, execFileSync)).toThrow(
        TypeError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a second batch instruction injected into an object name", () => {
    expect(() => readGitSourceContent("HEAD\nHEAD", ["src/a.ts"], ".")).toThrow(TypeError);
    expect(() => readGitSourceContent("HEAD", ["src/a.ts\0"], ".")).toThrow(TypeError);
  });

  it("does not spawn Git for an empty owned set", () => {
    expect(readGitSourceContent("HEAD", [], ".")).toEqual([]);
  });
});
