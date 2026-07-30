import { describe, expect, it } from "vitest";

import { formattingApplyDecision } from "./formatting-apply.js";
import type { EditorFormattingResponse, EditorTextEdit } from "./types.js";

const REQUEST = { requestId: "req", streamId: "stream", sequence: 1 };

function edit(newText: string): EditorTextEdit {
  return { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }, newText };
}

function response(over: Partial<EditorFormattingResponse>): EditorFormattingResponse {
  return { request: REQUEST, edits: [], ...over };
}

describe("formattingApplyDecision", () => {
  it("applies a reformat that reports itself uncapped", () => {
    const decision = formattingApplyDecision(
      response({ edits: [edit("a"), edit("b")], truncated: false }),
    );
    expect(decision).toEqual({ status: "apply", edits: [edit("a"), edit("b")] });
  });

  it("applies an uncapped empty result as an already-formatted document, not a refusal", () => {
    expect(formattingApplyDecision(response({ edits: [], truncated: false }))).toEqual({
      status: "apply",
      edits: [],
    });
  });

  it("refuses a capped reformat rather than applying the surviving edits", () => {
    expect(formattingApplyDecision(response({ edits: [edit("a")], truncated: true }))).toEqual({
      status: "refused",
      reason: "capped",
    });
  });

  // The aggregate replacement-byte ceiling can drop every edit while still reporting the cap. An
  // empty capped result is the most dangerous shape, because it is byte-identical to "already
  // formatted": the cap outranks emptiness here for the same reason it does in `classifyResultKind`.
  it("refuses a capped result whose cap dropped every edit", () => {
    expect(formattingApplyDecision(response({ edits: [], truncated: true }))).toEqual({
      status: "refused",
      reason: "capped",
    });
  });

  // `truncated` is optional so a host that cannot know stays honest by omission. Silence is not a
  // claim of partiality, and turning it into a refusal would disable formatting for such a host
  // without any evidence a cap ever bound; the refusal is for a result that STATES it is capped.
  it("applies a result that does not state whether it was capped", () => {
    expect(formattingApplyDecision(response({ edits: [edit("a")] }))).toEqual({
      status: "apply",
      edits: [edit("a")],
    });
    expect(formattingApplyDecision(response({ edits: [edit("a")], truncated: undefined }))).toEqual(
      {
        status: "apply",
        edits: [edit("a")],
      },
    );
  });

  it("never hands a caller the edits of a refused result", () => {
    const decision = formattingApplyDecision(response({ edits: [edit("a")], truncated: true }));
    expect(decision.status).toBe("refused");
    expect(decision).not.toHaveProperty("edits");
  });
});
