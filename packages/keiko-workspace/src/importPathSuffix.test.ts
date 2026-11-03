import { describe, expect, it } from "vitest";
import { findImportPathSuffix } from "./importPathSuffix.js";

class CountedPaths extends Set<string> {
  public visited = 0;

  public override *[Symbol.iterator](): SetIterator<string> {
    for (const path of super[Symbol.iterator]()) {
      this.visited += 1;
      yield path;
    }
  }
}

describe("structural import suffix lookup", () => {
  it("enumerates the immutable inventory once across distinct unresolved imports", () => {
    const paths = new CountedPaths(
      Array.from({ length: 1_000 }, (_, index) => `services/domain${String(index)}/Entry.java`),
    );
    for (let index = 0; index < 100; index += 1) {
      expect(
        findImportPathSuffix(paths, `external/dependency${String(index)}.java`),
      ).toBeUndefined();
    }
    expect(paths.visited).toBe(paths.size);
  });

  it.each([
    ["domain/entry.java", "a/Domain/Entry.java"],
    ["try.java", "Entry.java"],
    ["entry.java", "Entry.java"],
    ["domain/entry.java/", undefined],
    ["missing.java", undefined],
    ["", "Entry.java"],
  ])(
    "preserves case folding, suffix matching and shortest-path ordering for %s",
    (suffix, expected) => {
      const paths = new Set([
        "longer/Domain/Entry.java",
        "b/domain/Entry.java",
        "a/Domain/Entry.java",
        "Entry.java",
        "different/File.java",
      ]);
      expect(findImportPathSuffix(paths, suffix)).toBe(expected);
      expect(findImportPathSuffix(paths, suffix)).toBe(expected);
    },
  );

  it("does not reuse resolved or missing candidates across workspace inventories", () => {
    expect(findImportPathSuffix(new Set(["one/Entry.java"]), "entry.java")).toBe("one/Entry.java");
    expect(findImportPathSuffix(new Set(["two/Other.java"]), "entry.java")).toBeUndefined();
    expect(findImportPathSuffix(new Set(["two/Entry.java"]), "entry.java")).toBe("two/Entry.java");
  });
});
