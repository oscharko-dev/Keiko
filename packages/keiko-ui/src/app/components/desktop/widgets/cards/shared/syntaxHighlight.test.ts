import { describe, expect, it } from "vitest";
import { highlightLines, langOf, type Token, type TokenKind } from "./syntaxHighlight";

function flatten(lines: Token[][]): Token[] {
  return lines.flatMap((line) => line);
}

function kinds(lines: Token[][]): TokenKind[] {
  return flatten(lines).map(([kind]) => kind);
}

describe("syntaxHighlight", () => {
  it("detects languages from filenames and release-relevant special cases", () => {
    expect(langOf("src/App.tsx")).toBe("ts");
    expect(langOf("script.mjs")).toBe("js");
    expect(langOf("build.gradle")).toBe("js");
    expect(langOf("Dockerfile.prod")).toBe("docker");
    expect(langOf("docker-compose.yml")).toBe("yaml");
    expect(langOf(".env.local")).toBe("props");
    expect(langOf("query.gql")).toBe("graphql");
    expect(langOf("legacy.cbl")).toBe("cobol");
    expect(langOf("README.markdown")).toBe("md");
    expect(langOf("no-extension")).toBe("code");
    expect(langOf("archive.unknown")).toBe("code");
  });

  it("tokenizes markdown headings, fences, lists and inline emphasis", () => {
    const lines = highlightLines(
      ["# Release notes", "```ts", "1. Fix `grounding` and **quality**", "plain text"].join("\n"),
      "md",
    );

    expect(lines[0]).toEqual([["head", "# Release notes"]]);
    expect(lines[1]).toEqual([["com", "```ts"]]);
    expect(lines[2]).toEqual([
      ["ws", ""],
      ["key", "1."],
      ["ws", " "],
      ["id", "Fix "],
      ["str", "`grounding`"],
      ["id", " and "],
      ["type", "**quality**"],
    ]);
    expect(lines[3]).toEqual([["id", "plain text"]]);
  });

  it("tokenizes JSON keys, values, numbers, literals and punctuation", () => {
    const tokens = flatten(
      highlightLines('{ "enabled": true, "count": -12.5, "label": "ok", "none": null }', "json"),
    );

    expect(tokens).toContainEqual(["key2", '"enabled"']);
    expect(tokens).toContainEqual(["lit", "true"]);
    expect(tokens).toContainEqual(["num", "-12.5"]);
    expect(tokens).toContainEqual(["str", '"ok"']);
    expect(tokens).toContainEqual(["lit", "null"]);
    expect(kinds([tokens])).toContain("punct");
    expect(kinds([tokens])).toContain("ws");
  });

  it("keeps multi-line block comments sticky until the closing delimiter", () => {
    const lines = highlightLines(
      ["const answer = 42; /* start", "still comment", "*/ finalCall()"].join("\n"),
      "ts",
    );

    expect(lines[0]).toEqual(
      expect.arrayContaining([
        ["key", "const"],
        ["id", "answer"],
        ["num", "42"],
        ["com", "/* start"],
      ]),
    );
    expect(lines[1]).toEqual([["com", "still comment"]]);
    expect(lines[2]).toEqual(
      expect.arrayContaining([
        ["com", "*/"],
        ["fn", "finalCall"],
        ["punct", "()"],
      ]),
    );
  });

  it("applies line and block comment rules for shell, SQL, COBOL and HTML", () => {
    expect(highlightLines("# comment", "sh")[0]).toEqual([["com", "# comment"]]);
    expect(highlightLines("ENV APP=keiko # build", "docker")[0]).toEqual(
      expect.arrayContaining([
        ["key", "ENV"],
        ["com", "# build"],
      ]),
    );
    expect(highlightLines("SELECT * FROM users -- safe", "sql")[0]).toEqual(
      expect.arrayContaining([
        ["key", "SELECT"],
        ["key", "FROM"],
        ["com", "-- safe"],
      ]),
    );
    expect(highlightLines("*> legacy note", "cobol")[0]).toEqual([["com", "*> legacy note"]]);
    expect(highlightLines("<!-- hidden --> <div>", "html")[0]).toEqual(
      expect.arrayContaining([
        ["com", "<!-- hidden -->"],
        ["punct", "<"],
        ["id", "div"],
        ["punct", ">"],
      ]),
    );
  });

  it("classifies decorators, capitalized identifiers, functions, strings and symbols", () => {
    const tokens = flatten(highlightLines('@Controller class User { say("hi", 3.14); }', "java"));

    expect(tokens).toContainEqual(["type", "@Controller"]);
    expect(tokens).toContainEqual(["key", "class"]);
    expect(tokens).toContainEqual(["type", "User"]);
    expect(tokens).toContainEqual(["fn", "say"]);
    expect(tokens).toContainEqual(["str", '"hi"']);
    expect(tokens).toContainEqual(["num", "3.14"]);
    expect(kinds([tokens])).toContain("punct");
  });
});
