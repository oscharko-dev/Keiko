import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyzeSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { buildUiHandlerDeps } from "../../packages/keiko-server/src/deps.js";
import { createCodingAppSessionChannel } from "../../packages/keiko-server/src/coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "../../packages/keiko-server/src/coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "../../packages/keiko-server/src/coding-app-session/sessionCookie.js";
import { handleCreateSupportReport } from "../../packages/keiko-server/src/support-report-routes.js";
import {
  runSupportReportJob,
  SupportReportJobError,
} from "../../packages/keiko-server/src/support-report-job.js";
import { ApiError } from "../../packages/keiko-ui/src/lib/api.js";
import {
  createSupportReport,
  supportReportAvailabilityReason,
} from "../../packages/keiko-ui/src/lib/support-report-api.js";
import { prepareLocalSupportReport } from "../../packages/keiko-ui/src/lib/support-report-local.js";

vi.mock("../../packages/keiko-server/src/support-report-job.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runSupportReportJob: vi.fn() };
});

const directories = [];
const dependencies = [];
const nativeFetch = globalThis.fetch;
beforeEach(() => vi.mocked(runSupportReportJob).mockReset());
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const deps of dependencies.splice(0)) await deps.dispose?.();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function pairedDependencies() {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-report-availability-"));
  directories.push(stateDir);
  const registry = createSessionRegistry();
  const mint = registry.mint("local");
  const deps = {
    ...buildUiHandlerDeps({
      configPath: join(stateDir, "missing-config.json"),
      evidenceDir: join(stateDir, "evidence"),
      uiDbPath: join(stateDir, "ui.db"),
      env: { KEIKO_STATE_DIR: stateDir, KEIKO_UI_DATA_DIR: stateDir },
    }),
    codingAppSessionChannel: createCodingAppSessionChannel({ registry }),
  };
  dependencies.push(deps);
  return { deps, cookie: `${APP_SESSION_COOKIE_NAME}=${encodeURIComponent(mint.cookieToken)}` };
}

/** @param {import("../../packages/keiko-server/src/deps.js").UiHandlerDeps} deps
 * @param {string} cookie */
function routeFetch(deps, cookie) {
  return async (input, init) => {
    expect(input).toBe("/api/diagnostics/report");
    expect(init?.method).toBe("POST");
    expect(typeof init?.body).toBe("string");
    const req = new IncomingMessage(new Socket());
    req.headers.cookie = cookie;
    req.push(init?.body);
    req.push(null);
    const result = await handleCreateSupportReport(
      {
        req,
        res: new ServerResponse(req),
        params: {},
        url: new globalThis.URL("http://localhost/api/diagnostics/report"),
        correlationId: "availability-report-request",
      },
      deps,
    );
    return new globalThis.Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "X-Keiko-Correlation-Id": "availability-report-request" },
    });
  };
}

it.each([
  [
    "selection-unavailable",
    "SUPPORT_REPORT_SELECTION_UNAVAILABLE",
    "diagnostic-delivery-unavailable",
  ],
  ["unavailable", "SUPPORT_REPORT_UNAVAILABLE", "service-unavailable"],
])(
  "seals the actual %s route cause into the browser's canonical limited report",
  async (reason, code, availabilityReason) => {
    const { deps, cookie } = pairedDependencies();
    vi.mocked(runSupportReportJob).mockRejectedValueOnce(new SupportReportJobError(reason));
    vi.stubGlobal("fetch", routeFetch(deps, cookie));
    const error = await createSupportReport("original-availability-cause").catch(
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code,
      status: 503,
      correlationId: "availability-report-request",
    });
    expect(runSupportReportJob).toHaveBeenCalledOnce();
    const prepared = await prepareLocalSupportReport(new globalThis.AbortController().signal, {
      correlationId: "original-availability-cause",
      availabilityReason: supportReportAvailabilityReason(error),
    });
    try {
      const response = await nativeFetch(prepared.download.href);
      const bytes = gunzipSync(Buffer.from(await response.arrayBuffer()));
      expect(bytes.toString("utf8")).toBe(prepared.report.reportJson);
      const analyzed = analyzeSupportReport(bytes.toString("utf8"));
      expect(analyzed.incident).toMatchObject({
        correlation: { rootCorrelationId: "original-availability-cause" },
        sufficiencyStatus: "insufficient",
        clientReport: { serverEvidence: "unavailable", availabilityReason },
        lineCount: 0,
      });
      expect(analyzed.reportDigest).toBe(prepared.report.summary?.reportDigest);
      expect(analyzed.analysis.evidence).toMatchObject({ supportedLineCount: 0 });
    } finally {
      prepared.download.dispose();
    }
  },
);
