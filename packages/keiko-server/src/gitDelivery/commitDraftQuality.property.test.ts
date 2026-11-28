import { expect, it } from "vitest";
import { checkProperty } from "../../../../tests/support/property-testing.js";
import { inspectCommitDraftDiff } from "./commitDraftQuality.js";

it("counts blank and nonblank edits separately across mixed hunks", async () => {
  await checkProperty({
    name: "classification counts both edits in every pair",
    generate: (random) =>
      Array.from({ length: random.integer(1, 16) }, () => ({
        removed: random.pick(["- ", "-\t", "-"]),
        added: random.pick(["+", "+\t", "+ "]),
      })),
    property: (edits) => {
      const semantic = edits.flatMap((_, index) => [
        `-  accept("Before——${String(index)}")`,
        `+  accept("After——${String(index)}")`,
      ]);
      const header = `@@ -1,${String(edits.length * 2)} +1,${String(edits.length * 2)} @@`;
      const patch = [
        "diff --git a/review.ts b/review.ts",
        header,
        ...edits.flatMap((entry, index) => [
          entry.removed,
          semantic[index * 2],
          entry.added,
          semantic[index * 2 + 1],
        ]),
      ].join("\n");
      expect(inspectCommitDraftDiff(patch)).toEqual({
        blankChangedLines: edits.length * 2,
        nonBlankChangedLines: semantic.length,
        mixedBlankChangeFiles: 1,
      });
    },
  });
});
