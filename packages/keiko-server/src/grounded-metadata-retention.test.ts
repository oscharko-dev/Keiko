import { describe, expect, it } from "vitest";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { BoundedMetadataPaths, MetadataRetention } from "./grounded-metadata-retention.js";

describe("bounded deterministic metadata retention", () => {
  it("retains late better paths with logarithmic comparison work and bounded membership", () => {
    let comparisons = 0;
    const heap = new BoundedMetadataPaths(128, (left, right) => {
      comparisons += 1;
      return compareStrings(left, right);
    });
    for (let index = 10_000; index > 0; index -= 1)
      heap.retain(`packages/${String(index).padStart(5, "0")}/package.json`);
    const paths = heap.sorted();
    expect(paths).toHaveLength(128);
    expect(paths[0]).toBe("packages/00001/package.json");
    expect(paths.at(-1)).toBe("packages/00128/package.json");
    expect(comparisons).toBeLessThan(10_000 * 30);
    heap.retain(paths[0] ?? "");
    expect(heap.sorted()).toEqual(paths);
  });

  it("keeps primary root manifests ahead of earlier nested paths and counts bounded omissions", () => {
    const retained = new MetadataRetention(3, 2, [""], ["package.json"]);
    for (let index = 0; index < 80; index += 1)
      retained.observe(`packages/service-${String(index).padStart(3, "0")}/package.json`);
    retained.observe("zproject.csproj");
    retained.observe("package.json");
    retained.observeRootFallback("package.json");
    expect(retained.retainedPaths()).toEqual([
      "package.json",
      "zproject.csproj",
      "packages/service-000/package.json",
    ]);
    expect(retained.discardedCount).toBe(79);
    expect(retained.omittedPaths()).toHaveLength(2);
  });
});
