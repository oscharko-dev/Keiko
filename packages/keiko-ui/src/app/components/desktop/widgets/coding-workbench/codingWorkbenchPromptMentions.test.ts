import { describe, expect, it } from "vitest";

import {
  insertMention,
  mentionIndex,
  mentionTokenAtCursor,
  namesStillMentioned,
  promptMentionsIn,
} from "./codingWorkbenchPromptMentions";

describe("the `@agent` and `$skill` mentions of a prompt (#3906)", () => {
  it("finds the token under the caret only where a mention can begin", () => {
    expect(mentionTokenAtCursor("Use $rev", 8, "$")).toEqual({ start: 4, end: 8, query: "rev" });
    expect(mentionTokenAtCursor("$", 1, "$")).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionTokenAtCursor("costs 5$x", 9, "$")).toBeNull();
    expect(mentionTokenAtCursor("Use $rev now", 12, "$")).toBeNull();
    expect(mentionTokenAtCursor("(@gen", 5, "@")).toEqual({ start: 1, end: 5, query: "gen" });
  });

  it("inserts the picked name and a space, keeping what follows", () => {
    expect(insertMention("Use $re", { start: 4, end: 7 }, "$", "review-method")).toEqual({
      value: "Use $review-method ",
      cursor: 19,
    });
    expect(insertMention("Ask @ex, then", { start: 4, end: 7 }, "@", "explore")).toEqual({
      value: "Ask @explore, then",
      cursor: 12,
    });
  });

  it("names a whole token only, never a longer name or an e-mail address", () => {
    expect(mentionIndex("Ask @explore now", "@", "explore")).toBe(4);
    expect(mentionIndex("Ask @explorer now", "@", "explore")).toBe(-1);
    expect(mentionIndex("mail me@explore.dev", "@", "explore")).toBe(-1);
    expect(mentionIndex("(@explore)", "@", "explore")).toBe(1);
  });

  it("sends each picked name the text still names, once, with the span of its token", () => {
    const text = "Ask @explore, then use $review-method on @explore's notes.";
    const mentions = promptMentionsIn(text, {
      agents: ["explore", "explore", "general"],
      skills: ["review-method"],
    });

    expect(mentions).toEqual({
      agents: [{ name: "explore", mention: { start: 4, end: 12, text: "@explore" } }],
      skills: [{ id: "review-method", mention: { start: 23, end: 37, text: "$review-method" } }],
    });
    const span = mentions?.skills?.[0]?.mention;
    expect(text.slice(span?.start, span?.end)).toBe("$review-method");
    expect(promptMentionsIn("nothing here", { agents: ["explore"], skills: [] })).toBeUndefined();
  });

  it("drops a pick whose token the human deleted", () => {
    expect(namesStillMentioned("Ask @general", ["explore", "general"], "@")).toEqual(["general"]);
  });
});
