import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { beginAppSessionOperation } from "./appSessionReadAuthority.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

function operationFixture(): {
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly deps: {
    codingAppSessionChannel: ReturnType<typeof createCodingAppSessionChannel>;
    activityLog: BufferedServerLogSink;
  };
  readonly request: IncomingMessage;
  readonly token: string;
  readonly advanceTo: (time: number) => void;
} {
  let now = 0;
  const registry = createSessionRegistry({ now: () => now, idleTtlMs: 100, absoluteTtlMs: 1000 });
  const minted = registry.mint("operation-test");
  const request = new IncomingMessage(new Socket());
  request.headers.cookie = `${APP_SESSION_COOKIE_NAME}=${minted.cookieToken}`;
  return {
    registry,
    deps: {
      codingAppSessionChannel: createCodingAppSessionChannel({ registry }),
      activityLog: createBufferedServerLogSink(),
    },
    request,
    token: minted.cookieToken,
    advanceTo: (time): void => {
      now = time;
    },
  };
}

describe("explicit app-session request operation", () => {
  afterEach(() => {
    resetServerLogger();
    vi.restoreAllMocks();
  });
  it("does not protect a session without a request or composed channel", () => {
    const fixture = operationFixture();
    const signal = new AbortController().signal;
    beginAppSessionOperation(fixture.deps, undefined, signal)();
    beginAppSessionOperation({}, fixture.request, signal)();
    fixture.advanceTo(101);
    expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
  });

  it("immediately releases a pre-aborted request", () => {
    const fixture = operationFixture();
    const controller = new AbortController();
    controller.abort();
    const release = beginAppSessionOperation(fixture.deps, fixture.request, controller.signal);
    fixture.advanceTo(101);
    expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
    release();
    expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
  });

  it("releases on abort even before an uncooperative caller finishes", () => {
    const fixture = operationFixture();
    const controller = new AbortController();
    const release = beginAppSessionOperation(fixture.deps, fixture.request, controller.signal);
    fixture.advanceTo(150);
    expect(fixture.registry.inspect(fixture.token)).toBeDefined();
    controller.abort();
    expect(fixture.registry.inspect(fixture.token)?.lastSeenAtMs).toBe(150);
    fixture.advanceTo(170);
    release();
    expect(fixture.registry.inspect(fixture.token)?.lastSeenAtMs).toBe(150);
    fixture.advanceTo(251);
    expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
  });

  it("removes the abort listener and never refreshes twice after completion", () => {
    const fixture = operationFixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const release = beginAppSessionOperation(fixture.deps, fixture.request, controller.signal);
    fixture.advanceTo(150);
    release();
    expect(remove).toHaveBeenCalledOnce();
    fixture.advanceTo(170);
    controller.abort();
    release();
    expect(fixture.registry.inspect(fixture.token)?.lastSeenAtMs).toBe(150);
    fixture.advanceTo(251);
    expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
  });
  it("records actual concurrent acquire/release states without bearer material or failure incidents", () => {
    const fixture = operationFixture();
    const controller = new AbortController();
    const first = beginAppSessionOperation(fixture.deps, fixture.request, controller.signal, {
      correlationId: "operation-first",
      surface: "grounded-chat",
    });
    const second = beginAppSessionOperation(
      fixture.deps,
      fixture.request,
      new AbortController().signal,
      { correlationId: "operation-second", surface: "desktop-chat" },
    );
    controller.abort();
    first();
    second();
    expect(
      fixture.deps.activityLog.events.map((event) => event.extra?.concurrentOperations),
    ).toEqual([1, 2, 1, 0]);
    expect(fixture.deps.activityLog.events.map((event) => event.extra?.phase)).toEqual([
      "acquired",
      "acquired",
      "released",
      "released",
    ]);
    expect(fixture.deps.activityLog.events[2]?.extra?.releaseReason).toBe("aborted");
    expect(fixture.deps.activityLog.events[3]?.extra?.releaseReason).toBe("settled");
    for (const event of fixture.deps.activityLog.events) {
      const line = formatActivityLogProofLine(event);
      const record = expectActivityLogProof("coding-app-session.operation.state.line", line);
      expect(record).toMatchObject({
        level: "info",
        authorityState: "active",
        completeness: "complete",
        loss: "none",
      });
      expect(record).not.toHaveProperty("errorKind");
      expect(line).not.toContain(fixture.token);
      expect(analyzeLogText(line).sufficiency.status).toBe("complete");
    }
  });

  it.each(["acquired", "released", "aborted"] as const)(
    "uses the safe process logger when injected %s telemetry delivery fails",
    (phase) => {
      const fixture = operationFixture();
      const fallback = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink: fallback, level: "info" }));
      const write = vi.spyOn(fixture.deps.activityLog, "write");
      if (phase === "acquired")
        write.mockImplementation(() => {
          throw new Error("Test activity sink unavailable");
        });
      const controller = new AbortController();
      const release = beginAppSessionOperation(fixture.deps, fixture.request, controller.signal);
      if (phase !== "acquired")
        write.mockImplementation(() => {
          throw new Error("Test activity sink unavailable");
        });
      fixture.advanceTo(150);
      expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(1);
      if (phase === "aborted")
        expect(() => {
          controller.abort();
        }).not.toThrow();
      expect(release).not.toThrow();
      expect(fixture.registry.inspectOperationCount(fixture.token)).toBe(0);
      const expectedPhase = phase === "aborted" ? "released" : phase;
      expect(fallback.events.map((event) => event.op)).toContain(
        "coding-app-session.operation.state",
      );
      expect(fallback.events.map((event) => event.extra?.phase)).toContain(expectedPhase);
      if (phase === "aborted") expect(fallback.events[0]?.extra?.releaseReason).toBe("aborted");
      fixture.advanceTo(251);
      expect(fixture.registry.inspect(fixture.token)).toBeUndefined();
    },
  );
});
