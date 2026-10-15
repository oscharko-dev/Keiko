import { describe, expect, it } from "vitest";
import {
  markdownSkillSourceReferences,
  markdownSkillSourceReferencesMatch,
} from "./markdownSkillSources.js";

const SOURCE =
  "# Garden sensor concept\n## Confirmed behavior\nInspect boundaries first.\n## Open questions\nThe calibration owner is unknown.";

function draftWithReferences(references: readonly string[]): string {
  return `# Reviewed method\n\n## Source references\n${references.join("\n")}\n`;
}

describe("Markdown skill source references", () => {
  it("identifies the supplied headings and their actual complete line ranges", () => {
    expect(markdownSkillSourceReferences(SOURCE)).toEqual([
      "- Source lines 1-1: Garden sensor concept",
      "- Source lines 2-3: Confirmed behavior",
      "- Source lines 4-5: Open questions",
    ]);
  });

  it("uses complete paragraph ranges for plain text without requiring Markdown", () => {
    expect(markdownSkillSourceReferences("Inspect the sensor.\n\n\nOwner undecided.")).toEqual([
      "- Source lines 1-3: Inspect the sensor.",
      "- Source lines 4-4: Owner undecided.",
    ]);
  });

  it("includes the preamble and does not treat fenced sample headings as source sections", () => {
    const source = "Intro\n# Sensor\n```md\n## Sample\n```\n## Decision\nStill open.";
    expect(markdownSkillSourceReferences(source)).toEqual([
      "- Source lines 1-1: Intro",
      "- Source lines 2-5: Sensor",
      "- Source lines 6-7: Decision",
    ]);
  });

  it("bounds index length while retaining contiguous coverage through the final source line", () => {
    const source = Array.from(
      { length: 100 },
      (_, index) => `## Section ${String(index)}\nRule.`,
    ).join("\n");
    const references = markdownSkillSourceReferences(source);
    expect(references.length).toBeLessThanOrEqual(24);
    let covered = 0;
    for (const reference of references) {
      const range = /^- Source lines (\d+)-(\d+):/u.exec(reference);
      expect(Number(range?.[1])).toBe(covered + 1);
      covered = Number(range?.[2]);
    }
    expect(covered).toBe(source.split("\n").length);
  });

  it("bounds long labels without splitting a Unicode character", () => {
    const reference = markdownSkillSourceReferences(`# ${"🌱".repeat(130)}`)[0];
    expect(reference).toBe(`- Source lines 1-1: ${"🌱".repeat(120)}…`);
  });

  it("accepts the exact source index and surrounding whitespace without modifying output", () => {
    const references = markdownSkillSourceReferences(SOURCE);
    const draft = draftWithReferences(references.map((line) => `  ${line}  `));
    expect(markdownSkillSourceReferencesMatch(draft, SOURCE)).toBe(true);
  });

  it.each(["missing", "invented", "changed-label", "changed-range", "duplicate-section"])(
    "rejects %s provenance even when the reference section is nonempty",
    (failure) => {
      const references = [...markdownSkillSourceReferences(SOURCE)];
      if (failure === "missing") references.pop();
      if (failure === "invented") references.push("- Source lines 20-30: Invented policy");
      if (failure === "changed-label") references[0] = "- Source lines 1-1: Approved policy";
      if (failure === "changed-range") references[0] = "- Source lines 1-20: Garden sensor concept";
      const draft = draftWithReferences(references);
      const output = failure === "duplicate-section" ? `${draft}\n${draft}` : draft;
      expect(markdownSkillSourceReferencesMatch(output, SOURCE)).toBe(false);
    },
  );
});
