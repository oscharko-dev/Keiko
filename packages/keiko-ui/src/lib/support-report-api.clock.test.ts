import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopSupportReportResponse } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { SUPPORT_REPORT_DELIVERY_TTL_MS } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalSupportReportFixture } from "../test-utils/support-report-fixture";
import {
  createSupportReport,
  createSupportReportDownload,
  SupportReportResponseInvalid,
} from "./support-report-api";
import { CORRELATION_HEADER } from "./bff-correlation";

vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
  repairLocalCodingAppSessionWithEvidence: (): Promise<unknown> =>
    Promise.resolve({ repaired: true, correlationId: "clock-test-session" }),
}));

const BROWSER_NOW = Date.UTC(2026, 9, 5, 12);
const DOWNLOAD_PATH = "/api/diagnostics/report/download/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let fixture: DesktopSupportReportResponse;

beforeAll(async () => {
  fixture = await canonicalSupportReportFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respondWithExpiry(
  expiry: number,
  date?: string,
  bodyElapsedMs = 0,
  preparationMs = 0,
): void {
  let monotonic = 1_000;
  vi.spyOn(Date, "now").mockReturnValue(BROWSER_NOW);
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      monotonic += preparationMs;
      const headers = new Headers({ [CORRELATION_HEADER]: "clock-test-report" });
      if (date !== undefined) headers.set("Date", date);
      const response = new Response(
        JSON.stringify({ ...fixture, downloadPath: DOWNLOAD_PATH, downloadExpiresAtMs: expiry }),
        { headers },
      );
      const readJson = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => {
        const body: unknown = await readJson();
        monotonic += bodyElapsedMs;
        return body;
      });
      return Promise.resolve(response);
    }),
  );
}

describe("support report download clock authority", () => {
  it.each([-3_600_000, 5_000, 3_600_000])(
    "keeps a valid server download usable with %i ms clock skew",
    async (skew) => {
      const serverNow = BROWSER_NOW + skew;
      const expiry = serverNow + SUPPORT_REPORT_DELIVERY_TTL_MS;
      respondWithExpiry(expiry, new Date(serverNow).toUTCString());
      const report = await createSupportReport();
      expect(report.downloadExpiresAtMs).toBe(expiry);
      const download = createSupportReportDownload(report);
      expect(download.href).toBe(DOWNLOAD_PATH);
      expect(download.fileName).toBe(`${fixture.fileName}.gz`);
      expect(download.expiresAtMs).toBeGreaterThan(
        BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS - 2_000,
      );
      expect(download.expiresAtMs).toBeLessThanOrEqual(
        BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS,
      );
    },
  );

  it("accepts the last millisecond represented by a whole-second server Date", async () => {
    respondWithExpiry(
      BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS + 999,
      new Date(BROWSER_NOW).toUTCString(),
    );
    const download = createSupportReportDownload(await createSupportReport());
    expect(download.expiresAtMs).toBe(BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS - 1);
  });

  it("subtracts observed body processing and Date precision from server expiry", async () => {
    respondWithExpiry(BROWSER_NOW + 5_000, new Date(BROWSER_NOW).toUTCString(), 2_000);
    const download = createSupportReportDownload(await createSupportReport());
    expect(download.expiresAtMs).toBe(BROWSER_NOW + 2_000);
  });

  it("accepts a freshly issued capability after preparation longer than the delivery lifetime", async () => {
    respondWithExpiry(
      BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS,
      new Date(BROWSER_NOW).toUTCString(),
      0,
      SUPPORT_REPORT_DELIVERY_TTL_MS * 2,
    );
    const download = createSupportReportDownload(await createSupportReport());
    expect(download.expiresAtMs).toBe(BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS - 1_000);
  });

  it.each([0, 1_000, SUPPORT_REPORT_DELIVERY_TTL_MS + 1_000])(
    "rejects an expired or impossible server-relative expiry %i with its response identity",
    async (remaining) => {
      const serverNow = BROWSER_NOW + 3_600_000;
      respondWithExpiry(serverNow + remaining, new Date(serverNow).toUTCString());
      await expect(createSupportReport()).rejects.toMatchObject({
        name: "ApiError",
        code: "CONTRACT_VALIDATION_FAILED",
        correlationId: "clock-test-report",
      });
    },
  );

  it("rejects a response whose remaining server lifetime was consumed reading its body", async () => {
    respondWithExpiry(BROWSER_NOW + 5_000, new Date(BROWSER_NOW).toUTCString(), 5_000);
    await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
  });

  it("retains the exact local TTL boundary when an older response has no Date header", async () => {
    respondWithExpiry(BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS);
    const report = await createSupportReport();
    expect(createSupportReportDownload(report).expiresAtMs).toBe(report.downloadExpiresAtMs);
  });

  it.each([0, SUPPORT_REPORT_DELIVERY_TTL_MS + 1])(
    "does not extend a headerless expiry outside the local boundary by %i ms",
    async (remaining) => {
      respondWithExpiry(BROWSER_NOW + remaining);
      await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
    },
  );

  it.each(["invalid", "2026-10-05", "Mon, 05 Oct 2026 12:00:00 GMT, private"])(
    "does not infer a clock offset from malformed server Date %s",
    async (date) => {
      respondWithExpiry(BROWSER_NOW + SUPPORT_REPORT_DELIVERY_TTL_MS, date);
      await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
    },
  );
});
