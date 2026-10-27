import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFaultQualificationFailure } from "../testing/jira-chat-lab/chat-lifecycle.mjs";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("body-free live qualification failures", () => {
  it("reports restricted harness coordinates without private path or content", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("private fixture content");
    error.stack =
      "Error: private fixture content\n at run (/private/customer/restricted-catalog-cases.mjs:24:2)";
    reportFaultQualificationFailure("jira-chat-restricted", error);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      qualification: "jira-chat-restricted",
      passed: false,
      location: ["restricted-catalog-cases.mjs:24:2"],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private fixture content");
    expect(JSON.stringify(log.mock.calls)).not.toContain("/private/customer");
    expect(process.exitCode).toBe(1);
  });

  it("retains the fixed reconciliation warning and excludes unknown source names", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("fixture");
    error.stack = "Error: fixture\n at run (/private/customer/other-source.mjs:10:1)";
    reportFaultQualificationFailure("jira-chat-restricted", error);
    expect(JSON.parse(log.mock.calls[0][0]).location).toEqual([]);
    expect(log.mock.calls[1][0]).toBe(
      "Incomplete group retained privately. Reconcile read-only; never replay a pending mutation.",
    );
    expect(log).toHaveBeenCalledTimes(2);
  });
});
