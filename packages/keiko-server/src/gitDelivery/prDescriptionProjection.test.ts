import { afterEach, describe, expect, it } from "vitest";
import { logDescription } from "./prDescriptionProjection.js";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import { PrDescriptionFailure } from "./prDescriptionTypes.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

// The activity envelope uses the closed global error taxonomy while the precise body-free failure
// class remains available in `extra.failureKind` for reconstruction and clustering.
describe("prDescriptionProjection — logDescription failure classification", () => {
  let fixture: DescriptionFixture;
  afterEach(() => {
    fixture.close();
  });

  it("normalizes the envelope errorKind and retains the precise failure kind", () => {
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
    expect(line?.errorKind).toBe("internal");
    expect(line?.extra?.failureKind).toBe("TypeError");
    const persisted = expectActivityLogProof(
      "git.pr-description.emitted-line",
      formatActivityLogProofLine(line ?? {}),
    );
    expect(persisted).toMatchObject({ phase: "apply", reason: "provider-failed" });
  });

  it("carries a failure's closed detail code onto the line (#3390, rehearsal run-20)", () => {
    fixture = new DescriptionFixture();
    logDescription(
      fixture.options,
      fixture.context,
      "preview",
      "provider-failed",
      undefined,
      new PrDescriptionFailure("provider-failed", { detail: "read-invalid-response" }),
    );
    const line = fixture.events.find((event) => event.op === "git.pr-description");
    expect(line?.errorKind).toBe("internal");
    expect(line?.extra?.failureKind).toBe("PrDescriptionFailure");
    expect(line?.extra?.detail).toBe("read-invalid-response");
  });

  it("omits errorKind entirely when no error was passed", () => {
    fixture = new DescriptionFixture();
    logDescription(fixture.options, fixture.context, "preview", "approval-required");
    const line = fixture.events.find((event) => event.op === "git.pr-description");
    expect(line).toBeDefined();
    expect(line?.errorKind).toBeUndefined();
  });

  it("bounds a native code before constructing the activity event", () => {
    fixture = new DescriptionFixture();
    const code = `E${"X".repeat(90)}`;

    expect(() => {
      logDescription(
        fixture.options,
        fixture.context,
        "apply",
        "provider-failed",
        undefined,
        Object.assign(new Error("provider failed"), { code }),
      );
    }).not.toThrow();

    const line = fixture.events.find((event) => event.op === "git.pr-description");
    expect(line?.extra?.failureKind).toBe("internal");
    expect(line?.extra?.code).toBeUndefined();
  });
});
