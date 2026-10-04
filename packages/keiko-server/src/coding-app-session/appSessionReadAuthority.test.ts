import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { beginAppSessionOperation } from "./appSessionReadAuthority.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

function operationFixture(): {
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly deps: { codingAppSessionChannel: ReturnType<typeof createCodingAppSessionChannel> };
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
    deps: { codingAppSessionChannel: createCodingAppSessionChannel({ registry }) },
    request,
    token: minted.cookieToken,
    advanceTo: (time): void => {
      now = time;
    },
  };
}

describe("explicit app-session request operation", () => {
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
});
