import { describe, expect, it } from "vitest";
import {
  CODING_REPOSITORY_LIMITS,
  captureCodingRepositoryRequest,
  isCodingRepositoryRequest,
} from "./coding-repository-search.js";

const search = {
  kind: "search",
  mode: "literal",
  query: "a useful multi word query",
  caseSensitive: false,
  includeGlobs: [],
  excludeGlobs: [],
  maxResults: CODING_REPOSITORY_LIMITS.returnedHits,
};
const read = { kind: "read", path: "src/example.ts", startLine: 1, endLine: 20, maxBytes: 4096 };

describe("bounded coding repository handler contracts", () => {
  it("captures immutable read and search values without retaining mutable arrays", () => {
    const mutable = { ...search, includeGlobs: ["src/**"] };
    const captured = captureCodingRepositoryRequest(mutable);
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured?.kind !== "search") throw new Error("search capture missing");
    expect(Object.isFrozen(captured.includeGlobs)).toBe(true);
    mutable.includeGlobs[0] = "private/**";
    expect(captured.includeGlobs).toEqual(["src/**"]);
    expect(Object.isFrozen(captureCodingRepositoryRequest(read))).toBe(true);
    expect(captureCodingRepositoryRequest({})).toBeUndefined();
    expect(
      captureCodingRepositoryRequest(
        Object.defineProperty({ ...search }, "query", { enumerable: false }),
      ),
    ).toBeUndefined();
  });
  it.each([search, read])("accepts a bounded request %j", (value) => {
    expect(isCodingRepositoryRequest(value)).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { ...search, root: "/untrusted" },
    { ...search, mode: "semantic" },
    { ...search, query: " " },
    { ...search, query: "x".repeat(201) },
    { ...search, maxResults: 51 },
    { ...search, maxResults: 1.5 },
    { ...search, mode: "regex", query: "(a+)+$" },
    { ...search, mode: "symbol", query: "two names" },
    { ...search, includeGlobs: ["../escape/**"] },
    { ...search, includeGlobs: ["C:/escape/**"] },
    { ...search, includeGlobs: ["src/./**"] },
    { ...search, includeGlobs: ["src\n/**"] },
    { ...search, includeGlobs: ["src\\**"] },
    { ...search, includeGlobs: Array.from({ length: 33 }, () => "src/**") },
    {
      ...search,
      includeGlobs: Array.from({ length: 32 }, () => "src/**"),
      excludeGlobs: ["test/**"],
    },
    { ...search, includeGlobs: ["x".repeat(201)] },
    { ...read, path: "/etc/passwd" },
    { ...read, path: "../outside" },
    { ...read, startLine: 0 },
    { ...read, endLine: 0 },
    { ...read, maxBytes: 65_537 },
  ])("rejects unsupported or unbounded input %j", (value) => {
    expect(isCodingRepositoryRequest(value)).toBe(false);
  });
  it("rejects accessors without evaluating them", () => {
    let reads = 0;
    const input = {
      ...search,
      get query(): string {
        reads += 1;
        return "secret";
      },
    };
    expect(isCodingRepositoryRequest(input)).toBe(false);
    expect(reads).toBe(0);
  });
  it("rejects hidden authority fields and nonstandard glob containers", () => {
    expect(
      isCodingRepositoryRequest(
        Object.defineProperty({ ...search }, "root", { value: "/private" }),
      ),
    ).toBe(false);
    const globs = Object.defineProperty(["src/**"], "every", {
      value: (): never => {
        throw new Error("must not execute");
      },
    });
    expect(isCodingRepositoryRequest({ ...search, includeGlobs: globs })).toBe(false);
    expect(isCodingRepositoryRequest({ ...search, includeGlobs: new Array(2) })).toBe(false);
  });
});
