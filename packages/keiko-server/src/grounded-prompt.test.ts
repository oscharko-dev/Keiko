import { describe, expect, it } from "vitest";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import {
  LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER,
  LOCAL_KNOWLEDGE_SYSTEM_PROMPT,
} from "./local-knowledge-grounded-qa.js";

describe("grounded answer prompts", () => {
  it("instructs connected-file answers to preserve code and token literals exactly", () => {
    expect(GROUNDED_SYSTEM_PROMPT).toContain(
      "copy them exactly as shown, preserving ASCII punctuation and hyphen characters",
    );
  });

  it("instructs local-knowledge answers to preserve code and token literals exactly", () => {
    expect(LOCAL_KNOWLEDGE_SYSTEM_PROMPT).toContain(
      "copy them exactly as shown, preserving ASCII punctuation and hyphen characters",
    );
  });

  it("mirrors the user's question language for grounded answers", () => {
    expect(GROUNDED_SYSTEM_PROMPT).toContain("Respond in the same language as the user's question");
    expect(LOCAL_KNOWLEDGE_SYSTEM_PROMPT).toContain(
      "Respond in the same language as the user's question",
    );
  });

  it("keeps a stable local-knowledge no-evidence fallback for structured no-evidence paths", () => {
    expect(LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER).toBe(
      "No evidence found in the selected knowledge scope.",
    );
    expect(LOCAL_KNOWLEDGE_SYSTEM_PROMPT).not.toContain("reply exactly");
  });
});
