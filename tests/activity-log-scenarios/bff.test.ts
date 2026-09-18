// Activity Log scenario matrix (#3532): the bff surface — the keiko-server HTTP/BFF layer (the
// `request` close line, the bounded request-body reader, chat admission and PR-description turn
// authority, and the server diagnostic sink).
//
// Each scenario drives a production entry point of this surface with the real production file
// writer under a temporary KEIKO_STATE_DIR and reconstructs the persisted log through
// `keiko support analyze` to a complete report (tests/support/activity-log-scenario.ts).

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  logChatCreationRejectionEvent,
  logChatRejectionEvent,
  logGitChangeTurnAuthorityEvent,
} from "../../packages/keiko-server/src/chat-activity.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "../../packages/keiko-server/src/diagnostics-log.js";
import {
  readBoundedRequestBody,
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
} from "../../packages/keiko-server/src/bounded-request-body.js";
import { resetServerLogger } from "../../packages/keiko-server/src/observability/index.js";
import { processServerLogSink } from "../../packages/keiko-server/src/process-log-sink.js";
import { logRequestOnClose } from "../../packages/keiko-server/src/server.js";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

function parseLine(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "") as Record<string, unknown>;
}

// -- bff.crash: the bounded request-body reader (bounded-request-body.ts) ------------------------

const RECEIVED_BODY = '{"ok":true}';
const REJECTED_MAX_BYTES = 4;
const REJECTED_PAYLOAD = "12345";

function asRequest(stream: PassThrough): IncomingMessage {
  return stream as unknown as IncomingMessage;
}

async function driveReceivedBody(correlationId: string): Promise<void> {
  const stream = new PassThrough();
  const outcome = readBoundedRequestBody(asRequest(stream), 64_000, undefined, correlationId);
  stream.write(Buffer.from(RECEIVED_BODY));
  stream.end();
  await expect(outcome).resolves.toBe(RECEIVED_BODY);
}

async function driveRejectedBody(correlationId: string): Promise<void> {
  const stream = new PassThrough();
  const outcome = readBoundedRequestBody(
    asRequest(stream),
    REJECTED_MAX_BYTES,
    undefined,
    correlationId,
  );
  stream.write(Buffer.from(REJECTED_PAYLOAD));
  await expect(outcome).rejects.toBeInstanceOf(RequestBodyTooLargeError);
}

async function driveCancelledBody(correlationId: string): Promise<void> {
  const stream = new PassThrough();
  const outcome = readBoundedRequestBody(asRequest(stream), 64_000, undefined, correlationId);
  stream.destroy();
  await expect(outcome).rejects.toBeInstanceOf(RequestBodyCancelledError);
}

async function driveFailedBody(correlationId: string): Promise<void> {
  const stream = new PassThrough();
  const outcome = readBoundedRequestBody(asRequest(stream), 64_000, undefined, correlationId);
  stream.emit("error", new TypeError("simulated dependency socket failure"));
  await expect(outcome).rejects.toThrow();
}

interface HttpRequestBodyScenarioIds {
  readonly received: string;
  readonly rejected: string;
  readonly cancelled: string;
  readonly failed: string;
}

function expectHttpRequestBodyEvidence(stateDir: string, ids: HttpRequestBodyScenarioIds): void {
  const text = readPersistedActivityLog(stateDir);

  const received = persistedActivityLogLines(text, "http.request.body.received");
  expect(received).toHaveLength(1);
  expect(parseLine(received[0])).toMatchObject({
    correlationId: ids.received,
    contentType: "unspecified",
    receivedBytes: Buffer.byteLength(RECEIVED_BODY, "utf8"),
  });

  const rejected = persistedActivityLogLines(text, "http.request.body.rejected");
  expect(rejected).toHaveLength(1);
  expect(parseLine(rejected[0])).toMatchObject({
    correlationId: ids.rejected,
    errorKind: "invalid-request",
    reason: "limit-exceeded",
    maxBytes: REJECTED_MAX_BYTES,
    receivedBytes: Buffer.byteLength(REJECTED_PAYLOAD, "utf8"),
  });

  const cancelled = persistedActivityLogLines(text, "http.request.body.cancelled");
  expect(cancelled).toHaveLength(1);
  expect(parseLine(cancelled[0])).toMatchObject({
    correlationId: ids.cancelled,
    errorKind: "cancelled",
    receivedBytes: 0,
  });

  const failed = persistedActivityLogLines(text, "http.request.body.failed");
  expect(failed).toHaveLength(1);
  const failedRecord = parseLine(failed[0]);
  expect(failedRecord).toMatchObject({
    correlationId: ids.failed,
    errorKind: "internal",
    receivedBytes: 0,
  });
  expect(typeof failedRecord.failureKind).toBe("string");
}

// -- bff.dependency-failure: the server diagnostic sink and the request close line ---------------

interface HttpRequestDouble extends EventEmitter {
  complete: boolean;
  destroyed: boolean;
  url?: string;
  method?: string;
  socket: { bytesWritten: number };
}

interface HttpResponseDouble extends EventEmitter {
  closed: boolean;
  destroyed: boolean;
  writableEnded: boolean;
  headersSent: boolean;
  statusCode: number;
}

function httpRequestDoubles(): {
  readonly req: HttpRequestDouble;
  readonly res: HttpResponseDouble;
} {
  const req = Object.assign(new EventEmitter(), {
    complete: true,
    destroyed: false,
    url: "/api/chat/stream",
    method: "POST",
    socket: { bytesWritten: 0 },
  });
  const res = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    writableEnded: true,
    headersSent: true,
    statusCode: 502,
  });
  return { req, res };
}

// The request's own collaborator (the model gateway) fails while the handler is in flight, then the
// response closes with the SAME correlation id — proving the two lines trace back to one request.
function driveDependencyFailureRequest(correlationId: string): void {
  const record = serverDiagnosticFromError({
    correlationId,
    operation: "chat.stream",
    source: "model-gateway.chat",
    error: new TypeError("simulated model-gateway dependency failure"),
    redact: (message) => message,
  });
  emitServerDiagnostic(undefined, record);

  const { req, res } = httpRequestDoubles();
  logRequestOnClose(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    correlationId,
    processServerLogSink(),
    {},
  );
  req.socket.bytesWritten = 128;
  res.emit("close");
}

function driveSecondCollaboratorFailure(correlationId: string): void {
  const record = serverDiagnosticFromError({
    correlationId,
    operation: "local-knowledge.capsule",
    source: "local-knowledge.store",
    error: new RangeError("simulated local-knowledge dependency failure"),
    redact: (message) => message,
  });
  emitServerDiagnostic(undefined, record);
}

function expectDependencyFailureEvidence(
  stateDir: string,
  requestCorrelationId: string,
  secondCorrelationId: string,
): void {
  const text = readPersistedActivityLog(stateDir);

  const diagnostics = persistedActivityLogLines(text, "server.diagnostic.failure");
  expect(diagnostics).toHaveLength(2);
  expect(parseLine(diagnostics[0])).toMatchObject({
    correlationId: requestCorrelationId,
    errorKind: "internal",
    diagnosticErrorClass: "TypeError",
    source: "model-gateway.chat",
  });
  expect(parseLine(diagnostics[1])).toMatchObject({
    correlationId: secondCorrelationId,
    diagnosticErrorClass: "RangeError",
    source: "local-knowledge.store",
  });

  const requests = persistedActivityLogLines(text, "request");
  expect(requests).toHaveLength(1);
  expect(parseLine(requests[0])).toMatchObject({
    correlationId: requestCorrelationId,
    method: "POST",
    aborted: false,
    status: 502,
    responseBytes: 128,
  });
}

// -- bff.rejection: chat admission and PR-description turn authority (chat-activity.ts) ----------

function driveRejectedChatCreation(correlationId: string): void {
  logChatCreationRejectionEvent({
    correlationId,
    status: 503,
    reason: "readiness",
    modelKind: "unknown",
  });
}

function driveRejectedChatSend(correlationId: string): void {
  logChatRejectionEvent("chat.send.rejected", {
    correlationId,
    status: 422,
    reason: "grounding-scope",
    modelKind: "chat",
  });
}

function driveDeniedPrDescriptionTurn(correlationId: string, relationshipId: string): void {
  logGitChangeTurnAuthorityEvent(
    correlationId,
    { admitted: false, reason: "authority-expired" },
    relationshipId,
  );
}

interface ChatRejectionScenarioIds {
  readonly creation: string;
  readonly send: string;
  readonly turn: string;
}

function expectRejectionEvidence(
  stateDir: string,
  ids: ChatRejectionScenarioIds,
  relationshipId: string,
): void {
  const text = readPersistedActivityLog(stateDir);

  const creation = persistedActivityLogLines(text, "chat.creation.rejected");
  expect(creation).toHaveLength(1);
  expect(parseLine(creation[0])).toMatchObject({
    correlationId: ids.creation,
    errorKind: "unavailable",
    reason: "readiness",
    modelKind: "unknown",
  });

  const send = persistedActivityLogLines(text, "chat.send.rejected");
  expect(send).toHaveLength(1);
  expect(parseLine(send[0])).toMatchObject({
    correlationId: ids.send,
    errorKind: "invalid-request",
    reason: "grounding-scope",
    modelKind: "chat",
  });

  const turn = persistedActivityLogLines(text, "pr-description.chat.turn.denied");
  expect(turn).toHaveLength(1);
  expect(parseLine(turn[0])).toMatchObject({
    correlationId: ids.turn,
    errorKind: "validation-failed",
    reason: "authority-expired",
    relationshipId,
  });
}

describe("Activity Log scenario: bff", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-bff-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("drives a bounded request body through overflow, cancellation and a stream failure to a complete crash record", async () => {
    const startedAtMs = Date.now();
    const ids: HttpRequestBodyScenarioIds = {
      received: "bff-crash-received",
      rejected: "bff-crash-rejected",
      cancelled: "bff-crash-cancelled",
      failed: "bff-crash-failed",
    };

    await driveReceivedBody(ids.received);
    await driveRejectedBody(ids.rejected);
    await driveCancelledBody(ids.cancelled);
    await driveFailedBody(ids.failed);

    const trace = expectActivityLogScenario("bff.crash", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "http.request.body.received",
        "http.request.body.rejected",
        "http.request.body.cancelled",
        "http.request.body.failed",
      ],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["http-request-body"]));
    expectHttpRequestBodyEvidence(stateDir, ids);
  });

  it("drives a request's collaborator failure and its close line to a complete dependency-failure record", () => {
    const startedAtMs = Date.now();
    const requestCorrelationId = "bff-dependency-failure-request";
    const secondCorrelationId = "bff-dependency-failure-knowledge";

    driveDependencyFailureRequest(requestCorrelationId);
    driveSecondCollaboratorFailure(secondCorrelationId);

    const trace = expectActivityLogScenario("bff.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["server.diagnostic.failure", "request"],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["server-diagnostic", "http-request"]),
    );
    expectDependencyFailureEvidence(stateDir, requestCorrelationId, secondCorrelationId);
  });

  it("drives chat admission and PR-description turn authority rejections to a complete rejection record", () => {
    const startedAtMs = Date.now();
    const ids: ChatRejectionScenarioIds = {
      creation: "bff-rejection-creation",
      send: "bff-rejection-send",
      turn: "bff-rejection-turn",
    };
    const relationshipId = "bff-rejection-relationship";

    driveRejectedChatCreation(ids.creation);
    driveRejectedChatSend(ids.send);
    driveDeniedPrDescriptionTurn(ids.turn, relationshipId);

    const trace = expectActivityLogScenario("bff.rejection", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "chat.creation.rejected",
        "chat.send.rejected",
        "pr-description.chat.turn.denied",
      ],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["chat-admission", "pr-description-chat-authority"]),
    );
    expectRejectionEvidence(stateDir, ids, relationshipId);
  });
});
