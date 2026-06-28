// Issue #502 — Tests for the discussion-mode directive block renderer (ADR-0065).

import { describe, expect, it } from "vitest";
import {
  DISCUSSION_DIRECTIVE_TEMPLATES,
  DISCUSSION_MODES,
  DISCUSSION_MODE_PLANS,
} from "@oscharko-dev/keiko-contracts";
import {
  CONVERSATION_DISCUSSION_BLOCK_HEADER,
  composeDiscussionDirectiveBlock,
} from "./discussion-prompt.js";

// Substrings that must never appear in a rendered block — the block is content-free templates only.
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "baseurl",
  "endpoint",
  "providerconfig",
  "systemprompt",
  "authorization",
  "privatekey",
  "accesskey",
];

describe("composeDiscussionDirectiveBlock", () => {
  it("opens every mode block with the discussion header line", () => {
    for (const mode of DISCUSSION_MODES) {
      const block = composeDiscussionDirectiveBlock(mode);
      expect(block.startsWith(`${CONVERSATION_DISCUSSION_BLOCK_HEADER}\n`)).toBe(true);
    }
  });

  it("renders one bulleted template line per directive, in the plan's declared order", () => {
    for (const mode of DISCUSSION_MODES) {
      const directives = DISCUSSION_MODE_PLANS[mode].directives;
      const expectedLines = directives.map(
        (directive) => `- ${DISCUSSION_DIRECTIVE_TEMPLATES[directive]}`,
      );
      const expected = [CONVERSATION_DISCUSSION_BLOCK_HEADER, ...expectedLines].join("\n");
      expect(composeDiscussionDirectiveBlock(mode)).toBe(expected);
    }
  });

  it("produces exactly header + one line per directive (no blank or extra lines)", () => {
    for (const mode of DISCUSSION_MODES) {
      const lineCount = composeDiscussionDirectiveBlock(mode).split("\n").length;
      expect(lineCount).toBe(DISCUSSION_MODE_PLANS[mode].directives.length + 1);
    }
  });

  it("renders distinct blocks for distinct modes (the mode actually selects the directives)", () => {
    // Mutation guard: a renderer that ignored `mode` would yield identical blocks. challenge and
    // brainstorm have disjoint directive sets, so their blocks must differ.
    expect(composeDiscussionDirectiveBlock("challenge")).not.toBe(
      composeDiscussionDirectiveBlock("brainstorm"),
    );
  });

  it("renders the exact challenge block (pins template wiring and ordering)", () => {
    expect(composeDiscussionDirectiveBlock("challenge")).toBe(
      [
        "Discussion mode directives:",
        "- State your position first, then the evidence that supports it.",
        "- Identify and challenge the assumptions the stated position depends on.",
        "- Surface evidence that weighs against the position, not only evidence for it.",
        "- List the explicit assumptions you are making before drawing a conclusion.",
        "- Disclose your remaining uncertainty and your confidence level for each claim.",
      ].join("\n"),
    );
  });

  it("never emits a forbidden credential- or config-shaped substring", () => {
    for (const mode of DISCUSSION_MODES) {
      const lowered = composeDiscussionDirectiveBlock(mode).toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lowered).not.toContain(forbidden);
      }
    }
  });
});
