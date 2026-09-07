import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { APIRequestContext, APIResponse, Page, Request } from "@playwright/test";
import {
  assertNoForbiddenSessionToolEvents,
  assertMalformedEffectRequestsRejected,
  observeBoundGitChatSessionActivity,
  observeNoForbiddenSessionRequests,
} from "./coding-issue-journey-live-git-chat-negative.js";

function event(
  op: string,
  correlationId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { op, correlationId, ...extra };
}

const TURN_REQUESTS = [
  { chatId: "chat-1", correlationId: "chat-turn-correlation-1" },
  { chatId: "chat-1", correlationId: "chat-turn-correlation-2" },
] as const;

function completedTurnEvents(): readonly Readonly<Record<string, unknown>>[] {
  return TURN_REQUESTS.flatMap(({ correlationId }, index) => [
    event("coding-runtime.description-authority", correlationId, {
      event: index === 0 ? "minted" : "narrowed",
    }),
    event("pr-description.chat.turn.admitted", correlationId, { relationshipId: "rel-1" }),
    event("coding-runtime.description-authority", correlationId, { event: "narrowed" }),
    event("pr-description.chat.turn.admitted", correlationId, { relationshipId: "rel-1" }),
    event("git.snapshot.capture", correlationId),
    event("git.snapshot.read", correlationId),
    event("pr-description.generation.started", correlationId),
    event("gateway.chat.started", correlationId, {
      requestId: `gateway-${String(index)}`,
      streaming: false,
    }),
    event("gateway.chat.completed", correlationId, {
      requestId: `gateway-${String(index)}`,
      streaming: false,
    }),
    event("pr-description.generation.completed", correlationId),
    event("pr-description.chat.generated", correlationId),
    event("git.pr-description", correlationId, { phase: "preview", effect: "none" }),
    event("sse.stream.closed", correlationId),
  ]);
}

describe("Git-connected Chat negative effect surface", () => {
  it("probes the real mounted mutation surfaces and observes every request denied", async () => {
    const requested: string[] = [];
    const request = {
      post: (path: string): Promise<APIResponse> => {
        requested.push(path);
        return Promise.resolve({ status: (): number => 400 } as APIResponse);
      },
    } as unknown as APIRequestContext;

    await expect(assertMalformedEffectRequestsRejected(request)).resolves.toBe(
      "malformed-effect-requests-rejected:9",
    );
    expect(requested).toEqual([
      "/api/git-delivery/local-branch/create",
      "/api/git-delivery/local-branch/switch",
      "/api/git-delivery/commit/execute",
      "/api/git-delivery/push/execute",
      "/api/git-delivery/pr/execute",
      "/api/git-delivery/merge/execute",
      "/api/git-delivery/pull/execute",
      "/api/commands/runs",
      "/api/coding-sidecar/gateway/chat/completions",
    ]);
  });

  it("fails when any real forbidden effect endpoint accepts the empty untrusted request", async () => {
    let requestCount = 0;
    const request = {
      post: (): Promise<APIResponse> => {
        requestCount += 1;
        return Promise.resolve({
          status: (): number => (requestCount === 4 ? 200 : 400),
        } as APIResponse);
      },
    } as unknown as APIRequestContext;

    await expect(assertMalformedEffectRequestsRejected(request)).rejects.toThrow(
      "malformed effect request succeeded",
    );
  });

  it("fails when the actual connected multi-turn browser action reaches an effect route", async () => {
    const events = new EventEmitter();
    const page = events as unknown as Page;
    const forbiddenRequest = {
      url: (): string => "http://127.0.0.1/api/git-delivery/pull/execute",
    } as Request;

    await expect(
      observeNoForbiddenSessionRequests(page, () => {
        events.emit("request", forbiddenRequest);
        return Promise.resolve();
      }),
    ).rejects.toThrow("Git-connected Chat invoked a forbidden effect boundary");
    expect(events.listenerCount("request")).toBe(0);
  });

  it("binds every completed Chat turn to the exact chat and connected relationship", () => {
    expect(
      assertNoForbiddenSessionToolEvents({
        chatId: "chat-1",
        relationshipId: "rel-1",
        expectedTurnCount: 2,
        requests: TURN_REQUESTS,
        activityEvents: completedTurnEvents(),
      }),
    ).toBe("no-forbidden-session-tool-events:true");
  });

  it("collects real Chat stream correlation headers and joins their activity log records", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-git-chat-activity-"));
    const activityLog = join(root, "server.log");
    const previousPath = process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH;
    process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH = activityLog;
    writeFileSync(
      activityLog,
      `${completedTurnEvents()
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
    const events = new EventEmitter();
    const page = events as unknown as Page;
    try {
      const observed = await observeBoundGitChatSessionActivity(
        page,
        { chatId: "chat-1", relationshipId: "rel-1" },
        2,
        () => {
          for (const { chatId, correlationId } of TURN_REQUESTS) {
            events.emit("request", {
              url: (): string => "http://127.0.0.1/api/desktop/chat/stream",
              postData: (): string => JSON.stringify({ chatId }),
              headers: (): Readonly<Record<string, string>> => ({
                "x-keiko-correlation-id": correlationId,
              }),
            });
          }
          return Promise.resolve("completed");
        },
      );
      expect(observed).toEqual({
        result: "completed",
        assertion: "no-forbidden-session-tool-events:true",
      });
      expect(events.listenerCount("request")).toBe(0);
    } finally {
      if (previousPath === undefined) delete process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH;
      else process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a session whose real stream requests were not observed", () => {
    expect(() =>
      assertNoForbiddenSessionToolEvents({
        chatId: "chat-1",
        relationshipId: "rel-1",
        expectedTurnCount: 2,
        requests: [],
        activityEvents: completedTurnEvents(),
      }),
    ).toThrow("expected number of Chat stream requests");
  });

  it("refuses an admitted turn bound to another connected relationship", () => {
    const activityEvents = completedTurnEvents().map((entry) =>
      entry.correlationId === "chat-turn-correlation-2" &&
      entry.op === "pr-description.chat.turn.admitted"
        ? { ...entry, relationshipId: "rel-other" }
        : entry,
    );
    expect(() =>
      assertNoForbiddenSessionToolEvents({
        chatId: "chat-1",
        relationshipId: "rel-1",
        expectedTurnCount: 2,
        requests: TURN_REQUESTS,
        activityEvents,
      }),
    ).toThrow("exact connected Git relationship");
  });

  it("refuses a turn without a completed buffered Model Gateway call", () => {
    const activityEvents = completedTurnEvents().filter(
      (entry) =>
        entry.correlationId !== "chat-turn-correlation-2" || entry.op !== "gateway.chat.completed",
    );
    expect(() =>
      assertNoForbiddenSessionToolEvents({
        chatId: "chat-1",
        relationshipId: "rel-1",
        expectedTurnCount: 2,
        requests: TURN_REQUESTS,
        activityEvents,
      }),
    ).toThrow("completed buffered Model Gateway call");
  });

  it.each(["git.snapshot.capture", "coding-runtime.description-authority"])(
    "accepts the production description-only %s operation",
    (allowedOp) => {
      const matching = completedTurnEvents().filter((entry) => entry.op === allowedOp);
      expect(matching.length).toBeGreaterThan(0);
      expect(() =>
        assertNoForbiddenSessionToolEvents({
          chatId: "chat-1",
          relationshipId: "rel-1",
          expectedTurnCount: 2,
          requests: TURN_REQUESTS,
          activityEvents: completedTurnEvents(),
        }),
      ).not.toThrow();
    },
  );

  it("refuses forbidden server-side tool activity in the observed Chat correlation", () => {
    const activityEvents = [
      ...completedTurnEvents(),
      event("git.delivery.mutation.completed", "chat-turn-correlation-2"),
    ];
    expect(() =>
      assertNoForbiddenSessionToolEvents({
        chatId: "chat-1",
        relationshipId: "rel-1",
        expectedTurnCount: 2,
        requests: TURN_REQUESTS,
        activityEvents,
      }),
    ).toThrow("forbidden server-side tool activity");
  });

  it("refuses forbidden tool activity spawned under a child correlation", () => {
    const activityEvents = [
      ...completedTurnEvents(),
      event("git.delivery.mutation.completed", "child-effect-correlation", {
        parentCorrelationId: "chat-turn-correlation-2",
      }),
    ];
    expect(() =>
      assertNoForbiddenSessionToolEvents({
        chatId: "chat-1",
        relationshipId: "rel-1",
        expectedTurnCount: 2,
        requests: TURN_REQUESTS,
        activityEvents,
      }),
    ).toThrow("forbidden server-side tool activity");
  });
});
