import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { jiraReciprocalConfigurationRequests } from "./jira-reciprocal-configuration-request.js";

describe("fixed local application-link prerequisites", () => {
  it("uses only two fixed same-host context-preserving JSON GETs", async () => {
    const http = vi.fn<AtlassianHttpBodyPort>().mockResolvedValue({
      kind: "response",
      status: 200,
      bodyText: "{}",
      bodyBytes: 2,
      truncated: false,
    });
    const context = {
      invocationId: "synthetic",
      correlationId: "synthetic",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    };
    const ports = jiraReciprocalConfigurationRequests(
      { baseUrl: "https://local.example.invalid/context", deployment: "data-center", http },
      context,
    );
    await ports.manifest();
    await ports.applicationLinks();
    expect(http.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
      ["GET", "https://local.example.invalid/context/rest/applinks/1.0/manifest"],
      ["GET", "https://local.example.invalid/context/rest/applinks/1.0/listApplicationlinks"],
    ]);
    for (const [request] of http.mock.calls) expect(request.bodyJson).toBeUndefined();
  });
  it("rechecks current request authority and cancellation without a remote request", async () => {
    const http = vi.fn<AtlassianHttpBodyPort>();
    const controller = new AbortController();
    const ports = jiraReciprocalConfigurationRequests(
      { baseUrl: "https://local.example.invalid/context", deployment: "data-center", http },
      {
        invocationId: "synthetic",
        correlationId: "synthetic",
        signal: controller.signal,
        beforeEffect: () => false,
      },
    );
    expect(await ports.applicationLinks()).toEqual({ ok: false, reason: "effect-denied" });
    controller.abort();
    expect(await ports.manifest()).toEqual({ ok: false, reason: "cancelled" });
    expect(http).not.toHaveBeenCalled();
  });
});
