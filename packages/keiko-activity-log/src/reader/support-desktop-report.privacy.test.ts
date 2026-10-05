import { mkdtempSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogEvent,
  ACTIVITY_LOG_OPERATION_REGISTRY,
  SUPPORT_INCIDENT_UNATTRIBUTED,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { readPersistedActivityLog } from "../../../../tests/support/activity-log-proof.js";
import { createFileServerLogSink, closeFileServerLogSinks } from "../server-log.js";
import type { ServerLogSink } from "../server-log.js";
import { createServerLogger, resetServerLogger, setServerLogger } from "../server-logger.js";
import { causeChain, keikoStackFrames } from "../stack-frames.js";
import {
  configureActivityLogRouteRedactor,
  resetActivityLogRouteRedactor,
} from "../log-redaction.js";
import { createInitialToolCatalog } from "../../../keiko-tool-catalog/src/legacy.js";
import { emitToolLifecycleEvent } from "../../../keiko-server/src/tool-catalog/catalogToolLifecycle.js";
import { computeDefectFingerprint } from "../defect-fingerprint.js";
import { recordRegisteredFailureIncident } from "../support-incident.js";
import { createDesktopSupportReport } from "./support-desktop-report.js";
import { analyzeSupportReport, parseSupportReport } from "./support-report.js";
import { logTaskWorkspaceManifestReconnected } from "../../../keiko-server/src/deps-activity.js";
import { logChatResponseMessage } from "../../../keiko-server/src/chat-activity.js";
import {
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "../../../keiko-server/src/client-diagnostics-routes.js";
import {
  redactRoutePath,
  ROUTE_TEMPLATE_REDACTOR_ID,
} from "../../../keiko-server/src/observability/route-template.js";
import {
  defaultServerDiagnosticSink,
  serverDiagnosticFromError,
} from "../../../keiko-server/src/diagnostics-log.js";
import type { RouteContext } from "../../../keiko-server/src/routes.js";

// Join the real package writer instance used by source-reader and server production modules.
// Event producers, registration, redaction, file persistence and report encoding stay real.
vi.mock("@oscharko-dev/keiko-activity-log", async () => import("../index.js"));

const ROOT_ID = "TenantBudgetQ4.xlsx";
const PARENT_ID = "CustomerNotebook.docx";
const WORKSPACE_ID = "ClientAcmePayroll.xlsx";
const REPOSITORY_PATH = "/Users/PrivacyCanary/ClientAcme/Payroll";
const CHAT_BODY = "Private customer chat discusses confidential salary adjustments.";
const FILE_BODY = "Private file contains unreleased customer acquisition details.";
const EMAIL = "privacy-canary@example.invalid";
const SECRET = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const PRIVATE_FRAME = "packages/keiko-server/src/ClientAcmePayroll.ts:12:3";
const PRIVATE_VERSION = "v24.18.0-ClientAcmePayroll";
const PRIVATE_SCHEMA = "ClientAcmePayrollSchema";
const PRIVATE_BUILD = "ClientAcmePayrollBuild";
class ClientAcmePayrollError extends Error {}
const PRIVATE_VALUES = [
  ROOT_ID,
  PARENT_ID,
  WORKSPACE_ID,
  REPOSITORY_PATH,
  CHAT_BODY,
  FILE_BODY,
  EMAIL,
  SECRET,
  PRIVATE_SCHEMA,
  PRIVATE_BUILD,
];
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-support-privacy-"));
  configureActivityLogRouteRedactor(ROUTE_TEMPLATE_REDACTOR_ID, redactRoutePath);
  resetClientDiagnosticsIngestStateForTests();
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  resetServerLogger();
  closeFileServerLogSinks();
  resetActivityLogRouteRedactor();
  resetClientDiagnosticsIngestStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

function context(body: unknown): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(body));
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/diagnostics/client"),
    correlationId: PARENT_ID,
  };
}

function privateError(): Error {
  const inner = new RangeError(CHAT_BODY);
  const cause = new TypeError(`${EMAIL} ${SECRET}`, { cause: inner });
  const error = new Error(`${REPOSITORY_PATH} ${FILE_BODY}`, { cause });
  error.stack = [
    error.message,
    `    at readFile (${REPOSITORY_PATH}/packages/keiko-server/src/files.ts:124:7)`,
    `    at foreign (${REPOSITORY_PATH}/customer-private.js:1:2)`,
    "    at request (node:internal/process/task_queues:95:5)",
  ].join("\n");
  return error;
}

function configurePrivateLogger(sink: ServerLogSink): void {
  setServerLogger(
    createServerLogger({ sink, level: "debug" }).child({
      prompt: CHAT_BODY,
      body: FILE_BODY,
      path: REPOSITORY_PATH,
      apiKey: SECRET,
      email: EMAIL,
      schemaVersion: PRIVATE_SCHEMA,
      schemaDigest: PRIVATE_SCHEMA,
      buildClass: PRIVATE_BUILD,
      platformClass: PRIVATE_BUILD,
    }),
  );
}

async function emitClientFailure(message: string, error: Error): Promise<void> {
  const response = await handleClientDiagnosticIngest(
    context({
      message,
      clientTs: new Date().toISOString(),
      kind: "other",
      correlationId: ROOT_ID,
      parentCorrelationId: PARENT_ID,
      errorKind: "internal",
      errorEvidence: {
        errorClass: "Error",
        frames: [],
        causeChain: causeChain(error),
      },
    }),
  );
  expect(response.status).toBe(204);
}

async function emitPrivateFailure(): Promise<readonly string[]> {
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  configurePrivateLogger(sink);
  logTaskWorkspaceManifestReconnected(sink, ROOT_ID, WORKSPACE_ID);
  logChatResponseMessage(ROOT_ID, PARENT_ID);
  const error = privateError();
  const frames = keikoStackFrames(error);
  expect(frames).toHaveLength(1);
  defaultServerDiagnosticSink.record(
    serverDiagnosticFromError({
      operation: "files.read",
      source: "files",
      correlationId: ROOT_ID,
      error,
      redact: (message: string): string => message,
    }),
  );
  for (const message of [REPOSITORY_PATH, CHAT_BODY, FILE_BODY, EMAIL, SECRET])
    await emitClientFailure(message, error);
  sink.close?.();
  return frames;
}

function emitUnsafeTechnicalLabels(): void {
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  logTaskWorkspaceManifestReconnected(sink, ROOT_ID, WORKSPACE_ID);
  const operation = ACTIVITY_LOG_OPERATION_REGISTRY.find((entry) => entry.op === "process.started");
  if (operation === undefined) throw new TypeError("missing registered process producer");
  sink.write(
    activityLogEvent(
      operation,
      { correlationId: ROOT_ID },
      {
        nodeVersion: PRIVATE_VERSION,
        platform: "linux",
        arch: "x64",
        host: "127.0.0.1",
        port: 1983,
        stateDirSource: "default",
        logLevel: "debug",
      },
    ),
  );
  const error = new ClientAcmePayrollError(FILE_BODY, {
    cause: new ClientAcmePayrollError(CHAT_BODY),
  });
  error.stack = `${error.message}\n    at readFile (${REPOSITORY_PATH}/${PRIVATE_FRAME})`;
  defaultServerDiagnosticSink.record(
    serverDiagnosticFromError({
      operation: "files.read",
      source: "files",
      correlationId: ROOT_ID,
      error,
      redact: (message: string): string => message,
    }),
  );
  sink.close?.();
}

function emitCodeOwnedTool(): string {
  const catalog = createInitialToolCatalog();
  const descriptor = catalog.descriptors.find(
    (entry) => entry.toolRef.canonicalId === "keiko.file.read",
  );
  const profile = catalog.profiles[0]?.profile;
  if (descriptor === undefined || profile === undefined)
    throw new TypeError("missing native catalog fixture");
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  emitToolLifecycleEvent(
    { primary: sink, diagnostics: defaultServerDiagnosticSink },
    {
      op: "tool-catalog.invocation-started",
      correlationId: ROOT_ID,
      catalogRevision: catalog.catalogRevision,
      profile,
      projectionDigest: "a".repeat(64),
      invocationId: "CustomerToolInvocation",
      toolRef: descriptor.toolRef,
      state: "started",
      reason: "none",
      reservationId: "CustomerToolReservation",
    },
  );
  sink.close?.();
  return descriptor.toolRef.canonicalId;
}

function expectPersistedPrivateRedaction(): void {
  const persisted = readPersistedActivityLog(stateDir);
  expect(persisted).toContain(WORKSPACE_ID);
  expect(persisted).toContain('"op":"client.diagnostic"');
  for (const value of [
    REPOSITORY_PATH,
    CHAT_BODY,
    FILE_BODY,
    EMAIL,
    SECRET,
    PRIVATE_SCHEMA,
    PRIVATE_BUILD,
  ])
    expect(persisted).not.toContain(value);
}

function inflateEvidence(report: ReturnType<typeof parseSupportReport>): string {
  expect(report.evidence.encoding).toBe("deflate-base64");
  return inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
}

function expectPrivateEvidenceRemoved(
  reportJson: string,
  extracted: string,
  additionalCanaries: readonly string[] = [],
): void {
  for (const value of [...PRIVATE_VALUES, ...additionalCanaries, stateDir]) {
    expect(reportJson).not.toContain(value);
    expect(extracted).not.toContain(value);
  }
}

describe("desktop report privacy through real producers and compressed evidence", () => {
  it("removes customer labels and content after decompression while preserving useful causality", async () => {
    const frames = await emitPrivateFailure();
    expectPersistedPrivateRedaction();
    const response = createDesktopSupportReport(stateDir, ROOT_ID);
    const report = parseSupportReport(response.reportJson);
    const extracted = inflateEvidence(report);
    expectPrivateEvidenceRemoved(response.reportJson, extracted);
    const analyzed = analyzeSupportReport(response.reportJson);
    const lines = analyzed.analysis.timelines.flatMap((timeline) =>
      timeline.lines.map((line) => ({ ...line, correlationId: timeline.correlationId })),
    );
    const failure = lines.find((line) => line.op === "server.diagnostic.failure");
    expect(failure?.frames).toEqual(frames);
    expect(extracted).toContain('"causeChain":["TypeError","RangeError"]');
    const chat = lines.find((line) => line.op === "chat.response.message");
    expect(failure?.correlationId).toBe(report.incident.correlation.rootCorrelationId);
    expect(chat?.correlationId).toBe(failure?.correlationId);
    expect(chat?.parentCorrelationId).toBeDefined();
    expect(chat?.parentCorrelationId).not.toBe(chat?.correlationId);
    expect(lines.some((line) => line.correlationId === chat?.parentCorrelationId)).toBe(true);
    expect(analyzed.selection.status).toBe("complete");
    expect(report.evidence.recordCount).toBeGreaterThan(5);
  });

  it("refuses shape-safe customer labels masquerading as technical provenance", () => {
    emitUnsafeTechnicalLabels();
    const persisted = readPersistedActivityLog(stateDir);
    for (const value of [PRIVATE_FRAME, PRIVATE_VERSION, ClientAcmePayrollError.name])
      expect(persisted).toContain(value);
    const response = createDesktopSupportReport(stateDir, ROOT_ID);
    const report = parseSupportReport(response.reportJson);
    const extracted = inflateEvidence(report);
    expectPrivateEvidenceRemoved(response.reportJson, extracted, [
      PRIVATE_FRAME,
      PRIVATE_VERSION,
      ClientAcmePayrollError.name,
    ]);
    const analyzed = analyzeSupportReport(response.reportJson);
    // ADR-0173: manual attribution never fingerprints a frame that privacy cannot export.
    // Its redacted failing line remains useful, but the unknown site is explicitly degraded.
    expect(report.incident).toMatchObject({
      trigger: "user-report",
      op: SUPPORT_INCIDENT_UNATTRIBUTED,
      frameCount: 0,
      defectFingerprint: computeDefectFingerprint(UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT),
    });
    const failure = analyzed.analysis.timelines
      .flatMap((timeline) => timeline.lines)
      .find((line) => line.op === "server.diagnostic.failure");
    expect(failure).toMatchObject({ op: "server.diagnostic.failure", errorKind: "internal" });
    expect(failure?.frames).toBeUndefined();
    expect(extracted).toContain('"causeChain":["Error"]');
    expect(analyzed.selection.status).toBe("degraded");
    expect(analyzed.selection.reasons).toContain("evidence-partial");
    expect(report.selection.status).toBe("degraded");
    expect(report.selection.reasons).toContain("evidence-partial");
    expect(report.selection.reasons).not.toContain("unsupported-evidence");
  });
  it("marks an immutable registered failure lost when its private frame cannot be exported", () => {
    emitUnsafeTechnicalLabels();
    const incident = recordRegisteredFailureIncident(stateDir, {
      op: "server.diagnostic.failure",
      errorKind: "internal",
      correlationId: ROOT_ID,
      frames: [PRIVATE_FRAME],
    });
    expect(incident?.status).toBe("created");
    const response = createDesktopSupportReport(stateDir, ROOT_ID);
    const report = parseSupportReport(response.reportJson);
    const extracted = inflateEvidence(report);
    expectPrivateEvidenceRemoved(response.reportJson, extracted, [
      PRIVATE_FRAME,
      PRIVATE_VERSION,
      ClientAcmePayrollError.name,
    ]);
    expect(report.incident).toMatchObject({ trigger: "registered-failure", frameCount: 1 });
    const analyzed = analyzeSupportReport(response.reportJson);
    expect(
      analyzed.analysis.timelines
        .flatMap((timeline) => timeline.lines)
        .some((line) => line.op === "server.diagnostic.failure"),
    ).toBe(false);
    expect(analyzed.selection.status).toBe("insufficient");
    expect(analyzed.selection.reasons).toContain("no-registered-failure");
    expect(analyzed.selection.reasons).toContain("evidence-not-retained");
    expect(report.selection.status).toBe("insufficient");
    expect(report.selection.reasons).toContain("evidence-not-retained");
    expect(report.selection.reasons).not.toContain("unsupported-evidence");
  });
  it("keeps native tool identities but hides invocation labels and preserves writer redaction markers", async () => {
    const canonicalId = emitCodeOwnedTool();
    await emitPrivateFailure();
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    const operation = ACTIVITY_LOG_OPERATION_REGISTRY.find(
      (entry) => entry.op === "gateway.chat.started",
    );
    if (operation === undefined) throw new TypeError("missing model lifecycle operation");
    for (const modelId of ["[redacted:path]", "[redacted:secret]"])
      sink.write(
        activityLogEvent(
          operation,
          { correlationId: ROOT_ID },
          {
            modelId,
            streaming: false,
            costClass: "low",
            timeoutMs: 100,
            maxRetries: 0,
            requestBudgetMs: 100,
            upstreamStreaming: false,
          },
        ),
      );
    sink.close?.();
    const report = parseSupportReport(createDesktopSupportReport(stateDir, ROOT_ID).reportJson);
    const decoded = inflateEvidence(report);
    expect(decoded).toContain(JSON.stringify(canonicalId));
    expect(decoded).toContain('"profileId":"legacy-native"');
    expect(decoded).not.toContain("CustomerToolInvocation");
    expect(decoded).not.toContain("CustomerToolReservation");
    expect(decoded).toContain('"modelId":"[redacted:path]"');
    expect(decoded).toContain('"modelId":"[redacted:secret]"');
  });
});
