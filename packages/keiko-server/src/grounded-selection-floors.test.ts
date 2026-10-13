import { describe, expect, it } from "vitest";
import type { CandidateFile } from "@oscharko-dev/keiko-contracts/connected-context";
import { selectGroundedCandidateFiles } from "./grounded-evidence-selection.js";
function candidate(scopePath: string, score: number): CandidateFile {
  return { scopePath, score, signals: [], omitted: undefined };
}

describe("robust ordinary-candidate selection floors", () => {
  it("ignores a flat definition bonus when ordinary hits define the relative reference", () => {
    const ordinary = [candidate("first.ts", 0.2), candidate("second.ts", 0.12)];
    const definition = {
      ...candidate("definition.ts", 0.9),
      signals: [{ name: "symbol-definition", value: 1 }],
    };
    const result = selectGroundedCandidateFiles({
      kept: [definition, ...ordinary],
      omitted: [],
      scopeKind: "workspace-root",
      filesReadMax: null,
      nowMs: 1,
    });
    expect(result.kept).toEqual([definition, ...ordinary]);
  });
  it("excludes priority and protected content paths from the ordinary reference", () => {
    const first = candidate("selected.ts", 0.95);
    const second = candidate("actual.ts", 0.9);
    const ordinary = candidate("ordinary.ts", 0.2);
    const result = selectGroundedCandidateFiles({
      kept: [first, second, ordinary],
      omitted: [],
      scopeKind: "workspace-root",
      filesReadMax: null,
      priorityPaths: new Set([first.scopePath]),
      protectedContentPaths: new Set([second.scopePath]),
      nowMs: 1,
    });
    expect(result.kept).toEqual([first, second, ordinary]);
  });
});
