import { describe, expect, it } from "vitest";

import { functionalPromptText } from "./_support.js";

describe("functional OpenCode prompt parsing", () => {
  it("forwards the accepted intent and following untrusted context in order", () => {
    const intent = "Implement the accepted task";
    const context = "<untrusted-issue-context>review this boundary</untrusted-issue-context>";

    expect(
      functionalPromptText(
        JSON.stringify({
          parts: [
            { type: "text", text: intent },
            { type: "text", text: context, synthetic: true },
          ],
        }),
      ),
    ).toBe(`${intent}\n\n${context}`);
  });

  it.each([
    { parts: [{ type: "image", text: "not-text" }] },
    { parts: [{ type: "text", text: 7 }] },
    { parts: [] },
  ])("refuses malformed or non-text prompt parts", (body) => {
    expect(functionalPromptText(JSON.stringify(body))).toBe("");
  });
});
