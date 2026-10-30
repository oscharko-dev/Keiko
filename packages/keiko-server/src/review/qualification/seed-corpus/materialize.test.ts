import { describe, expect, it } from "vitest";

import { REVIEW_SEED_CORPUS } from "./index.js";
import {
  materializeReviewSeedTree,
  planReviewSeedTree,
  type ReviewSeedTreeWriter,
} from "./materialize.js";

function memoryWriter(): ReviewSeedTreeWriter & {
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
} {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return {
    files,
    directories,
    makeDirectory: (path): Promise<void> => {
      directories.add(path);
      return Promise.resolve();
    },
    writeFile: (path, content): Promise<void> => {
      files.set(path, content);
      return Promise.resolve();
    },
  };
}

describe("seed corpus materializer", () => {
  it("plans a tree in stable path order", () => {
    expect(planReviewSeedTree({ "src/b.ts": "b", "a.md": "a" })).toEqual([
      { path: "a.md", content: "a" },
      { path: "src/b.ts", content: "b" },
    ]);
  });

  it.each(["../escape.ts", "/abs.ts", "src//double.ts", "src/./dot.ts", "src\\win.ts", ""])(
    "refuses the unsafe fixture path %j",
    (path) => {
      expect(() => planReviewSeedTree({ [path]: "x" })).toThrow(/plain relative path/u);
    },
  );

  it("writes every file of both sides of every corpus case under the root", async () => {
    for (const entry of REVIEW_SEED_CORPUS) {
      for (const side of [entry.baseFiles, entry.headFiles]) {
        const writer = memoryWriter();
        const written = await materializeReviewSeedTree(side, "/tmp/seed", writer);
        expect(written).toHaveLength(Object.keys(side).length);
        for (const [path, content] of Object.entries(side)) {
          expect(writer.files.get(`/tmp/seed/${path}`)).toBe(content);
        }
        expect([...writer.directories].every((dir) => dir.startsWith("/tmp/seed"))).toBe(true);
      }
    }
  });

  it("refuses a relative root", async () => {
    await expect(
      materializeReviewSeedTree({ "a.ts": "" }, "relative", memoryWriter()),
    ).rejects.toThrow(/absolute/u);
  });
});
