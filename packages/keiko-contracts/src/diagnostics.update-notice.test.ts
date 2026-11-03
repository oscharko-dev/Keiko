import { describe, expect, it } from "vitest";
import { isClientDiagnosticIngestRequest } from "./diagnostics.js";
const base = {
  message: "Update notice",
  clientTs: "2026-10-18T00:00:00.000Z",
  correlationId: "ui_notice-0001",
};
const valid = {
  blockerCount: 0,
  noticeKind: "portable-setup-required",
  presentation: "shown",
  updateAvailable: false,
};
describe("closed startup update presentation evidence", () => {
  it.each([
    { blockerCount: 0, noticeKind: "update-available", updateAvailable: true },
    { blockerCount: 0, noticeKind: "critical-update-available", updateAvailable: true },
    { blockerCount: 0, noticeKind: "portable-setup-required", updateAvailable: false },
    { blockerCount: 0, noticeKind: "externally-managed", updateAvailable: false },
    { blockerCount: 0, noticeKind: "check-unavailable", updateAvailable: false },
    { blockerCount: 0, noticeKind: "action-required", updateAvailable: false },
  ])("accepts only coherent shown and dismissed decisions %j", (decision) => {
    for (const presentation of ["shown", "dismissed", "suppressed"]) {
      expect(
        isClientDiagnosticIngestRequest({ ...base, updateNotice: { ...decision, presentation } }),
      ).toBe(true);
      expect(
        isClientDiagnosticIngestRequest({
          ...base,
          updateNotice: { ...decision, presentation, updateAvailable: !decision.updateAvailable },
        }),
      ).toBe(false);
    }
  });
  it("only suppresses reports with no update signal", () => {
    expect(
      isClientDiagnosticIngestRequest({
        ...base,
        updateNotice: {
          blockerCount: 0,
          noticeKind: "no-update-signal",
          presentation: "suppressed",
          updateAvailable: false,
        },
      }),
    ).toBe(true);
    expect(
      isClientDiagnosticIngestRequest({
        ...base,
        updateNotice: {
          blockerCount: 0,
          noticeKind: "no-update-signal",
          presentation: "shown",
          updateAvailable: false,
        },
      }),
    ).toBe(false);
  });
  it.each([
    { blockerCount: 0, noticeKind: "private arbitrary text" },
    { presentation: "opened" },
    { blockerCount: -1 },
    { blockerCount: 0.5 },
    { blockerCount: 1_000_001 },
    { blockerCount: undefined },
    { updateAvailable: "false" },
    { privatePath: "/private/customer" },
    { blockerCount: 0, noticeKind: undefined },
  ])("rejects malformed or extra fields %j", (patch) => {
    expect(isClientDiagnosticIngestRequest({ ...base, updateNotice: { ...valid, ...patch } })).toBe(
      false,
    );
  });
  it("requires an actual correlation and an exclusive closed envelope", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...base, correlationId: undefined, updateNotice: valid }),
    ).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...base, updateNotice: valid, kind: "other" })).toBe(
      false,
    );
    expect(
      isClientDiagnosticIngestRequest({
        ...base,
        updateNotice: valid,
        filesScopeDecision: { decision: "released" },
      }),
    ).toBe(false);
  });
});
