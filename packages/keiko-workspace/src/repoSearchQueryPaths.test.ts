import { describe, expect, it } from "vitest";
import {
  mapUnquotedRepositoryFilePaths,
  normalizeUnquotedFilePathToken,
} from "./repoSearchQueryPaths.js";

describe("complete unquoted repository path grammar", () => {
  it.each([
    ["@docs/überblick/test-policy.ts:4", "docs/überblick/test-policy.ts:4"],
    ["./@actual/file.ts", "./@actual/file.ts"],
    ["file:///workspace/src/main.ts", "file:///workspace/src/main.ts"],
    ["@plainIdentifier", "@plainIdentifier"],
  ])("normalizes only a path mention: %s", (token, expected) => {
    expect(normalizeUnquotedFilePathToken(token)).toBe(expected);
  });
  it.each([
    ["(docs/example.ts)", "docs/example.ts"],
    ["docs/example.ts)", "docs/example.ts"],
    ["docs/example.ts.", "docs/example.ts"],
    ["deep/資料/example.test.ts:10:20", "deep/資料/example.test.ts:10:20"],
  ])("retains the complete token before surrounding punctuation: %s", (source, expected) => {
    const paths: string[] = [];
    mapUnquotedRepositoryFilePaths(source, (path, raw) => {
      paths.push(path);
      return raw;
    });
    expect(paths).toEqual([expected]);
  });
  it.each([
    "https://example.test/main.ts",
    "C:\\src\\main.ts",
    "src/directory",
    "main.ts",
    "src/main.abcdefghijklmnopq",
  ])("preserves unsupported or non-path subject tokens: %s", (source) => {
    expect(mapUnquotedRepositoryFilePaths(source, () => "wrongly removed")).toBe(source);
  });
});
