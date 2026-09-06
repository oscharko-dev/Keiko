// The application's chosen diagnostic transport. Separate from the sink's own tests on purpose: this
// is the only module in keiko-ui production code permitted to write to a console, so the assertion
// that it does — and that it does nothing else — lives where a reviewer looks for it.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientDiagnosticPostFailureCount,
  clientDiagnosticPostThrottledCount,
  fanOutClientDiagnostic,
  resetClientDiagnosticPostStateForTests,
  writeToBrowserConsole,
} from "./install-client-diagnostics";
import {
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
} from "./client-diagnostics";

function jsonResponse(status = 204): Response {
  return new Response(null, { status });
}

function lastPostedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  const lastCall = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(lastCall[1].body as string) as Record<string, unknown>;
}

afterEach(() => {
  resetClientDiagnosticWriter();
  resetClientDiagnosticPostStateForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writeToBrowserConsole", () => {
  it("writes the message verbatim and adds nothing of its own", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    writeToBrowserConsole("shell-shortcuts: refused persisted keybinding overrides");

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    // Verbatim: the transport must not decorate, prefix, or re-serialise. Redaction happened at the
    // call site and anything added here would be text no reviewer checked.
    expect(consoleWarn).toHaveBeenCalledWith(
      "shell-shortcuts: refused persisted keybinding overrides",
    );
    consoleWarn.mockRestore();
  });

  it("is what importing this module installs, so a boot-time diagnostic reaches the console", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The import side effect already ran; re-install it explicitly so this assertion does not depend
    // on whether another suite in this worker replaced the writer first.
    setClientDiagnosticWriter(writeToBrowserConsole);

    reportClientDiagnostic("boot: gateway probe failed (TypeError)");

    expect(consoleWarn).toHaveBeenCalledWith("boot: gateway probe failed (TypeError)");
    consoleWarn.mockRestore();
  });
});

// The second transport (Wave 5 of epic #3233, g6): a best-effort POST to
// `POST /api/diagnostics/client`, fanned out alongside the console so neither call site regresses
// when the other is added.
describe("fanOutClientDiagnostic", () => {
  it("writes to the console and posts the same message to the server", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("workspace-state: pull failed (network error)");

    expect(consoleWarn).toHaveBeenCalledWith("workspace-state: pull failed (network error)");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/diagnostics/client");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const body = lastPostedBody(fetchMock);
    expect(body["message"]).toBe("workspace-state: pull failed (network error)");
    expect(typeof body["clientTs"]).toBe("string");
    // A plain diagnostic never invented by this module carries no readyState/kind: only the four
    // SSE call sites' exact convention (below) does.
    expect(body).not.toHaveProperty("readyState");
    expect(body).not.toHaveProperty("kind");
    consoleWarn.mockRestore();
  });

  it("recovers readyState and kind from the shared SSE onerror message convention", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic(
      "[keiko] shared-event-source sse stream error (kind=sse-error, readyState=0, reason=connecting)",
    );

    const body = lastPostedBody(fetchMock);
    expect(body["readyState"]).toBe(0);
    expect(body["kind"]).toBe("sse-error");
  });

  // Pins the exact convention each of the four SSE-consuming modules independently formats
  // (sharedEventSource.ts, useSSE.ts, coding-workbench-event-retention.ts,
  // useRelationshipActivityStream.ts) — the two ends are not import-linked (see this module's own
  // header), so this is what catches the format drifting apart.
  it.each([
    [
      "[keiko] shared-event-source sse stream error (kind=sse-error, readyState=2, reason=closed)",
      2,
    ],
    ["[keiko] run-events sse stream error (kind=sse-error, readyState=0, reason=connecting)", 0],
    [
      "[keiko] coding-workbench-runtime sse stream error (kind=sse-error, readyState=1, reason=unknown)",
      1,
    ],
    [
      "[keiko] relationship-activity sse stream error (kind=sse-error, readyState=2, reason=closed)",
      2,
    ],
  ])("parses %s", (message, expectedReadyState) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic(message);

    const body = lastPostedBody(fetchMock);
    expect(body["readyState"]).toBe(expectedReadyState);
    expect(body["kind"]).toBe("sse-error");
  });

  it("counts a rejected POST, surfaces a bounded console notice, and does not throw back into the call site", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));

    expect(() => fanOutClientDiagnostic("boot: gateway probe failed")).not.toThrow();

    await vi.waitFor(() => {
      expect(clientDiagnosticPostFailureCount()).toBe(1);
    });
    // Once for the diagnostic itself (console-first fan-out), once for the delivery-failure
    // notice — a developer watching devtools must be able to tell the server never received it.
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalledWith("boot: gateway probe failed");
    const lastCall = consoleWarn.mock.calls[consoleWarn.mock.calls.length - 1] as [string];
    expect(lastCall[0]).toMatch(/diagnostic delivery to the server failed/i);
    // Bounded and redacted: the notice never repeats the original message content or any error
    // detail, so it cannot itself become a place that leaks something the sink already redacted.
    expect(lastCall[0]).not.toContain("network error");
    expect(lastCall[0]).not.toContain("boot: gateway probe failed");
  });

  it("drops the 21st POST within a rolling minute and counts it, without dropping the console write", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 21; index += 1) {
      fanOutClientDiagnostic(`tick ${String(index)}`);
    }

    expect(fetchMock).toHaveBeenCalledTimes(20);
    // 21 diagnostics reach the console, plus ONE throttle notice for the dropped POST — a throttled
    // drop must not be silent (#3376 review).
    expect(consoleWarn).toHaveBeenCalledTimes(22);
    expect(consoleWarn).toHaveBeenLastCalledWith(
      expect.stringContaining("diagnostic delivery to the server is throttled"),
    );
    expect(clientDiagnosticPostThrottledCount()).toBe(1);
  });

  it("writes the throttle notice once per throttled window, not once per process", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));
    const now = vi.spyOn(Date, "now");
    const throttleNotices = (): number =>
      consoleWarn.mock.calls.filter(([message]) =>
        String(message).includes("diagnostic delivery to the server is throttled"),
      ).length;

    now.mockReturnValue(1_700_000_000_000);
    for (let index = 0; index < 22; index += 1) {
      fanOutClientDiagnostic(`first window ${String(index)}`);
    }
    // Two drops in the first window share ONE notice.
    expect(clientDiagnosticPostThrottledCount()).toBe(2);
    expect(throttleNotices()).toBe(1);

    // The limiter resets after a minute; a burst in the next window must leave its own trace
    // (#3376 review) — a process-lifetime "first drop" check would stay silent here.
    now.mockReturnValue(1_700_000_000_000 + 60_000);
    for (let index = 0; index < 21; index += 1) {
      fanOutClientDiagnostic(`second window ${String(index)}`);
    }
    expect(clientDiagnosticPostThrottledCount()).toBe(3);
    expect(throttleNotices()).toBe(2);
  });
});

// The fatal-flaw fix (Wave 5 follow-up, epic #3233): `correlationId` is what lets an agent join a
// browser diagnostic to the specific failed server request it describes. These cases pin
// `clientDiagnosticPostBody`'s shape validation (exercised only through the public
// `fanOutClientDiagnostic` entry point, matching every other case in this file).
describe("fanOutClientDiagnostic correlationId handling", () => {
  it("puts a shape-valid correlationId on the wire body when the caller supplies one", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic("[keiko] app shell crashed: TypeError", {
      correlationId: "original-request-id-01",
    });

    const body = lastPostedBody(fetchMock);
    expect(body["correlationId"]).toBe("original-request-id-01");
  });

  it("keeps a bounded git-change response identity structured on the diagnostic wire", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gitChangeDescription = {
      action: "apply" as const,
      disposition: "discarded" as const,
      relationshipId: "rel-1",
      snapshotDigest: "a".repeat(64),
      proposalId: "prop-1",
      outcome: "observed" as const,
    };

    fanOutClientDiagnostic("[keiko] git-change description response", {
      correlationId: "original-apply-request-id",
      gitChangeDescription,
    });

    expect(lastPostedBody(fetchMock)).toMatchObject({
      correlationId: "original-apply-request-id",
      gitChangeDescription,
    });
  });

  it("keeps a body-free workspace trust identity structured on the diagnostic wire", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const workspaceTrustBinding = {
      repositoryId: "repository-a",
      workspaceId: "workspace-a",
    };

    fanOutClientDiagnostic("[keiko] coding workbench repository trust bound", {
      correlationId: "originating-run-correlation",
      workspaceTrustBinding,
    });

    expect(lastPostedBody(fetchMock)).toMatchObject({
      correlationId: "originating-run-correlation",
      workspaceTrustBinding,
    });
  });

  it("omits correlationId from the wire body when the caller supplies none", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic("[keiko] app shell crashed: TypeError");

    expect(lastPostedBody(fetchMock)).not.toHaveProperty("correlationId");
  });

  // Out-of-shape ids are dropped silently — never thrown, and never sent — rather than trusted
  // as-is: this file is upstream of the server's OWN independent re-validation
  // (client-diagnostics-routes.ts), so a malformed id here would just be redundant, not unsafe: this
  // is defense in depth on the sending side, catching the mistake as close to its source as
  // possible.
  it.each([
    ["too short (7 chars, one under the 8-char floor)", "a".repeat(7)],
    ["too long (129 chars, one over the 128-char ceiling)", "a".repeat(129)],
    ["contains a raw CRLF", "abcdef\r\nghij"],
    ["contains a space", "not a valid id"],
    ["contains a disallowed symbol", "req-id-!!!"],
    ["is empty", ""],
  ])("drops an out-of-shape correlationId: %s", (_label, correlationId) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic("[keiko] app shell crashed: TypeError", { correlationId });

    expect(lastPostedBody(fetchMock)).not.toHaveProperty("correlationId");
  });

  it("still carries readyState/kind from the SSE convention alongside a valid correlationId", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic(
      "[keiko] shared-event-source sse stream error (kind=sse-error, readyState=0, reason=connecting)",
      { correlationId: "sse-req-0000001" },
    );

    const body = lastPostedBody(fetchMock);
    expect(body["correlationId"]).toBe("sse-req-0000001");
    expect(body["readyState"]).toBe(0);
    expect(body["kind"]).toBe("sse-error");
  });
});
