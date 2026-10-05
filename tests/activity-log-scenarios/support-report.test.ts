// Real mounted report routes, gzip attachments, session authority and analyzer reconstruction.
// Use the built server so its worker URL resolves exactly as it does in the shipped product.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCspHeader,
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  createUiServer,
  UI_HOST,
  type UiHandlerDeps,
} from "@oscharko-dev/keiko-server";
import { analyzeSupportReport, parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { listSupportIncidents } from "@oscharko-dev/keiko-activity-log";
import { clientDefectContext } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../../packages/keiko-server/src/coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../../packages/keiko-server/src/coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "../../packages/keiko-server/src/coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "../../packages/keiko-server/src/coding-app-session/sessionCookie.js";
import {
  closeUiTestServer,
  startUiTestServerWithFactory,
} from "../../packages/keiko-server/src/ui-test-server/_support.js";
import {
  occupySupportIncidentRetentionForTests,
  supportIncidentReservationsForTests,
  resetServerLogger,
} from "../support/activity-log-test-support.js";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

const REPORT_PATH = "/api/diagnostics/report";
const POST_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
const FAILURE_ID = "wire-selected-report-failure";
const CLIENT_FAILURE = {
  errorKind: "timeout",
  context: clientDefectContext({ clientKind: "sse-error" }),
} as const;
interface WireResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: Buffer;
}
interface CreatedReport {
  readonly reportJson: string;
  readonly downloadPath: string;
  readonly fileName: string;
  readonly parsed: ReturnType<typeof parseSupportReport>;
}
let stateDir: string;
let server: Server;
let port: number;
let deps: UiHandlerDeps;
let channel: ReturnType<typeof createCodingAppSessionChannel>;

function handlerDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: { KEIKO_STATE_DIR: stateDir },
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    codingAppSessionChannel: channel,
  };
}

function sessionCookie(): string {
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new TypeError("Test pairing refused");
  return `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
}

async function wire(
  path: string,
  method: "GET" | "POST" = "GET",
  headers: Readonly<Record<string, string>> = {},
  body?: unknown,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: UI_HOST, port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          bytes: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function json(response: WireResponse): Record<string, unknown> {
  const value: unknown = JSON.parse(response.bytes.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Expected HTTP JSON object");
  return value as Record<string, unknown>;
}

function created(response: WireResponse): CreatedReport {
  expect(response.status).toBe(200);
  const value = json(response);
  if (
    typeof value.reportJson !== "string" ||
    typeof value.fileName !== "string" ||
    typeof value.downloadPath !== "string"
  )
    throw new TypeError("Missing HTTP report artifact");
  const parsed = parseSupportReport(value.reportJson);
  expect(value.summary).toMatchObject({ reportDigest: parsed.integrity.reportDigest });
  expect(value.downloadPath).toMatch(/^\/api\/diagnostics\/report\/download\/[a-f0-9-]{36}$/u);
  expect(response.headers["cache-control"]).toBe("no-store");
  return {
    reportJson: value.reportJson,
    fileName: value.fileName,
    downloadPath: value.downloadPath,
    parsed,
  };
}

function expectError(response: WireResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(json(response)).toMatchObject({ error: { code } });
}

function events(op: string): Record<string, unknown>[] {
  return persistedActivityLogLines(readPersistedActivityLog(stateDir), op).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

function verifySavedAttachment(response: WireResponse, report: CreatedReport): void {
  expect(response.status).toBe(200);
  expect(response.headers).toMatchObject({
    "content-type": "application/gzip",
    "content-length": String(response.bytes.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "content-disposition": `attachment; filename="${report.fileName}.gz"`,
  });
  const destination = join(stateDir, `${report.fileName}.gz`);
  writeFileSync(destination, response.bytes, { mode: 0o600 });
  const savedJson = gunzipSync(readFileSync(destination)).toString("utf8");
  expect(savedJson).toBe(report.reportJson);
  expect(parseSupportReport(savedJson)).toEqual(report.parsed);
}

async function postReport(
  correlationId: string,
  body: unknown,
  cookie?: string,
): Promise<WireResponse> {
  return wire(
    REPORT_PATH,
    "POST",
    {
      ...POST_HEADERS,
      "X-Keiko-Correlation-Id": correlationId,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body,
  );
}

async function clientDownload(
  report: CreatedReport,
  parent: string,
  scope: "server" | "client-only",
): Promise<void> {
  const response = await wire("/api/diagnostics/client", "POST", POST_HEADERS, {
    message: "Keiko support report download started.",
    clientTs: new Date().toISOString(),
    correlationId: `${parent}-click`,
    parentCorrelationId: parent,
    supportReportDelivery: {
      mode: "manual",
      source: "server",
      evidenceScope: scope,
      reportDigest: report.parsed.integrity.reportDigest,
    },
  });
  expect(response.status).toBe(204);
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-report-wire-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
  resetServerLogger();
  channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  deps = handlerDeps();
  const started = await startUiTestServerWithFactory(
    { staticRoot: stateDir, csp: buildCspHeader([]), handlerDeps: deps },
    createUiServer,
  );
  server = started.server;
  port = started.port;
});
afterEach(async () => {
  await closeUiTestServer(server);
  deps.store.close();
  resetServerLogger();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("mounted support report wire security", () => {
  it("rejects CSRF, content type, foreign Host and Origin before report creation or delivery", async () => {
    expectError(
      await wire(REPORT_PATH, "POST", { "Content-Type": "application/json" }, {}),
      403,
      "FORBIDDEN_CSRF",
    );
    expectError(
      await wire(REPORT_PATH, "POST", { "X-Keiko-CSRF": "1", "Content-Type": "text/plain" }, {}),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(events("support.report.ui.started")).toEqual([]);
    const report = created(
      await postReport("wire-limited-security", {
        correlationId: FAILURE_ID,
        failure: CLIENT_FAILURE,
      }),
    );
    for (const headers of [{ Host: "foreign.invalid" }, { Origin: "https://foreign.invalid" }]) {
      expectError(
        await wire(REPORT_PATH, "POST", { ...POST_HEADERS, ...headers }, {}),
        403,
        "FORBIDDEN_HOST",
      );
      expectError(await wire(report.downloadPath, "GET", headers), 403, "FORBIDDEN_HOST");
    }
    expect(events("support.report.ui.started")).toHaveLength(1);
    expect(events("support.report.ui.completed")).toHaveLength(1);
    expect(events("support.report.ui.delivered")).toEqual([]);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
    expect(report.parsed.incident.clientReport).toMatchObject({
      availabilityReason: "session-unavailable",
      failure: CLIENT_FAILURE,
    });
    expect(report.parsed.evidence.recordCount).toBe(0);
    verifySavedAttachment(await wire(report.downloadPath), report);
  });
});

async function fullReportJourney(): Promise<CreatedReport> {
  const cookie = sessionCookie();
  const failed = await postReport(
    FAILURE_ID,
    { correlationId: "wire-not-retained-selector" },
    cookie,
  );
  expectError(failed, 503, "SUPPORT_REPORT_SELECTION_UNAVAILABLE");
  expect(failed.headers["x-keiko-correlation-id"]).toBe(FAILURE_ID);
  const report = created(
    await postReport("wire-full-preparation", { correlationId: FAILURE_ID }, cookie),
  );
  expect(report.parsed.incident.trigger).toBe("registered-failure");
  expect(report.parsed.incident.op).toBe("support.report.ui.failed");
  expectError(await wire(report.downloadPath), 403, "DENIED");
  expectError(
    await wire(report.downloadPath, "GET", { Cookie: sessionCookie() }),
    404,
    "NOT_FOUND",
  );
  verifySavedAttachment(
    await wire(report.downloadPath, "GET", {
      Cookie: cookie,
      "X-Keiko-Correlation-Id": "wire-full-download",
    }),
    report,
  );
  verifySavedAttachment(await wire(report.downloadPath, "GET", { Cookie: cookie }), report);
  await clientDownload(report, "wire-full-preparation", "server");
  channel.signOut(cookie.slice(cookie.indexOf("=") + 1));
  expectError(await wire(report.downloadPath, "GET", { Cookie: cookie }), 403, "DENIED");
  return report;
}

async function limitedReportJourney(): Promise<CreatedReport> {
  const report = created(
    await postReport("wire-limited-preparation", {
      correlationId: FAILURE_ID,
      failure: CLIENT_FAILURE,
    }),
  );
  expect(report.parsed.incident.clientReport?.failure).toEqual(CLIENT_FAILURE);
  expect(report.parsed.evidence.recordCount).toBe(0);
  verifySavedAttachment(
    await wire(report.downloadPath, "GET", { "X-Keiko-Correlation-Id": "wire-limited-download" }),
    report,
  );
  await clientDownload(report, "wire-limited-preparation", "client-only");
  return report;
}

function expectDeliveryJoins(full: CreatedReport, limited: CreatedReport): void {
  for (const [report, parent, scope] of [
    [full, "wire-full-preparation", "server"],
    [limited, "wire-limited-preparation", "client-only"],
  ] as const) {
    expect(events("support.report.ui.delivered")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentCorrelationId: parent,
          reportDigest: report.parsed.integrity.reportDigest,
          evidenceScope: scope,
        }),
      ]),
    );
    expect(events("client.support-report.download-started")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentCorrelationId: parent,
          reportDigest: report.parsed.integrity.reportDigest,
          source: "server",
          evidenceScope: scope,
          deliveryMode: "manual",
        }),
      ]),
    );
  }
  const analyzed = analyzeSupportReport(full.reportJson);
  const failure = analyzed.analysis.timelines
    .flatMap((timeline) => timeline.lines)
    .find((line) => line.op === "support.report.ui.failed");
  expect(failure?.extra).toMatchObject({ reason: "selection-unavailable" });
}

describe("Activity Log scenario: support report HTTP delivery", () => {
  it("reconstructs a real failed preparation, paired download and session-free download", async () => {
    const startedAtMs = Date.now();
    const full = await fullReportJourney();
    const limited = await limitedReportJourney();
    expectDeliveryJoins(full, limited);
    const trace = await expectActivityLogScenario("bff.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "support.report.ui.started",
        "support.report.ui.failed",
        "support.report.ui.started",
        "support.report.ui.completed",
        "support.report.ui.download-refused",
        "support.report.ui.delivered",
        "client.support-report.download-started",
        "support.report.ui.started",
        "support.report.ui.completed",
        "support.report.ui.delivered",
        "client.support-report.download-started",
      ],
    });
    expect(trace.failureClasses).toContain("support-report");
  });
});

function expectTransientExportJoins(report: CreatedReport): void {
  const digest = report.parsed.integrity.reportDigest;
  expect(events("support.incident.rejected")).toEqual([
    expect.objectContaining({
      correlationId: FAILURE_ID,
      rejectionReason: "quota-exhausted",
      errorKind: "rate-limited",
      completeness: "partial",
      loss: "event-dropped",
    }),
  ]);
  const completed = events("support.report.ui.completed").at(-1);
  expect(completed).toMatchObject({
    correlationId: "wire-capacity-preparation",
    selectedCorrelationId: FAILURE_ID,
    incidentId: report.parsed.incident.incidentId,
    reportDigest: digest,
    retentionDisposition: "transient",
  });
  // No pin was attempted for a transient descriptor. Do not invent a rejected pin operation.
  expect(completed).not.toHaveProperty("pinDisposition");
  expect(events("support.report.ui.delivered")).toEqual([
    expect.objectContaining({
      correlationId: "wire-capacity-download",
      parentCorrelationId: "wire-capacity-preparation",
      reportDigest: digest,
      evidenceScope: "server",
      deliveryAuthority: "session-bound",
    }),
  ]);
}

describe("mounted support report at candidate capacity", () => {
  it("joins the quota refusal to the actual transient export and downloaded gzip", async () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const cookie = sessionCookie();
    expectError(
      await postReport(FAILURE_ID, { correlationId: "wire-not-retained-selector" }, cookie),
      503,
      "SUPPORT_REPORT_SELECTION_UNAVAILABLE",
    );
    occupySupportIncidentRetentionForTests(stateDir);
    const reservations = supportIncidentReservationsForTests(stateDir);
    const report = created(
      await postReport("wire-capacity-preparation", { correlationId: FAILURE_ID }, cookie),
    );
    expect(report.parsed.incident.trigger).toBe("registered-failure");
    expect(report.parsed.incident.op).toBe("support.report.ui.failed");
    const failure = analyzeSupportReport(report.reportJson)
      .analysis.timelines.flatMap((timeline) => timeline.lines)
      .find((line) => line.op === "support.report.ui.failed");
    expect(failure?.extra).toMatchObject({ reason: "selection-unavailable" });
    verifySavedAttachment(
      await wire(report.downloadPath, "GET", {
        Cookie: cookie,
        "X-Keiko-Correlation-Id": "wire-capacity-download",
      }),
      report,
    );
    expectTransientExportJoins(report);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
    expect(supportIncidentReservationsForTests(stateDir)).toEqual(reservations);
  });
});
