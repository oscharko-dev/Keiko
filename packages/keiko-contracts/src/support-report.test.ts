import { describe, expect, it } from "vitest";
import {
  isSupportReportDownloadPath,
  isSupportReportFileName,
  supportReportDownloadPath,
  supportReportFileName,
} from "./support-report.js";

describe("closed support report attachment identities", () => {
  it.each([1, 2, 9999])("accepts the filename produced for schema %s", (schema) => {
    expect(
      isSupportReportFileName(supportReportFileName(schema, "a".repeat(32), Date.UTC(2026, 9, 3))),
    ).toBe(true);
  });

  it("accepts the same-origin opaque path emitted by the shared producer", () => {
    const path = supportReportDownloadPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(isSupportReportDownloadPath(path)).toBe(true);
  });

  it.each([
    "https://other.example/report",
    "/api/diagnostics/report/download/../private",
    "/api/diagnostics/report/download/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?token=private",
    "/api/diagnostics/report/download/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/extra",
    "/api/diagnostics/report/download/aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
  ])("rejects an unsafe or non-capability target %s", (path) => {
    expect(isSupportReportDownloadPath(path)).toBe(false);
  });

  it("rejects constructing an attachment path from an unsafe identity", () => {
    expect(() => supportReportDownloadPath("../private")).toThrow(TypeError);
  });
});
