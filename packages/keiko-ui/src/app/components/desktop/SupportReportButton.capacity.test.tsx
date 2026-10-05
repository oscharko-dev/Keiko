import { Blob, resolveObjectURL } from "node:buffer";
import { webcrypto } from "node:crypto";
import { URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canonicalSupportJson,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ApiError } from "@/lib/api";
import * as reportApi from "@/lib/support-report-api";
import * as diagnostics from "@/lib/client-diagnostics";
import { ErrorNoticeFromError } from "./ErrorNotice";
import { resetSupportReportOutcomesForTests } from "./SupportReportButton";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("URL", URL);
  vi.spyOn(diagnostics, "reportClientDiagnostic").mockImplementation(() => undefined);
});
afterEach(() => {
  resetSupportReportOutcomesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function originalFailure(): ApiError {
  const error = new ApiError("FORBIDDEN", "private /customer/manual.html", 403);
  error.correlationId = "capacity-original-failure";
  return error;
}

async function downloadedReport(link: HTMLElement): Promise<SupportReport> {
  const href = link.getAttribute("href");
  if (href === null) throw new TypeError("Download href is missing");
  const blob = resolveObjectURL(href);
  if (blob === undefined) throw new TypeError("Download does not contain a real Blob");
  const text = gunzipSync(Buffer.from(await blob.arrayBuffer())).toString("utf8");
  const report = JSON.parse(text) as SupportReport;
  expect(text).toBe(`${canonicalSupportJson(report)}\n`);
  expect(text).not.toContain("private /customer/manual.html");
  return report;
}

it("downloads canonical local evidence for the selected error after protected delivery capacity returns 503", async () => {
  const create = vi
    .spyOn(reportApi, "createSupportReport")
    .mockRejectedValue(new ApiError("SUPPORT_REPORT_UNAVAILABLE", "capacity unavailable", 503));
  render(<ErrorNoticeFromError error={originalFailure()} fallback="Cannot read the file" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  const link = await screen.findByRole("link", { name: "Download report" });
  const report = await downloadedReport(link);
  expect(report.incident.correlation.rootCorrelationId).toBe("capacity-original-failure");
  expect(report.incident.clientReport).toMatchObject({
    availabilityReason: "service-unavailable",
    failure: { errorKind: "authority-denied", errorEvidence: { errorClass: "ApiError" } },
  });
  expect(link.getAttribute("download")).toMatch(/^keiko-support-v1-.*\.json\.gz$/u);
  await userEvent.click(link);
  expect(diagnostics.reportClientDiagnostic).toHaveBeenCalledWith(
    "[keiko] support report download initiated",
    {
      correlationId: "capacity-original-failure",
      supportReportDelivery: {
        mode: "manual",
        source: "browser",
        evidenceScope: "client-only",
        reportDigest: report.integrity.reportDigest,
      },
    },
  );
  expect(create).toHaveBeenCalledOnce();
});

it("keeps genuine worker-busy 429 separate and does not silently substitute a local report", async () => {
  vi.spyOn(reportApi, "createSupportReport").mockRejectedValue(
    new ApiError("SUPPORT_REPORT_BUSY", "worker busy", 429),
  );
  const objectUrl = vi.spyOn(URL, "createObjectURL");
  render(<ErrorNoticeFromError error={originalFailure()} fallback="Cannot read the file" />);
  await userEvent.click(screen.getByRole("button", { name: "Create error report" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Please wait a minute, then retry this report.",
    ),
  );
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  expect(objectUrl).not.toHaveBeenCalled();
});
