import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { APIRequestContext, APIResponse, Page, Request } from "@playwright/test";
import {
  assertMalformedEffectRequestsRejected,
  observeNoForbiddenSessionRequests,
} from "./coding-issue-journey-live-git-chat-negative.js";

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
});
