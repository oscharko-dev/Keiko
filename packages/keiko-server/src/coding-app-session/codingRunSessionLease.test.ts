import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  abortCodingRunSessionLeases,
  CODING_RUN_SESSION_LEASE_OBSERVATION_MS,
  holdAppSessionForCodingRun,
} from "./codingRunSessionLease.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "../diagnostics-log.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const IDLE_TTL_MS = 30 * 60 * 1_000;
const RUN_ID = "run-lease-1";

interface LeaseFixture {
  readonly deps: {
    readonly codingAppSessionChannel: ReturnType<typeof createCodingAppSessionChannel>;
    readonly activityLog: BufferedServerLogSink;
    readonly diagnostics: ServerDiagnosticSink;
  };
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly request: IncomingMessage;
  readonly token: string;
  readonly state: { value: CodingWorkbenchRuntimeStateName | undefined };
  readonly hold: (state?: CodingWorkbenchRuntimeStateName, runId?: string) => void;
}

function leaseFixture(): LeaseFixture {
  const registry = createSessionRegistry({ idleTtlMs: IDLE_TTL_MS });
  const minted = registry.mint("coding-run-lease");
  const request = new IncomingMessage(new Socket());
  request.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${minted.cookieToken}`;
  const diagnostics: ServerDiagnosticRecord[] = [];
  const deps = {
    codingAppSessionChannel: createCodingAppSessionChannel({ registry }),
    activityLog: createBufferedServerLogSink(),
    diagnostics: {
      record: (record: ServerDiagnosticRecord): void => void diagnostics.push(record),
    },
  };
  const state: LeaseFixture["state"] = { value: "running" };
  return {
    deps,
    diagnostics,
    registry,
    request,
    token: minted.cookieToken,
    state,
    hold: (snapshotState = "running", runId = RUN_ID): void => {
      holdAppSessionForCodingRun(deps, request, { runId, state: snapshotState }, () => state.value);
    },
  };
}

function operationLines(fixture: LeaseFixture): readonly Readonly<Record<string, unknown>>[] {
  return fixture.deps.activityLog.events
    .filter((event) => event.op === "coding-app-session.operation.state")
    .map((event) => ({ correlationId: event.correlationId, ...event.extra }));
}

describe("a Coding Workbench run keeps its window's session active (ADR-0141 D5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-27T00:00:00.000Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("protects the session past the idle window while the run is active, then releases it", () => {
    const fixture = leaseFixture();
    fixture.hold();
    vi.advanceTimersByTime(IDLE_TTL_MS + 60_000);
    expect(fixture.registry.inspect(fixture.token)).toBeDefined();
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(1);

    fixture.state.value = "succeeded";
    vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The ordinary idle window starts at settlement, not at the last request.
    vi.advanceTimersByTime(IDLE_TTL_MS - 1);
    expect(fixture.registry.inspect(fixture.token)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
  });

  it("records acquisition and settlement under the run, with the coding-run surface", () => {
    const fixture = leaseFixture();
    fixture.hold();
    fixture.state.value = "failed";
    vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    expect(operationLines(fixture)).toEqual([
      expect.objectContaining({
        correlationId: RUN_ID,
        phase: "acquired",
        surface: "coding-run",
        concurrentOperations: 1,
      }),
      expect.objectContaining({
        correlationId: RUN_ID,
        phase: "released",
        surface: "coding-run",
        releaseReason: "settled",
        concurrentOperations: 0,
        durationMs: CODING_RUN_SESSION_LEASE_OBSERVATION_MS,
      }),
    ]);
    const released = fixture.deps.activityLog.events.at(-1);
    expect(
      expectActivityLogProof(
        "coding-app-session.operation.state.line",
        formatActivityLogProofLine(released ?? {}),
      ),
    ).toMatchObject({ phase: "released", surface: "coding-run", releaseReason: "settled" });
  });

  it.each([
    "paused",
    "succeeded",
    "failed",
    "cancelled",
    "taken-over",
    "recovery-required",
    "idle",
  ] as const)("holds nothing for a run answered in the %s state", (state) => {
    const fixture = leaseFixture();
    fixture.hold(state);
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    expect(operationLines(fixture)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds one lease per session and run however often the run is acted on", () => {
    const fixture = leaseFixture();
    fixture.hold("starting");
    fixture.hold("running");
    fixture.hold("awaiting-approval");
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(1);
    expect(operationLines(fixture)).toHaveLength(1);
  });

  it("releases on pause and holds again when the run resumes", () => {
    const fixture = leaseFixture();
    fixture.hold();
    fixture.state.value = "paused";
    vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    fixture.state.value = "running";
    fixture.hold("running");
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(1);
  });

  it("releases a run whose snapshot is gone", () => {
    const fixture = leaseFixture();
    fixture.hold();
    fixture.state.value = undefined;
    vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
  });

  it("never extends the absolute lifetime or revives a revoked session", () => {
    const registry = createSessionRegistry({ idleTtlMs: IDLE_TTL_MS, absoluteTtlMs: 60 * 60_000 });
    const minted = registry.mint("coding-run-lease");
    const request = new IncomingMessage(new Socket());
    request.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${minted.cookieToken}`;
    const deps = {
      codingAppSessionChannel: createCodingAppSessionChannel({ registry }),
      activityLog: createBufferedServerLogSink(),
    };
    holdAppSessionForCodingRun(deps, request, { runId: RUN_ID, state: "running" }, () => "running");
    vi.advanceTimersByTime(60 * 60_000);
    expect(registry.inspect(minted.cookieToken)).toBeUndefined();

    const second = registry.mint("coding-run-lease");
    request.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${second.cookieToken}`;
    holdAppSessionForCodingRun(
      deps,
      request,
      { runId: "run-lease-2", state: "running" },
      () => "running",
    );
    const sessionId = registry.verify(second.cookieToken)?.sessionId;
    if (sessionId === undefined) throw new Error("session missing");
    registry.revoke(sessionId);
    vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    expect(registry.inspect(second.cookieToken)).toBeUndefined();
    abortCodingRunSessionLeases(deps.codingAppSessionChannel);
  });

  it("holds nothing without a channel, a run id or an authenticated request", () => {
    const fixture = leaseFixture();
    holdAppSessionForCodingRun(
      {},
      fixture.request,
      { runId: RUN_ID, state: "running" },
      () => "running",
    );
    holdAppSessionForCodingRun(
      fixture.deps,
      fixture.request,
      { state: "running" },
      () => "running",
    );
    const anonymous = new IncomingMessage(new Socket());
    holdAppSessionForCodingRun(
      fixture.deps,
      anonymous,
      { runId: RUN_ID, state: "running" },
      () => "running",
    );
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Rotation re-issues the session as a new registry record whose operation count starts at zero,
  // so the lease its predecessor held no longer protects it (PR #4096 review).
  it("holds a rotated session again on the run's next admitted mutation", () => {
    const fixture = leaseFixture();
    fixture.hold();
    const sessionId = fixture.registry.verify(fixture.token)?.sessionId;
    if (sessionId === undefined) throw new Error("session missing");
    const rotated = fixture.registry.rotate(sessionId);
    if (rotated === undefined) throw new Error("rotation refused");
    expect(fixture.registry.inspectOperationCount(rotated.cookieToken)).toBe(0);

    fixture.request.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${rotated.cookieToken}`;
    fixture.hold();
    expect(fixture.registry.inspectOperationCount(rotated.cookieToken)).toBe(1);
    vi.advanceTimersByTime(IDLE_TTL_MS + 60_000);
    expect(fixture.registry.inspect(rotated.cookieToken)).toBeDefined();

    fixture.state.value = "succeeded";
    vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    expect(fixture.registry.inspectOperationCount(rotated.cookieToken)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a run whose state cannot be read and records a body-free diagnostic", () => {
    const fixture = leaseFixture();
    holdAppSessionForCodingRun(
      fixture.deps,
      fixture.request,
      { runId: RUN_ID, state: "running" },
      () => {
        throw new Error("PRIVATE_SNAPSHOT_STORE");
      },
    );

    expect(() => vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS)).not.toThrow();
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.diagnostics).toEqual([
      expect.objectContaining({
        correlationId: RUN_ID,
        operation: "coding-app-session.operation.state",
        source: "coding-app-session.coding-run-lease.state",
        errorClass: "Error",
      }),
    ]);
    expect(JSON.stringify(fixture.diagnostics)).not.toContain("PRIVATE_SNAPSHOT_STORE");
  });

  it("releases every session of a settled run even when one release fails", () => {
    const fixture = leaseFixture();
    const channel = fixture.deps.codingAppSessionChannel;
    const failing = fixture.token;
    const deps = {
      ...fixture.deps,
      codingAppSessionChannel: {
        ...channel,
        beginOperation: (token: string | undefined): (() => void) | undefined => {
          const release = channel.beginOperation(token);
          if (release === undefined || token !== failing) return release;
          return (): void => {
            release();
            throw new Error("PRIVATE_RELEASE_FAILURE");
          };
        },
      },
    };
    const second = fixture.registry.mint("coding-run-lease");
    const secondRequest = new IncomingMessage(new Socket());
    secondRequest.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${second.cookieToken}`;
    holdAppSessionForCodingRun(
      deps,
      fixture.request,
      { runId: RUN_ID, state: "running" },
      () => fixture.state.value,
    );
    holdAppSessionForCodingRun(
      deps,
      secondRequest,
      { runId: RUN_ID, state: "running" },
      () => fixture.state.value,
    );
    expect(fixture.registry.inspectOperationCount(second.cookieToken)).toBe(1);

    fixture.state.value = "succeeded";
    expect(() => vi.advanceTimersByTime(CODING_RUN_SESSION_LEASE_OBSERVATION_MS)).not.toThrow();
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    expect(fixture.registry.inspectOperationCount(second.cookieToken)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.diagnostics).toEqual([
      expect.objectContaining({
        correlationId: RUN_ID,
        source: "coding-app-session.coding-run-lease.release",
      }),
    ]);
    expect(JSON.stringify(fixture.diagnostics)).not.toContain("PRIVATE_RELEASE_FAILURE");
  });

  it("ends every held lease as aborted when its graph is disposed", () => {
    const fixture = leaseFixture();
    fixture.hold();
    abortCodingRunSessionLeases(fixture.deps.codingAppSessionChannel);
    expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(operationLines(fixture).at(-1)).toMatchObject({
      phase: "released",
      releaseReason: "aborted",
      surface: "coding-run",
    });
  });
});
