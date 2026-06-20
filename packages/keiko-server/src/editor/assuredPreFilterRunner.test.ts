import { describe, it, expect } from "vitest";
import {
  candidateFileText,
  planGateCommands,
  relativizeCoverageSummary,
  targetSourceRelPath,
} from "./assuredPreFilterRunner.js";
import type { EditorTestGenerationWireTarget } from "@oscharko-dev/keiko-contracts";

describe("targetSourceRelPath", () => {
  it("returns the document path for a single-document target", () => {
    const target: EditorTestGenerationWireTarget = {
      kind: "file",
      document: { path: "src/widget.ts", languageId: "typescript", text: "" },
    };
    expect(targetSourceRelPath(target)).toBe("src/widget.ts");
  });

  it("returns the first document for a changed-file-set target", () => {
    const target: EditorTestGenerationWireTarget = {
      kind: "changed-file-set",
      documents: [
        { path: "src/a.ts", languageId: "typescript", text: "" },
        { path: "src/b.ts", languageId: "typescript", text: "" },
      ],
    };
    expect(targetSourceRelPath(target)).toBe("src/a.ts");
  });
});

describe("planGateCommands", () => {
  it("builds the TS/JS toolchain gate commands writing reports under the assured dir", () => {
    const cmds = planGateCommands();
    expect(cmds.build).toEqual({ command: "npx", args: ["tsc", "--noEmit"] });
    expect(cmds.test).toEqual({ command: "npx", args: ["vitest", "run"] });
    expect(cmds.coverage.args).toContain("--coverage");
    expect(cmds.coverage.args.some((a) => a.includes(".keiko-assured/patched"))).toBe(true);
    expect(cmds.baseline.args.some((a) => a.includes(".keiko-assured/baseline"))).toBe(true);
    expect(cmds.mutation).toEqual({ command: "npx", args: ["stryker", "run"] });
  });
});

describe("relativizeCoverageSummary", () => {
  it("strips the disposable root prefix from absolute coverage keys", () => {
    const summary = {
      "/tmp/keiko-assured-x/src/widget.ts": { lines: { covered: 9 } },
      total: { lines: { covered: 9 } },
    };
    expect(relativizeCoverageSummary(summary, "/tmp/keiko-assured-x")).toEqual({
      "src/widget.ts": { lines: { covered: 9 } },
      total: { lines: { covered: 9 } },
    });
  });

  it("passes through a non-object summary unchanged", () => {
    expect(relativizeCoverageSummary(undefined, "/tmp/x")).toBeUndefined();
  });
});

describe("candidateFileText", () => {
  it("concatenates the edit newText fragments", () => {
    expect(candidateFileText([{ newText: "a" }, { newText: "b\n" }])).toBe("ab\n");
  });
});
