import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CORRELATION_HEADER,
  UNKNOWN_CORRELATION_ID,
  correlationIdOrUnknown,
  isValidCorrelationId,
  newCorrelationId,
  resolveCorrelationId,
} from "./correlation.js";
import { redactLogLabel } from "./observability/index.js";

function request(id: string): IncomingMessage {
  const message = new IncomingMessage(new Socket());
  message.headers[CORRELATION_HEADER] = id;
  return message;
}

describe("canonical request identity remains a fixed point of log privacy", () => {
  it.each([
    "queued-referent-0446-706f10d8-single-initial-A",
    "sk-proj-syntheticSecret123",
    "github_pat_syntheticsecret",
    "ssn_123-45-6789",
  ])("replaces an unsafe shape-valid identity before propagation: %s", (id) => {
    expect(redactLogLabel(id)).not.toBe(id);
    expect(isValidCorrelationId(id)).toBe(false);
    const resolved = resolveCorrelationId(request(id));
    expect(resolved).not.toBe(id);
    expect(isValidCorrelationId(resolved)).toBe(true);
    expect(redactLogLabel(resolved)).toBe(resolved);
    expect(correlationIdOrUnknown(id)).toBe(UNKNOWN_CORRELATION_ID);
  });

  it.each([
    "client-abc_123.def",
    "request-src.file.ts",
    "safe-request-".repeat(7),
    "a1".repeat(32),
    "12345678-abcd-1234-abcd-123456789012",
  ])("retains safe long, digest and UUID identities: %s", (id) => {
    expect(isValidCorrelationId(id)).toBe(true);
    expect(resolveCorrelationId(request(id))).toBe(id);
    expect(correlationIdOrUnknown(id)).toBe(id);
    expect(redactLogLabel(id)).toBe(id);
  });

  it("retains the body-free optional service fallback and fresh UUID producer", () => {
    expect(correlationIdOrUnknown(undefined)).toBe(UNKNOWN_CORRELATION_ID);
    expect(correlationIdOrUnknown("short")).toBe(UNKNOWN_CORRELATION_ID);
    const id = newCorrelationId();
    expect(isValidCorrelationId(id)).toBe(true);
    expect(redactLogLabel(id)).toBe(id);
  });
});
