import { afterEach, describe, expect, it } from "vitest";
import { logDescription } from "./prDescriptionProjection.js";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";

// Owner audit of PR #3394, finding b3-15 (AGENTS.md §8): every description failure logged
// `errorKind: "internal"` unconditionally instead of deriving it from the actual thrown error the
// way `execution.ts`'s `logGitDeliveryPreconditionFailure` already does via `errorKindOf`. A fixed
// literal collapses every distinct failure into the same bucket in the activity log, which is
// exactly the join key `keiko support analyze` groups `--clusters` by.
describe("prDescriptionProjection — logDescription errorKind", () => {
  let fixture: DescriptionFixture;
  afterEach(() => {
    fixture.close();
  });

  it("derives errorKind from the actual thrown error instead of a fixed 'internal' literal", () => {
    fixture = new DescriptionFixture();
    logDescription(
      fixture.options,
      fixture.context,
      "apply",
      "provider-failed",
      undefined,
      new TypeError("boom"),
    );
    const line = fixture.events.find((event) => event.op === "git.pr-description");
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    expect(line?.errorKind).toBe("TypeError");
    expect(line?.errorKind).not.toBe("internal");
  });

  it("omits errorKind entirely when no error was passed", () => {
    fixture = new DescriptionFixture();
    logDescription(fixture.options, fixture.context, "preview", "approval-required");
    const line = fixture.events.find((event) => event.op === "git.pr-description");
    expect(line).toBeDefined();
    expect(line?.errorKind).toBeUndefined();
  });
});
