import { describe, expect, it } from "vitest";
import { withoutQueryPresentationInstructions } from "./repoSearchPresentation.js";

describe("shared query presentation grammar", () => {
  it.each([
    "Cite implementation lines, under 100 words.",
    "Please cite definition lines, below 80 words.",
    "Zitiere Implementierungszeilen, unter 100 Wörtern.",
    "Bitte zitiere Quellzeilen, unter 80 Wörtern.",
    "Keep your answer within 50 sentences.",
    "Please keep it under 12 lines.",
    "Answer briefly.",
    "Please respond concisely.",
    "Antworte knapp mit Belegen.",
    "Bitte antworte kurz mit Quellen.",
    "Antworte kurz.",
  ])("removes only the standalone output instruction: %s", (directive) => {
    expect(withoutQueryPresentationInstructions(`Explain thermal cooldown. ${directive}`)).toMatch(
      /^Explain thermal cooldown[\s.!?;]*$/u,
    );
  });
  it.each([
    "Explain thermal cooldown, with implementation citations.",
    "Explain thermal cooldown, with current source citations.",
    "Explain thermal cooldown, with relevant definition citations.",
  ])("retains the substantive subject before citation formatting: %s", (question) => {
    expect(withoutQueryPresentationInstructions(question)).toMatch(
      /^Explain thermal cooldown[\s.!?;]*$/u,
    );
  });
  it("preserves another source question following a newline citation clause", () => {
    const question =
      "Explain thermal cooldown, with implementation citations\nShow service limits.";
    const remaining = withoutQueryPresentationInstructions(question);
    expect(remaining).toContain("Explain thermal cooldown");
    expect(remaining).toContain("Show service limits.");
    expect(remaining).not.toContain("citations");
  });
  it.each([
    "Cite implementation of FooProbe.",
    "Keep the implementation compatible.",
    "Where should I answer briefly?",
    "Explain thermal cooldown, with current implementation citations for FooProbe.",
    "Keep the answer under an unknown number of words.",
  ])("keeps substantive or unparsed instructions intact: %s", (question) => {
    expect(withoutQueryPresentationInstructions(question)).toBe(question);
  });
  it.each([
    ["Antworte kurz mit FooProbe.", "FooProbe"],
    ["Please cite a source about thermal cooldown.", "thermal cooldown"],
  ])("preserves the subject in a mixed formatting clause: %s", (question, subject) => {
    expect(withoutQueryPresentationInstructions(question)).toContain(subject);
  });
});
