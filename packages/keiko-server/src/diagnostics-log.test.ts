// Unit tests for the RB-6 operator diagnostics sink and correlation-id resolver.
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  describeError,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticRecord,
} from "./diagnostics-log.js";
import {
  CORRELATION_HEADER,
  isValidCorrelationId,
  newCorrelationId,
  resolveCorrelationId,
} from "./correlation.js";

const identity = (message: string): string => message;

describe("describeError (RB-6)", () => {
  it("extracts class + message from an Error and applies the redactor", () => {
    const described = describeError(new TypeError("bad value"), (m) =>
      m.replace("bad", "[redacted]"),
    );
    expect(described.errorClass).toBe("TypeError");
    expect(described.message).toBe("[redacted] value");
  });

  it("captures a machine code and a gateway requestId when present", () => {
    const error = Object.assign(new Error("gateway blew up"), {
      code: "GATEWAY_TRANSPORT",
      requestId: "gw-req-42",
    });
    const described = describeError(error, identity);
    expect(described.code).toBe("GATEWAY_TRANSPORT");
    expect(described.gatewayRequestId).toBe("gw-req-42");
  });

  it("handles a non-Error throw without crashing", () => {
    const described = describeError("just a string", identity);
    expect(described.errorClass).toBe("string");
    expect(described.message).toBe("just a string");
    expect(described.code).toBeUndefined();
  });
});

describe("emitServerDiagnostic (RB-6)", () => {
  it("routes the record to the provided sink", () => {
    const records: ServerDiagnosticRecord[] = [];
    const record = serverDiagnosticFromError({
      correlationId: "cid-1",
      operation: "GET /api/x",
      source: "unit",
      error: new Error("nope"),
      redact: identity,
      now: () => 0,
    });
    emitServerDiagnostic(
      {
        record: (r) => {
          records.push(r);
        },
      },
      record,
    );
    expect(records).toHaveLength(1);
    const [captured] = records;
    expect(captured?.correlationId).toBe("cid-1");
    expect(captured?.timestamp).toBe("1970-01-01T00:00:00.000Z");
  });

  it("never throws when the sink itself throws", () => {
    const record = serverDiagnosticFromError({
      correlationId: "cid-2",
      operation: "op",
      source: "unit",
      error: new Error("x"),
      redact: identity,
    });
    const brokenSink = {
      record: (): void => {
        throw new Error("sink is broken");
      },
    };
    expect(() => {
      emitServerDiagnostic(brokenSink, record);
    }).not.toThrow();
  });
});

describe("resolveCorrelationId (RB-6)", () => {
  function req(headerValue: string | undefined): IncomingMessage {
    return {
      headers: headerValue === undefined ? {} : { [CORRELATION_HEADER]: headerValue },
    } as unknown as IncomingMessage;
  }

  it("mints a fresh UUID when no header is present", () => {
    const id = resolveCorrelationId(req(undefined));
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it("reuses a well-formed client-supplied id", () => {
    const id = resolveCorrelationId(req("client-abc_123.def"));
    expect(id).toBe("client-abc_123.def");
  });

  it("rejects an unsafe client id (spaces, CRLF, too short/long) and mints one", () => {
    for (const bad of ["short", "has space", "line\nbreak", "x".repeat(200)]) {
      const id = resolveCorrelationId(req(bad));
      expect(id).not.toBe(bad);
      expect(isValidCorrelationId(id)).toBe(true);
    }
  });

  it("newCorrelationId returns distinct, valid ids", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(isValidCorrelationId(a)).toBe(true);
  });
});
