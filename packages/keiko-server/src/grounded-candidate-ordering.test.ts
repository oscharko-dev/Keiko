import { describe, expect, it } from "vitest";
import type { CandidateFile } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  orderForDistinctEvidencePaths,
  orderDistinctEvidenceCandidates,
} from "./grounded-candidate-ordering.js";
function candidate(scopePath: string, score: number): CandidateFile {
  return { scopePath, score, signals: [], omitted: undefined };
}

describe("addressed same-basename ordering", () => {
  it("separates healthy unaddressed diversity from any addressed-file demotion", () => {
    const addressed = candidate("src/Feature/validation.ts", 0.8);
    const first = candidate("src/A/helper.ts", 0.7);
    const duplicate = candidate("src/B/helper.ts", 0.6);
    const result = orderDistinctEvidenceCandidates(
      [addressed, first, duplicate, candidate("README.md", 0.5)],
      [],
      new Set(),
      new Set([addressed.scopePath]),
    );
    expect(result.kept[0]).toBe(addressed);
    expect(result.observation.basenameDedupDemotedCount).toBe(1);
    expect(result.observation.addressedBasenameDedupDemotedCount).toBe(0);
  });
  it("keeps all explicitly selected collisions before unaddressed alternatives", () => {
    const first = candidate("src/Form/feature/validation.ts", 0.8);
    const second = candidate("src/Form/validation.ts", 0.7);
    const other = candidate("README.md", 0.75);
    expect(
      orderForDistinctEvidencePaths(
        [first, other, second],
        [],
        new Set(),
        new Set([first.scopePath, second.scopePath]),
      ),
    ).toEqual([first, second, other]);
  });
  it("does not demote several matching path references to the end", () => {
    const first = candidate("src/A/validation.ts", 0.8);
    const second = candidate("src/B/validation.ts", 0.7);
    const other = candidate("src/index.ts", 0.75);
    expect(
      orderForDistinctEvidencePaths(
        [first, other, second],
        [{ kind: "path", term: "validation.ts", weight: 0.95 }],
        new Set(),
      ),
    ).toEqual([first, second, other]);
  });
  it("uses shared parent proximity before path spelling on score ties", () => {
    const related = candidate("src/Form/feature/validation.ts", 0.8);
    const neighbour = candidate("src/Form/feature/helper.ts", 0.9);
    const shallow = candidate("a/validation.ts", 0.8);
    expect(
      orderForDistinctEvidencePaths(
        [neighbour, shallow, related],
        [{ kind: "path", term: "validation.ts", weight: 0.95 }],
        new Set(),
      ).slice(0, 2),
    ).toEqual([related, shallow]);
  });
});
