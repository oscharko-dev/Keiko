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

  it.each([0, -1, 1.5, 10_000, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses to construct a filename outside the schema grammar: %s",
    (schema) => {
      expect(() => supportReportFileName(schema, "a".repeat(32), Date.UTC(2026, 9, 3))).toThrow(
        TypeError,
      );
    },
  );
  it.each(["short", "A".repeat(32), "not-a-private-incident", "g".repeat(32)])(
    "refuses to construct a filename from an invalid incident prefix: %s",
    (incidentId) => {
      expect(() => supportReportFileName(1, incidentId, Date.UTC(2026, 9, 3))).toThrow(TypeError);
    },
  );
  it("refuses a date outside the four-digit filename grammar", () => {
    expect(() => supportReportFileName(1, "a".repeat(32), Date.UTC(10_000, 9, 3))).toThrow(
      TypeError,
    );
  });
  it("accepts the same-origin opaque path emitted by the shared producer", () => {
    const path = supportReportDownloadPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(isSupportReportDownloadPath(path)).toBe(true);
  });

  it.each([
    "keiko-support-v0-abcdef012345-2026-10-03.json",
    "keiko-support-v01-abcdef012345-2026-10-03.json",
    "keiko-support-v10000-abcdef012345-2026-10-03.json",
    "keiko-support-v1-ABCDEF012345-2026-10-03.json",
    "keiko-support-v1-gbcdef012345-2026-10-03.json",
    "keiko-support-v1-abcdef01234-2026-10-03.json",
    "keiko-support-v1-abcdef0123456-2026-10-03.json",
    "keiko-support-v1-abcdef012345-2026-1-03.json",
    "keiko-support-v1-abcdef012345-2026-10-3.json",
    "keiko-support-v1-abcdef012345-2026-10-03",
    "keiko-support-v1-abcdef012345-2026-10-03.json.gz",
    "keiko-support-v1-abcdef012345-2026-10-03.json/extra",
    "../keiko-support-v1-abcdef012345-2026-10-03.json",
    "keiko-support-v1-abcdef012345-2026-10-03.json\n",
    "keiko-support-v1-abcdef012345-2026-10-03.json\r",
  ])("rejects a filename outside the canonical attachment grammar: %j", (name) => {
    expect(isSupportReportFileName(name)).toBe(false);
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
