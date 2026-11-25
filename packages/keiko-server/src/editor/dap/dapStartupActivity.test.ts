import { describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../../tests/support/activity-log-proof.js";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { DapAdapterPreflightError } from "./dapNodeAdapter.js";
import { DapPrivateEndpointError } from "./dapPrivateEndpoint.js";
import { DapProcessManagerError } from "./dapProcessManager.js";
import { DapProtocolError } from "./dapProtocolClient.js";
import {
  debugStartFailureCode,
  debugStartRefusal,
  recordStartRefused,
  recordStartupAttemptFailed,
} from "./dapStartupActivity.js";

function capture(): {
  readonly events: ServerLogEvent[];
  readonly write: (e: ServerLogEvent) => void;
} {
  const events: ServerLogEvent[] = [];
  return { events, write: (event): void => void events.push(event) };
}

function only(events: readonly ServerLogEvent[]): ServerLogEvent {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error("expected one activity-log line");
  return event;
}

describe("debugStartFailureCode", () => {
  it.each([
    { error: new DapProtocolError("REQUEST_TIMEOUT"), code: "REQUEST_TIMEOUT" },
    { error: new DapProcessManagerError("STARTUP_THROTTLED"), code: "STARTUP_THROTTLED" },
    {
      error: new DapPrivateEndpointError("PRIVATE_ENDPOINT_INVALID"),
      code: "PRIVATE_ENDPOINT_INVALID",
    },
    { error: new DapAdapterPreflightError(), code: "EXECUTABLE_NOT_FOUND" },
    { error: Object.assign(new Error("CAPACITY"), { code: "CAPACITY" }), code: "CAPACITY" },
  ])("reads the closed code $code", ({ error, code }) => {
    expect(debugStartFailureCode(error)).toBe(code);
  });

  it.each([
    { label: "an error without a code", error: new Error("boom") },
    { label: "an unknown code", error: Object.assign(new Error("x"), { code: "ENOENT" }) },
    { label: "a non-string code", error: Object.assign(new Error("x"), { code: 7 }) },
    { label: "a plain object with a closed code", error: { code: "CAPACITY" } },
    { label: "a string", error: "STARTUP_THROTTLED" },
    { label: "undefined", error: undefined },
  ])("returns undefined for $label", ({ error }) => {
    expect(debugStartFailureCode(error)).toBeUndefined();
  });
});

describe("debugStartRefusal", () => {
  it.each([
    { code: "STARTUP_THROTTLED", status: 503 },
    { code: "CAPACITY", status: 429 },
    { code: "SESSION_TERMINATING", status: 409 },
    { code: "TERMINATION_PENDING", status: 409 },
    { code: "EVIDENCE_PENDING", status: 409 },
    { code: "SESSION_NOT_FOUND", status: 409 },
    { code: "INVALID_CAPSULE_PLAN", status: 409 },
    { code: "EXECUTABLE_NOT_FOUND", status: 503 },
    { code: "PRIVATE_ENDPOINT_UNSUPPORTED", status: 503 },
    { code: "CLIENT_DISPOSED", status: 503 },
    { code: "REQUEST_TIMEOUT", status: 502 },
    { code: "UNEXPECTED_EOF", status: 502 },
    { code: "PRIVATE_ENDPOINT_INVALID", status: 502 },
  ] as const)("answers $code with $status and a sentence", ({ code, status }) => {
    const refusal = debugStartRefusal(code);

    expect(refusal.status).toBe(status);
    expect(refusal.message).toMatch(/^The |^A |^Debug /u);
  });
});

describe("startup activity lines", () => {
  it("records a failed attempt with its step, closed code and duration", () => {
    const sink = capture();

    recordStartupAttemptFailed(sink, {
      correlationId: "debug-start-7",
      attempt: 2,
      phase: "endpoint-connect",
      error: new DapPrivateEndpointError("PRIVATE_ENDPOINT_INVALID"),
      retry: true,
      durationMs: 9_123.6,
    });

    const line = only(sink.events);
    expect(line).toMatchObject({
      level: "warn",
      op: "dap.debug-session.startup-attempt-failed",
      correlationId: "debug-start-7",
      durationMs: 9_124,
      errorKind: "unsafe-target",
      extra: {
        attempt: 2,
        phase: "endpoint-connect",
        failureCode: "PRIVATE_ENDPOINT_INVALID",
        retry: true,
      },
    });
    expect(
      expectActivityLogProof(
        "dap.debug-session.startup-attempt-failed.line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ phase: "endpoint-connect", failureCode: "PRIVATE_ENDPOINT_INVALID" });
  });

  it("records an unclassified attempt failure as internal and never carries its message", () => {
    const sink = capture();

    recordStartupAttemptFailed(sink, {
      correlationId: "not a valid correlation id",
      attempt: 1,
      phase: "capsule-launch",
      error: new Error("/secret/path/to/workspace"),
      retry: false,
      durationMs: -5,
    });

    const line = only(sink.events);
    expect(line).toMatchObject({
      correlationId: UNKNOWN_CORRELATION_ID,
      durationMs: 0,
      errorKind: "internal",
      extra: { failureCode: "unclassified", phase: "capsule-launch", retry: false },
    });
    expect(JSON.stringify(line)).not.toContain("/secret/path");
  });

  it("records a refused start with its closed reason and status", () => {
    const sink = capture();

    recordStartRefused(sink, "debug-start-8", "CAPACITY", 429);

    expect(only(sink.events)).toMatchObject({
      level: "warn",
      op: "dap.debug-session.start-refused",
      correlationId: "debug-start-8",
      status: 429,
      errorKind: "rate-limited",
      extra: { reason: "CAPACITY" },
    });
  });

  it("writes nothing without a sink", () => {
    expect(() => {
      recordStartRefused(undefined, undefined, "CAPACITY", 429);
      recordStartupAttemptFailed(undefined, {
        correlationId: undefined,
        attempt: 1,
        phase: "initialize",
        error: undefined,
        retry: false,
        durationMs: 1,
      });
    }).not.toThrow();
  });
});
