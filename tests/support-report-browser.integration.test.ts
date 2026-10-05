import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  createClientOnlySupportReport,
  parseSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import type {
  ClientOnlySupportReportInput,
  DesktopSupportReportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

// Load the browser producer through Vitest's bundler; the NodeNext program must not compile UI imports.
interface BrowserProducer {
  readonly prepareLocalSupportReport: (
    signal: AbortSignal,
    context: Pick<ClientOnlySupportReportInput, "correlationId" | "failure">,
  ) => Promise<{
    report: DesktopSupportReportResponse;
    download: { href: string; dispose: () => void };
  }>;
}

afterEach(() => vi.restoreAllMocks());

it.each([undefined, "actual-browser-report-request"])(
  "validates real browser gzip bytes with the canonical reader and producer (%s)",
  async (correlationId) => {
    const { prepareLocalSupportReport } = await vi.importActual<BrowserProducer>(
      "../packages/keiko-ui/src/lib/support-report-local.ts",
    );
    const failure = { errorKind: "timeout", context: [] } as const;
    const prepared = await prepareLocalSupportReport(new AbortController().signal, {
      correlationId,
      failure,
    });
    try {
      const bytes = await (await fetch(prepared.download.href)).arrayBuffer();
      const text = gunzipSync(Buffer.from(bytes)).toString("utf8");
      const actual = parseSupportReport(text);
      const expected = parseSupportReport(
        createClientOnlySupportReport(correlationId, "service-unavailable", failure).reportJson,
      );
      expect(text).toBe(prepared.report.reportJson);
      expect(actual.incident.correlation).toEqual(expected.incident.correlation);
      expect(actual.incident.clientReport).toEqual(expected.incident.clientReport);
      expect(actual.selection).toEqual(expected.selection);
      expect(actual.evidence).toEqual(expected.evidence);
      expect(() => parseSupportReport(text.replace('"timeout"', '"internal"'))).toThrow();
    } finally {
      prepared.download.dispose();
    }
    await expect(fetch(prepared.download.href)).rejects.toThrow();
  },
);
