import { describe, expect, it } from "vitest";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  emitGatewayErrorDiagnostic,
  type GatewayErrorDiagnosticDeps,
} from "./gateway-error-diagnostic.js";

function capturingDeps(): {
  readonly deps: GatewayErrorDiagnosticDeps;
  readonly events: ServerDiagnosticRecord[];
} {
  const events: ServerDiagnosticRecord[] = [];
  return {
    events,
    deps: {
      diagnostics: {
        record: (record): void => {
          events.push(record);
        },
      },
      redactor: (value: unknown): unknown => value,
    },
  };
}

describe("emitGatewayErrorDiagnostic", () => {
  it("emits one record through the sink with the given operation/source", () => {
    const { deps, events } = capturingDeps();

    emitGatewayErrorDiagnostic(
      deps,
      new Error("boom"),
      "correlation-9",
      "POST /api/chat",
      "example.source",
    );

    expect(events).toHaveLength(1);
    const [event] = events;
    if (event === undefined) throw new Error("expected a diagnostic record");
    expect(event.correlationId).toBe("correlation-9");
    expect(event.operation).toBe("POST /api/chat");
    expect(event.source).toBe("example.source");
    expect(event.errorClass).toBe("Error");
  });

  it("falls back the correlation id to the fixed unknown-id sentinel when none is known", () => {
    const { deps, events } = capturingDeps();

    emitGatewayErrorDiagnostic(
      deps,
      new Error("boom"),
      undefined,
      "POST /api/chat",
      "example.source",
    );

    expect(events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });

  it("never throws when no diagnostics sink is configured", () => {
    const deps: GatewayErrorDiagnosticDeps = {
      diagnostics: undefined,
      redactor: (value: unknown): unknown => value,
    };

    expect(() => {
      emitGatewayErrorDiagnostic(
        deps,
        new Error("boom"),
        "correlation-1",
        "POST /api/chat",
        "example.source",
      );
    }).not.toThrow();
  });
});
