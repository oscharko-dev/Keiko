import { describe, expect, it } from "vitest";

import { createExplicitSkillInvocationTracker } from "./explicitSkillInvocation.js";

const SKILL = "skl_repo-structure-summary@1";

describe("createExplicitSkillInvocationTracker", () => {
  it("binds an exact approved $skill mention to one invocation", () => {
    const tracker = createExplicitSkillInvocationTracker({ has: (id) => id === SKILL });
    tracker.observeTurn(`Use $skill ${SKILL} for this turn`);

    expect(tracker.consume(SKILL)).toBe(true);
    expect(tracker.consume(SKILL)).toBe(false);
  });

  it("rejects unapproved, embedded, and stale mentions", () => {
    const tracker = createExplicitSkillInvocationTracker({ has: () => false });
    tracker.observeTurn(`prefix$${SKILL} $skl_unapproved@1`);
    expect(tracker.consume(SKILL)).toBe(false);

    tracker.clear();
    expect(tracker.consume(SKILL)).toBe(false);
  });
});
