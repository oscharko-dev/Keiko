import { describe, expect, it } from "vitest";
import { administrationError } from "../testing/jira-chat-lab/seed-admin.mjs";

describe("administrationError keeps a closed class of the failure and nothing of the page", () => {
  it("names a step that ran out of its time, a navigation that failed and anything else", () => {
    const timeout = Object.assign(
      new Error("locator.fill: Timeout 10000ms exceeded for secret-value"),
      {
        name: "TimeoutError",
      },
    );
    expect(administrationError(timeout)).toMatchObject({ reason: "step-timeout" });
    expect(
      administrationError(new Error("page.goto: net::ERR_CONNECTION_RESET at https://x/?csrf=abc"))
        .reason,
    ).toBe("navigation-failed");
    expect(administrationError(new Error("expect(received).toBe(expected)")).reason).toBe(
      "unclassified",
    );
    expect(administrationError(undefined).reason).toBe("unclassified");
  });

  it("never lets the page's own text through, and keeps a step's own closed reason", () => {
    const failure = administrationError(new Error("password=hunter2 csrf=abc"));
    expect(failure.message).toBe("Synthetic Jira administration failed");
    expect(JSON.stringify(failure)).not.toContain("hunter2");
    const own = Object.assign(new TypeError("x"), { reason: "field-not-found" });
    expect(administrationError(own)).toBe(own);
  });
});
