import { describe, expect, it } from "vitest";

import { classifyRetrievalIntent } from "./intent.js";

describe("classifyRetrievalIntent", () => {
  it.each([
    "Welche Type-Script Version wird in der App verwendet?",
    "Welche Node-Version erwartet das Projekt?",
    "Welcher Test-Runner wird in der UI verwendet?",
    "Which package manager does this repository use?",
  ])("classifies project metadata query: %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("project-metadata");
  });

  it.each([
    "Erkläre grob die Architektur dieses Repositories.",
    "Give me an overview of this codebase structure.",
  ])("classifies repository overview query: %s", (text) => {
    expect(classifyRetrievalIntent(text).intent).toBe("repository-overview");
  });

  it("classifies stacktrace and HTTP failures as diagnostic search", () => {
    expect(classifyRetrievalIntent("Warum bekomme ich HTTP 503 im Chat?").intent).toBe(
      "diagnostic-search",
    );
  });

  it("keeps identifier questions targeted even when they mention the repository", () => {
    expect(classifyRetrievalIntent("How is ZodConfigSchema used in this repository?").intent).toBe(
      "targeted-code-search",
    );
  });

  it("keeps pure stop-word prompts in clarification-needed", () => {
    expect(classifyRetrievalIntent("the and for of").intent).toBe("clarification-needed");
  });

  it.each(["...", " -- .. -- ", "??? !!!", "___ ... ---"])(
    "keeps punctuation-only prompts in clarification-needed: %s",
    (text) => {
      expect(classifyRetrievalIntent(text).intent).toBe("clarification-needed");
    },
  );
});
