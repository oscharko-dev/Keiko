// The application's chosen diagnostic transport. Separate from the sink's own tests on purpose: this
// is the only module in keiko-ui production code permitted to write to a console, so the assertion
// that it does — and that it does nothing else — lives where a reviewer looks for it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { clientErrorEvidence } from "./client-error-evidence";
import {
  clientDiagnosticPostFailureCount,
  clientDiagnosticPostThrottledCount,
  fanOutClientDiagnostic,
  flushClientDiagnosticLoss,
  resetClientDiagnosticPostStateForTests,
  writeToBrowserConsole,
} from "./install-client-diagnostics";
import {
  recordClientDiagnosticLoss,
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  takeClientDiagnosticLoss,
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

// #3532: every report the page could not deliver is counted, and the counts ride the next report
// that does reach the server, so the Activity Log records how much of a storm never arrived.
describe("fanOutClientDiagnostic delivery-loss accounting", () => {
  it("carries the counted loss on the next delivered report and clears it", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordClientDiagnosticLoss("rejectionsSuppressed", 3);

    fanOutClientDiagnostic("[keiko] app shell crashed: TypeError");
    fanOutClientDiagnostic("[keiko] app shell crashed: RangeError");

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
    );
    expect(bodies[0]?.["loss"]).toEqual({ rejectionsSuppressed: 3 });
    expect(bodies[1]).not.toHaveProperty("loss");
  });

  it("counts a throttled POST and reports it on the first admitted one", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    for (let index = 0; index < 22; index += 1) fanOutClientDiagnostic(`tick ${String(index)}`);
    now.mockReturnValue(1_700_000_000_000 + 60_000);
    fanOutClientDiagnostic("after the window");

    expect(fetchMock).toHaveBeenCalledTimes(21);
    expect(lastPostedBody(fetchMock)["loss"]).toEqual({ postsThrottled: 2 });
  });

  it("gives a failed POST's loss back and counts the failed POST itself", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordClientDiagnosticLoss("bufferEvicted", 2);

    fanOutClientDiagnostic("boot: gateway probe failed");

    await vi.waitFor(() => {
      expect(clientDiagnosticPostFailureCount()).toBe(1);
    });
    expect(takeClientDiagnosticLoss()).toEqual({ bufferEvicted: 2, postsFailed: 1 });
  });

  it("preserves a voice turn parent and rejects an unsafe parent identity", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("voice lifecycle", {
      kind: "voice-dialogue",
      voiceDialogueStage: "turn-submitted",
      correlationId: "turn-0001",
      parentCorrelationId: "session-0001",
    });
    expect(lastPostedBody(fetchMock)).toMatchObject({
      correlationId: "turn-0001",
      parentCorrelationId: "session-0001",
    });
    fanOutClientDiagnostic("voice lifecycle", { parentCorrelationId: "private unsafe parent" });
    expect(lastPostedBody(fetchMock)).not.toHaveProperty("parentCorrelationId");
  });

  it.each([
    ["", false],
    ["a".repeat(7), false],
    ["a".repeat(8), true],
    ["a".repeat(128), true],
    ["a".repeat(129), false],
  ])("bounds parent correlation %s", (parentCorrelationId, accepted) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("voice lifecycle", { parentCorrelationId });
    const posted = lastPostedBody(fetchMock);
    if (accepted) expect(posted).toHaveProperty("parentCorrelationId", parentCorrelationId);
    else expect(posted).not.toHaveProperty("parentCorrelationId");
  });

  it("puts the caller's closed kind on the wire", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", { kind: "window-error" });

    expect(lastPostedBody(fetchMock)["kind"]).toBe("window-error");
  });

  // #3557 review: a failure the caller classified keeps its closed class on the wire.
  it("puts the caller's classified error kind on the wire", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic("[keiko] local app session ensure failed: TypeError", {
      correlationId: "ui_session-ensure-0001",
      errorKind: "unavailable",
    });

    expect(lastPostedBody(fetchMock)).toMatchObject({
      correlationId: "ui_session-ensure-0001",
      errorKind: "unavailable",
    });
  });

  it("flushes the remaining loss in one final report when the page is hidden", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    recordClientDiagnosticLoss("errorsSuppressed", 7);

    // The module installs this listener on import; the page hiding is what triggers it.
    window.dispatchEvent(new Event("pagehide"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = lastPostedBody(fetchMock);
    expect(body["loss"]).toEqual({ errorsSuppressed: 7 });
    expect(body["kind"]).toBe("other");
    expect(body["message"]).toBe("[keiko] client diagnostic delivery loss summary");
    expect(takeClientDiagnosticLoss()).toBeUndefined();
  });

  it("sends nothing on page hide when nothing was lost", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    flushClientDiagnosticLoss();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// The fatal-flaw fix (Wave 5 follow-up, epic #3233): `correlationId` is what lets an agent join a
// browser diagnostic to the specific failed server request it describes. These cases pin
// `clientDiagnosticPostBody`'s shape validation (exercised only through the public
// `fanOutClientDiagnostic` entry point, matching every other case in this file).
describe("fanOutClientDiagnostic correlationId handling", () => {
  it("preserves the closed voice stage and originating chat correlation on the wire", () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    fanOutClientDiagnostic("[keiko] batch voice dialogue (stage=delivery-failed)", {
      correlationId: "voice-chat-request-0001",
      kind: "voice-dialogue",
      voiceDialogueStage: "delivery-failed",
    });

    expect(lastPostedBody(fetchMock)).toMatchObject({
      correlationId: "voice-chat-request-0001",
      kind: "voice-dialogue",
      voiceDialogueStage: "delivery-failed",
    });
  });

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

// KEIKO-3557: `useWindowStageEvidence` reports routine stage evidence through `meta.stageReport`
// rather than the failure-shaped message/kind wire body above. The console still gets the exact
// same human-readable text (nothing here decorates or replaces it) — only the POST body changes.
describe("fanOutClientDiagnostic stage evidence", () => {
  it("posts the closed stage wire shape for a started report, never the message body", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("desktop chat bind #1: started", {
      stageReport: { stage: "chat bind", phase: "started", ordinal: 1 },
    });

    // The console still gets the plain, human-readable text — the transport is the only thing that
    // changes what reaches the server.
    expect(consoleWarn).toHaveBeenCalledWith("desktop chat bind #1: started");
    const body = lastPostedBody(fetchMock);
    expect(body).toEqual({ kind: "stage", stage: "chat bind", phase: "started", ordinal: 1 });
  });

  it("posts the closed stage wire shape for a settled report, with durationMs and no other field", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("desktop chat bind #1: settled after 5ms", {
      stageReport: { stage: "chat bind", phase: "settled", ordinal: 1, durationMs: 5 },
    });

    const body = lastPostedBody(fetchMock);
    expect(body).toEqual({
      kind: "stage",
      stage: "chat bind",
      phase: "settled",
      ordinal: 1,
      durationMs: 5,
    });
  });

  it("never drains the page's pending delivery loss for a stage report, leaving it for the next report", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    recordClientDiagnosticLoss("rejectionsSuppressed", 3);

    fanOutClientDiagnostic("desktop chat bind #1: started", {
      stageReport: { stage: "chat bind", phase: "started", ordinal: 1 },
    });

    expect(lastPostedBody(fetchMock)).not.toHaveProperty("loss");
    // Still pending: a stage report never took it, so the next delivered report still carries it.
    expect(takeClientDiagnosticLoss()).toEqual({ rejectionsSuppressed: 3 });
  });
});

// #3557 review: a restored window's binding outcome posts its closed report with the correlation id
// of the request that decided it, never the message body, and never drains the loss ledger.
describe("fanOutClientDiagnostic binding evidence", () => {
  it("posts the closed binding wire shape with the deciding request's correlation id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    recordClientDiagnosticLoss("rejectionsSuppressed", 2);

    fanOutClientDiagnostic("[keiko] chat window restore target not found (reference=redacted)", {
      correlationId: "ui_chat-list-load-0003",
      bindingReport: {
        surface: "chat-window",
        outcome: "target-missing",
        referenceShape: "redacted",
        heuristicFlagged: false,
        windowRef: "chat-mfr3k2x1-2",
        decidingLoadCount: 17,
        relatedCorrelationIds: ["ui_chat-list-load-0004", "not a safe id"],
      },
    });

    // Only safe related ids travel; the malformed one is dropped, never the whole report.
    expect(lastPostedBody(fetchMock)).toEqual({
      kind: "binding",
      surface: "chat-window",
      outcome: "target-missing",
      referenceShape: "redacted",
      heuristicFlagged: false,
      windowRef: "chat-mfr3k2x1-2",
      correlationId: "ui_chat-list-load-0003",
      relatedCorrelationIds: ["ui_chat-list-load-0004"],
      decidingLoadCount: 17,
    });
    expect(takeClientDiagnosticLoss()).toEqual({ rejectionsSuppressed: 2 });
  });

  // #3557 review: an offer carries its count, zero included, and a binding found again after
  // redaction the fingerprint of the chat it bound to, so two choices from one list stay apart.
  it("posts an offer's count, zero included, and a restored binding's target fingerprint", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    const binding = {
      surface: "chat-window",
      windowRef: "chat-mfr3k2x1-3",
      decidingLoadCount: 1,
    } as const;

    fanOutClientDiagnostic("[keiko] chat window offered conversations to choose from", {
      correlationId: "ui_chat-list-load-0005",
      bindingReport: {
        ...binding,
        outcome: "candidates-offered",
        referenceShape: "redacted",
        heuristicFlagged: false,
        candidateCount: 0,
      },
    });
    expect(lastPostedBody(fetchMock)).toEqual({
      kind: "binding",
      ...binding,
      outcome: "candidates-offered",
      referenceShape: "redacted",
      heuristicFlagged: false,
      correlationId: "ui_chat-list-load-0005",
      candidateCount: 0,
    });

    fanOutClientDiagnostic("[keiko] chat window binding resolved (reference=user-selected)", {
      correlationId: "ui_chat-list-load-0005",
      bindingReport: {
        ...binding,
        outcome: "resolved",
        referenceShape: "user-selected",
        heuristicFlagged: true,
        targetFingerprint: "a1".repeat(32),
      },
    });
    expect(lastPostedBody(fetchMock)).toEqual({
      kind: "binding",
      ...binding,
      outcome: "resolved",
      referenceShape: "user-selected",
      heuristicFlagged: true,
      correlationId: "ui_chat-list-load-0005",
      targetFingerprint: "a1".repeat(32),
    });
  });
});

// #3557 review: a stage's two phases share one id, and a session repair joins the denied request.
describe("fanOutClientDiagnostic correlated closed reports", () => {
  it("posts a stage report under the stage's own correlation id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("desktop chat bind #2: started", {
      correlationId: "ui_stage-0002",
      stageReport: { stage: "chat bind", phase: "started", ordinal: 2 },
    });

    expect(lastPostedBody(fetchMock)).toEqual({
      kind: "stage",
      stage: "chat bind",
      phase: "started",
      ordinal: 2,
      correlationId: "ui_stage-0002",
    });
  });

  it("posts a session repair report on the denied request's timeline without draining loss", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    recordClientDiagnosticLoss("rejectionsSuppressed", 1);

    fanOutClientDiagnostic("[keiko] stale session repair: replayed", {
      correlationId: "ui_denied-read-0001",
      sessionRepairReport: {
        outcome: "replay-failed",
        repairCorrelationId: "ui_session-repair-0001",
        errorKind: "unavailable",
      },
    });

    expect(lastPostedBody(fetchMock)).toEqual({
      kind: "session-repair",
      outcome: "replay-failed",
      correlationId: "ui_denied-read-0001",
      repairCorrelationId: "ui_session-repair-0001",
      errorKind: "unavailable",
    });
    expect(takeClientDiagnosticLoss()).toEqual({ rejectionsSuppressed: 1 });
  });

  // #3557 review: a stream repair travels under its failure streak, naming its stream.
  it("posts a stream repair report with its stream under the failure streak's id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("[keiko] run-events stream session repair: stream-repaired", {
      correlationId: "ui_stream-streak-0001",
      sessionRepairReport: {
        outcome: "stream-repaired",
        repairCorrelationId: "ui_session-repair-0002",
        stream: "run-events",
      },
    });

    expect(lastPostedBody(fetchMock)).toEqual({
      kind: "session-repair",
      outcome: "stream-repaired",
      correlationId: "ui_stream-streak-0001",
      repairCorrelationId: "ui_session-repair-0002",
      stream: "run-events",
    });
  });

  it("falls back to a plain message report when a session repair has no safe denied-request id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("[keiko] stale session repair: replayed", {
      correlationId: "not a safe id",
      sessionRepairReport: { outcome: "replayed", repairCorrelationId: "ui_repair-0001" },
    });

    expect(lastPostedBody(fetchMock)).toMatchObject({
      message: "[keiko] stale session repair: replayed",
    });
  });

  // #3557 review: the ingest contract requires the repair request's id, so a report whose repair id
  // is not safe is never posted as a repair report the server would refuse.
  it("falls back to a plain message report when a session repair has no safe repair id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    fanOutClientDiagnostic("[keiko] stale session repair: replayed", {
      correlationId: "ui_denied-0001",
      sessionRepairReport: { outcome: "replayed", repairCorrelationId: "not a safe id" },
    });

    expect(lastPostedBody(fetchMock)).toMatchObject({
      message: "[keiko] stale session repair: replayed",
    });
    expect(lastPostedBody(fetchMock)).not.toHaveProperty("kind", "session-repair");
  });
});

// #3557: a page load posts about a dozen routine stage reports. With one shared budget, a failure
// raised during boot (the one most likely to hold a real stall) was dropped console-only.
describe("fanOutClientDiagnostic budgets", () => {
  it("never lets routine evidence use up the budget of a failure report", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
      fanOutClientDiagnostic(`desktop window chunk #${String(ordinal)}: started`, {
        stageReport: { stage: "window chunk", phase: "started", ordinal },
      });
    }
    fanOutClientDiagnostic("boundary caught TypeError", { kind: "boundary" });

    expect(fetchMock).toHaveBeenCalledTimes(31);
    expect(lastPostedBody(fetchMock)).toMatchObject({ message: "boundary caught TypeError" });
    expect(clientDiagnosticPostThrottledCount()).toBe(0);
  });

  it("still bounds routine evidence on its own budget", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    for (let ordinal = 1; ordinal <= 61; ordinal += 1) {
      fanOutClientDiagnostic(`desktop window chunk #${String(ordinal)}: started`, {
        stageReport: { stage: "window chunk", phase: "started", ordinal },
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(clientDiagnosticPostThrottledCount()).toBe(1);
  });

  // #3557 review: a recovered stream is routine evidence, like a replayed read.
  it("spends a stream repair from the routine budget, never the failure budget", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 1; index <= 25; index += 1) {
      fanOutClientDiagnostic("[keiko] run-events stream session repair: stream-repaired", {
        correlationId: `ui_stream-streak-${String(index).padStart(4, "0")}`,
        sessionRepairReport: {
          outcome: "stream-repaired",
          repairCorrelationId: `ui_repair-${String(index).padStart(4, "0")}`,
          stream: "run-events",
        },
      });
    }
    fanOutClientDiagnostic("boundary caught TypeError", { kind: "boundary" });

    expect(fetchMock).toHaveBeenCalledTimes(26);
    expect(clientDiagnosticPostThrottledCount()).toBe(0);
  });
});

it("posts reduced production frames and closed causes through the existing transport", () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
  vi.stubGlobal("fetch", fetchMock);
  const cause = new TypeError("private browser detail");
  cause.stack = `TypeError: private browser detail\n    at start (${location.origin}/_next/static/chunks/1wntg-7ptuw73.js:12:345)`;
  fanOutClientDiagnostic("recorder:failure", {
    correlationId: "capture-session",
    kind: "voice-dialogue",
    errorEvidence: clientErrorEvidence(new Error("private wrapper", { cause })),
  });
  expect(lastPostedBody(fetchMock)).toMatchObject({
    correlationId: "capture-session",
    errorEvidence: {
      errorClass: "Error",
      causeChain: ["TypeError"],
      frames: ["dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:12:345"],
    },
  });
  expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(
    /private browser detail|private wrapper|https?:/,
  );
});
