import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ServerDiagnosticSink } from "../diagnostics-log.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import { emitToolLifecycleEvent, validateToolLifecycleEvent } from "./catalogToolLifecycle.js";

interface Fixture {
  readonly phase: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
const generated = JSON.parse(
  readFileSync(
    new URL("../../../../docs/observability/tool-catalog-operations.v1.json", import.meta.url),
    "utf8",
  ),
) as { readonly fixtures: readonly Fixture[]; readonly terminalFixtures: readonly Fixture[] };
function phase(name: string): Readonly<Record<string, unknown>> {
  const fixture = generated.fixtures.find((item) => item.phase === name);
  if (fixture === undefined) throw new Error("Missing generated phase");
  return fixture.evidence;
}
function sinks(): {
  readonly primary: ReturnType<typeof createBufferedServerLogSink>;
  readonly auxiliary: ReturnType<typeof createBufferedServerLogSink>;
  readonly diagnostics: {
    readonly record: ReturnType<typeof vi.fn<ServerDiagnosticSink["record"]>>;
  };
} {
  return {
    primary: createBufferedServerLogSink(),
    auxiliary: createBufferedServerLogSink(),
    diagnostics: { record: vi.fn<ServerDiagnosticSink["record"]>() },
  };
}

describe("closed runtime lifecycle emission", () => {
  it.each([...generated.fixtures, ...generated.terminalFixtures])(
    "emits the generated $phase fixture through actual existing sink formatting",
    (fixture) => {
      const port = sinks();
      const validated = validateToolLifecycleEvent(fixture.evidence);
      expect(validated).not.toBe(fixture.evidence);
      expect(Object.isFrozen(validated)).toBe(true);
      emitToolLifecycleEvent(port, fixture.evidence);
      expect(port.primary.events).toHaveLength(1);
      expect(port.auxiliary.events).toHaveLength(1);
      expect(port.primary.events[0]).toMatchObject({
        op: fixture.evidence.op,
        correlationId: fixture.evidence.correlationId,
        category: "security",
      });
      const line: unknown = JSON.parse(port.primary.lines()[0] ?? "{}");
      expect(line).toMatchObject({
        op: fixture.evidence.op,
        correlationId: fixture.evidence.correlationId,
      });
      if (fixture.evidence.status !== undefined)
        expect(line).toMatchObject({
          status: fixture.evidence.status,
          reason: fixture.evidence.reason,
        });
      expect(port.diagnostics.record).not.toHaveBeenCalled();
    },
  );
  it("rejects every forbidden body field before either sink sees it", () => {
    const port = sinks();
    for (const fixture of [...generated.fixtures, ...generated.terminalFixtures]) {
      for (const field of [
        "arguments",
        "path",
        "query",
        "snippet",
        "schema",
        "output",
        "prompt",
        "credentials",
        "endpoint",
        "message",
      ])
        expect(() => {
          emitToolLifecycleEvent(port, { ...fixture.evidence, [field]: "private-body" });
        }).toThrow("Invalid tool lifecycle evidence");
    }
    expect(port.primary.events).toEqual([]);
    expect(port.auxiliary.events).toEqual([]);
  });
  it("does not execute getters or admit nested body fields", () => {
    const source = { ...phase("projection") };
    const getter = vi.fn(() => "private-body");
    Object.defineProperty(source, "readiness", { enumerable: true, get: getter });
    expect(() => validateToolLifecycleEvent(source)).toThrow("Invalid tool lifecycle evidence");
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      validateToolLifecycleEvent({
        ...phase("projection"),
        profile: { id: "fixture", version: 1, path: "private-body" },
      }),
    ).toThrow();
  });
  it.each([
    { op: "tool-catalog.unknown" },
    { correlationId: "private/path" },
    { catalogRevision: "bad" },
    { profile: { id: "private/profile", version: 1 } },
    { projectionDigest: null },
    { readiness: "unknown" },
    { resultCount: -1 },
    { resultCount: 1001 },
    { resultCount: Number.NaN },
    { status: "completed" },
    { invocationId: "invented" },
  ])("rejects invalid projection shapes %#", (change) => {
    expect(() => validateToolLifecycleEvent({ ...phase("projection"), ...change })).toThrow(
      "Invalid tool lifecycle evidence",
    );
  });
  it("rejects missing required fields and phase contradictions", () => {
    for (const fixture of generated.fixtures) {
      for (const key of Object.keys(fixture.evidence)) {
        const missing = Object.fromEntries(
          Object.entries(fixture.evidence).filter(([field]) => field !== key),
        );
        expect(() => validateToolLifecycleEvent(missing)).toThrow();
      }
    }
    expect(() =>
      validateToolLifecycleEvent({ ...phase("bind-ready"), readiness: "unavailable" }),
    ).toThrow();
    expect(() =>
      validateToolLifecycleEvent({ ...phase("bind-unavailable"), readiness: "ready" }),
    ).toThrow();
    expect(() =>
      validateToolLifecycleEvent({ ...phase("invocation-started"), reservationId: null }),
    ).toThrow();
    expect(() => validateToolLifecycleEvent({ ...phase("discarded"), reason: "none" })).toThrow();
  });
  it("represents unresolved identity only before reservation and effects", () => {
    const rejection = {
      ...phase("terminal"),
      toolRef: null,
      status: "invalid",
      reason: "unknown-tool",
      effectStarted: false,
      reservationId: null,
      budgetDisposition: "not-reserved",
    };
    expect(validateToolLifecycleEvent(rejection)).toEqual(rejection);
    for (const change of [
      { status: "completed", reason: "none" },
      { effectStarted: true, reservationId: "reservation-1", budgetDisposition: "committed" },
      { reservationId: "reservation-1", budgetDisposition: "released" },
    ])
      expect(() => validateToolLifecycleEvent({ ...rejection, ...change })).toThrow();
    expect(() =>
      validateToolLifecycleEvent({ ...phase("invocation-started"), toolRef: null }),
    ).toThrow();
    expect(() => validateToolLifecycleEvent({ ...phase("discarded"), toolRef: null })).toThrow();
  });
  it("requires closed failure reasons and sanitized structured errors", () => {
    const failed = generated.terminalFixtures.find(
      (item) => item.evidence.status === "failed",
    )?.evidence;
    expect(failed).toBeDefined();
    for (const change of [
      { reason: "private-body" },
      { status: "result-contract-failed" },
      { errorKind: "private failure message" },
      { frames: ["/private/source.ts:1:1"] },
      { causeChain: ["private exception message"] },
      { inputBytes: 262145 },
      { outputBytes: -1 },
      { toolRef: { canonicalId: "private", contractVersion: 1 } },
    ])
      expect(() => validateToolLifecycleEvent({ ...failed, ...change })).toThrow();
    expect(() =>
      validateToolLifecycleEvent({ ...phase("terminal"), errorKind: "TypeError" }),
    ).toThrow();
  });
  it("attempts the primary write before an auxiliary failure and reports structured diagnostics", () => {
    const port = sinks();
    const auxiliary = {
      write: vi.fn(() => {
        expect(port.primary.events).toHaveLength(1);
        throw new Error("private failure body");
      }),
    };
    emitToolLifecycleEvent({ ...port, auxiliary }, phase("terminal"));
    expect(port.primary.events).toHaveLength(1);
    expect(port.diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "tool-catalog.lifecycle-sink-failed",
        source: "tool-catalog-lifecycle-auxiliary",
        correlationId: "correlation-1",
        errorClass: "Error",
      }),
    );
    expect(JSON.stringify(port.diagnostics.record.mock.calls)).not.toContain(
      "private failure body",
    );
  });
  it("does not fabricate a primary terminal when an injected primary sink fails", () => {
    const port = sinks();
    const primary = {
      write: vi.fn(() => {
        throw new Error("private failure body");
      }),
    };
    emitToolLifecycleEvent({ ...port, primary }, phase("terminal"));
    expect(primary.write).toHaveBeenCalledOnce();
    expect(port.auxiliary.events).toHaveLength(1);
    expect(port.diagnostics.record).toHaveBeenCalledOnce();
    expect(port.diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: "tool-catalog-lifecycle-primary" }),
    );
  });
});
