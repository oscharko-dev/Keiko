// The Counter-checker's fixed instruction (ADR-0182 D5, Issue #4136): it names its tools and its
// one output, and since the #4138 tuning it asks for a short check within the wall time.

import { describe, expect, it } from "vitest";
import { REVIEW_COUNTER_CHECK_TOOL_ALIASES } from "@oscharko-dev/keiko-tool-catalog";

import { COUNTER_CHECK_INSTRUCTION } from "./prompt.js";

describe("COUNTER_CHECK_INSTRUCTION", () => {
  it("names the four counter-check tools and the verdict as the only output", () => {
    for (const alias of Object.values(REVIEW_COUNTER_CHECK_TOOL_ALIASES)) {
      expect(COUNTER_CHECK_INSTRUCTION).toContain(alias);
    }
    expect(COUNTER_CHECK_INSTRUCTION).toContain("exactly once. Text outside it is ignored.");
  });

  it("asks for a short check because a check out of time counts as undecided", () => {
    expect(COUNTER_CHECK_INSTRUCTION).toContain("counts as undecided");
    expect(COUNTER_CHECK_INSTRUCTION).toContain("at most four read or search calls");
  });

  it("confirms only a followed input and refutes a candidate that describes no wrong behaviour", () => {
    expect(COUNTER_CHECK_INSTRUCTION).toContain(
      "including every check that runs after the reported lines",
    );
    expect(COUNTER_CHECK_INSTRUCTION).toContain("the input you followed produces the wrong result");
    expect(COUNTER_CHECK_INSTRUCTION).toContain(
      "it says there is no defect, its consequence is none",
    );
  });
});
