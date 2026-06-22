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

  it("sets German as the default answer language for grounded answers", () => {
    expect(GROUNDED_SYSTEM_PROMPT).toContain("Answer in German by default");
    expect(LOCAL_KNOWLEDGE_SYSTEM_PROMPT).toContain("Answer in German by default");
  });

  it("uses a German no-evidence fallback for local knowledge", () => {
    expect(LOCAL_KNOWLEDGE_SYSTEM_PROMPT).toContain(LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER);
  });
});
