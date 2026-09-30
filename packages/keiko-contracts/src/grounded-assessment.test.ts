import { describe, expect, it } from "vitest";

import {
  composeOwnAssessment,
  hasOwnAssessmentTag,
  ownAssessmentPlainText,
  splitOwnAssessment,
  withoutOwnAssessmentTags,
} from "./grounded-assessment.js";

describe("splitOwnAssessment", () => {
  it("keeps an answer without a block wholly source-backed", () => {
    expect(splitOwnAssessment("  Java 17 is required [1].  ")).toEqual({
      grounded: "Java 17 is required [1].",
    });
  });

  it("separates the source-backed part from Keiko's assessment", () => {
    const answer =
      "The documents set no Java version [1].\n\n<assessment>\nMy own assessment: Java 21.\n</assessment>";
    expect(splitOwnAssessment(answer)).toEqual({
      grounded: "The documents set no Java version [1].",
      assessment: "My own assessment: Java 21.",
    });
  });

  it("reads tags case-insensitively and runs an unclosed block to the end", () => {
    expect(splitOwnAssessment("Fact [1]. <Assessment>Mine: Java 21.")).toEqual({
      grounded: "Fact [1].",
      assessment: "Mine: Java 21.",
    });
  });

  it("keeps text after a closed block source-backed and drops stray tags", () => {
    expect(
      splitOwnAssessment("A [1]. <assessment>Mine.</assessment> B [2]. </assessment>"),
    ).toEqual({ grounded: "A [1].\n\nB [2].", assessment: "Mine." });
  });

  it("returns no assessment for an empty block and an empty source part for a block alone", () => {
    expect(splitOwnAssessment("Fact [1]. <assessment>  </assessment>")).toEqual({
      grounded: "Fact [1].",
    });
    expect(splitOwnAssessment("<assessment>Hello! How can I help?</assessment>")).toEqual({
      grounded: "",
      assessment: "Hello! How can I help?",
    });
  });

  it("keeps the offsets of non-ASCII text intact", () => {
    expect(splitOwnAssessment("İstanbul ẞ [1]. <assessment>Einschätzung.</assessment>")).toEqual({
      grounded: "İstanbul ẞ [1].",
      assessment: "Einschätzung.",
    });
  });
});

describe("composeOwnAssessment", () => {
  it("stores the canonical block after the source-backed part and round-trips", () => {
    const stored = composeOwnAssessment("Fact [1].", " Mine. ");
    expect(stored).toBe("Fact [1].\n\n<assessment>\nMine.\n</assessment>");
    expect(splitOwnAssessment(stored)).toEqual({ grounded: "Fact [1].", assessment: "Mine." });
  });

  it("stores the block alone without a source-backed part, and the answer alone without a block", () => {
    expect(composeOwnAssessment("  ", "Hello.")).toBe("<assessment>\nHello.\n</assessment>");
    expect(composeOwnAssessment("Fact [1].", undefined)).toBe("Fact [1].");
  });
});

describe("tag handling for reading and a disabled policy", () => {
  it("detects a tag repeatedly (no global-regex state)", () => {
    expect(hasOwnAssessmentTag("a <assessment>b")).toBe(true);
    expect(hasOwnAssessmentTag("a <assessment>b")).toBe(true);
    expect(hasOwnAssessmentTag("no tag")).toBe(false);
  });

  it("keeps the words and drops the tags", () => {
    expect(withoutOwnAssessmentTags("Fact [1]. <assessment>Mine.</assessment>")).toBe(
      "Fact [1]. Mine.",
    );
    expect(ownAssessmentPlainText("Fact [1].\n\n<assessment>\nMine.\n</assessment>")).toBe(
      "Fact [1].\n\nMine.",
    );
    expect(ownAssessmentPlainText("Plain answer.")).toBe("Plain answer.");
  });
});
