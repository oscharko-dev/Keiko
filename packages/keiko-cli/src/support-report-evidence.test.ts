import { describe, expect, it } from "vitest";
import {
  isActivityLogErrorKind,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { SupportReportError } from "@oscharko-dev/keiko-activity-log/reader";
import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import {
  emitSupportReportDegraded,
  emitSupportReportFailed,
  supportReportErrorKind,
  supportReportFailureReason,
} from "./support-report-evidence.js";

const CORRELATION = "support-report-evidence-0001";
// Node puts the private location of the failed operation into a system error's message.
const PRIVATE_PATH = "/home/customer-secret/workspace/support-reports";

function systemError(code: string | undefined): Error {
  const error = new Error(`${code ?? "FAILED"}: operation failed, mkdir '${PRIVATE_PATH}'`);
  return code === undefined ? error : Object.assign(error, { code });
}

function failureEvent(error: unknown): Record<string, unknown> {
  const events: unknown[] = [];
  emitSupportReportFailed(
    {
      write: (event): void => {
        events.push(event);
      },
    },
    CORRELATION,
    "export",
    error,
  );
  expect(events).toHaveLength(1);
  return events[0] as Record<string, unknown>;
}

const SYSTEM_ERROR_KINDS: readonly (readonly [string, ActivityLogErrorKind])[] = [
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["EROFS", "permission-denied"],
  ["EEXIST", "unsafe-target"],
  ["ENOTDIR", "unsafe-target"],
  ["EISDIR", "unsafe-target"],
  ["ENOSPC", "write-failed"],
  ["EDQUOT", "write-failed"],
  ["EIO", "write-failed"],
  // Every other code, and every error without one, is the closed internal kind.
  ["ENOENT", "internal"],
  ["EMFILE", "internal"],
  ["EBUSY", "internal"],
];

describe("support report failure classification", () => {
  it.each(SYSTEM_ERROR_KINDS)(
    "settles the system error %s as the closed kind %s and prints that kind",
    (code, errorKind) => {
      const error = systemError(code);
      expect(supportReportErrorKind(error)).toBe(errorKind);
      expect(isActivityLogErrorKind(errorKind)).toBe(true);
      expect(supportReportFailureReason(error)).toBe(errorKind);
    },
  );

  it.each(SYSTEM_ERROR_KINDS)(
    "never lets the private location of the %s failure reach its evidence line",
    (code, errorKind) => {
      const event = failureEvent(systemError(code));
      expect(event).toMatchObject({
        op: "support.report.failed",
        level: "error",
        correlationId: CORRELATION,
        errorKind,
        extra: { surface: "export" },
      });
      // A raw system error names no report reason, only its closed kind.
      expect((event.extra as Record<string, unknown>).reason).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain("customer-secret");
    },
  );

  it.each([
    ["an error without a code", systemError(undefined)],
    ["a code that is not a string", Object.assign(new Error(PRIVATE_PATH), { code: 13 })],
    ["a code in another spelling", Object.assign(new Error(PRIVATE_PATH), { code: "eacces" })],
    ["a plain object that only carries a code", { code: "EACCES", message: PRIVATE_PATH }],
    ["a thrown string", PRIVATE_PATH],
    ["a thrown null", null],
    ["a thrown undefined", undefined],
  ])("settles %s as the closed internal kind", (_label, error) => {
    expect(supportReportErrorKind(error)).toBe("internal");
    expect(supportReportFailureReason(error)).toBe("internal");
    const event = failureEvent(error);
    expect(event).toMatchObject({ errorKind: "internal" });
    expect(JSON.stringify(event)).not.toContain("customer-secret");
  });

  // The CLI prints the report reason or the hardened file failure; the evidence line carries the
  // closed Activity Log kind. They agree only where the two vocabularies share a word.
  it.each([
    {
      error: new SupportReportError("legacy-input"),
      reason: "legacy-input",
      errorKind: "validation-failed",
    },
    {
      error: new SupportReportError("selection-unavailable"),
      reason: "selection-unavailable",
      errorKind: "invalid-request",
    },
    {
      error: new SupportReportError("seed-unavailable"),
      reason: "seed-unavailable",
      errorKind: "unavailable",
    },
    {
      error: new SafeArtifactFileError("support-report", "target-exists"),
      reason: "target-exists",
      errorKind: "target-exists",
    },
    {
      error: new SafeArtifactFileError("support-report", "publish-failed"),
      reason: "publish-failed",
      errorKind: "write-failed",
    },
    {
      error: new SafeArtifactFileError("support-report", "permission-failed"),
      reason: "permission-failed",
      errorKind: "permission-denied",
    },
  ])("prints $reason while its evidence kind is $errorKind", ({ error, reason, errorKind }) => {
    expect(supportReportFailureReason(error)).toBe(reason);
    expect(supportReportErrorKind(error)).toBe(errorKind);
    expect(isActivityLogErrorKind(errorKind)).toBe(true);
  });

  it("keeps a report reason on the evidence line and nothing of a file failure's message", () => {
    expect(failureEvent(new SupportReportError("legacy-input"))).toMatchObject({
      errorKind: "validation-failed",
      extra: { surface: "export", reason: "legacy-input" },
    });
    const fileFailure = failureEvent(new SafeArtifactFileError("support-report", "target-exists"));
    expect(fileFailure).toMatchObject({ errorKind: "target-exists" });
    expect((fileFailure.extra as Record<string, unknown>).reason).toBeUndefined();
  });
});

// Review #3679: a native loader rejection carries only Node-internal frames; the degraded line
// still names the dist- or source-anchored Keiko site that handled it.
describe("degraded analysis failure site", () => {
  it("names the Keiko catch site when the loader error has no Keiko frame", () => {
    const error = Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
    error.stack = [
      "Error: Cannot find package",
      "    at packageResolve (node:internal/modules/esm/resolve:873:9)",
      "    at moduleResolve (node:internal/modules/esm/resolve:946:18)",
    ].join("\n");
    const events: Record<string, unknown>[] = [];
    emitSupportReportDegraded(
      {
        write: (event): void => {
          events.push(event as unknown as Record<string, unknown>);
        },
      },
      CORRELATION,
      "analyze",
      error,
    );
    const extra = events[0]?.extra as { readonly frames?: readonly string[] } | undefined;
    expect(extra?.frames?.length).toBeGreaterThan(0);
    expect(extra?.frames?.[0]).toMatch(
      /^packages\/keiko-cli\/(?:dist|src)\/support-report-evidence\./u,
    );
    expect(JSON.stringify(events)).not.toContain("node:internal");
  });
});
