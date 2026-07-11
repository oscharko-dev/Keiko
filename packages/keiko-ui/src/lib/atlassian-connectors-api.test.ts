// Issue #2245 — the Atlassian connector BFF client: correct routes/methods, CSRF on mutations,
// body-safe typed errors, unwrapped list envelopes, and the write-only token contract (the token
// rides the create request body once and is absent from every response type).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  approveAtlassianConnectorAction,
  cancelAtlassianConnectorSyncJob,
  createAtlassianConnector,
  defaultAtlassianConnectorsClient,
  deleteAtlassianConnector,
  getAtlassianConnectorApproval,
  getAtlassianConnectorSyncJob,
  listAtlassianConnectorActivity,
  listAtlassianConnectorApprovals,
  listAtlassianConnectors,
  rejectAtlassianConnectorAction,
  startAtlassianConnectorSync,
  verifyAtlassianConnector,
} from "./atlassian-connectors-api";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function makeRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (): string | null => null },
    json: async (): Promise<unknown> => body,
  } as unknown as Response;
}

function stubFetch(status: number, body: unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const impl = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(makeRes(status, body));
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

const METADATA = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "confluence",
  displayName: "Docs",
  baseUrl: "https://x.atlassian.net",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atlassian-connectors-api — routes and methods", () => {
  it("lists connectors and unwraps the credentials envelope", async () => {
    const calls = stubFetch(200, { credentials: [METADATA] });
    const result = await listAtlassianConnectors();
    expect(result).toEqual([METADATA]);
    expect(calls[0]?.url).toBe("/api/atlassian-connectors/credentials");
    expect(calls[0]?.method).toBe("GET");
  });

  it("verifies with the closed status union and encodes the authRef", async () => {
    const calls = stubFetch(200, { authRef: METADATA.authRef, status: "auth-failed" });
    const result = await verifyAtlassianConnector(METADATA.authRef);
    expect(result.status).toBe("auth-failed");
    expect(calls[0]?.url).toBe(
      `/api/atlassian-connectors/credentials/${encodeURIComponent(METADATA.authRef)}/verify`,
    );
    expect(calls[0]?.method).toBe("POST");
  });

  it("starts a sync, cancels a job, lists approvals, approves and rejects on the right routes", async () => {
    stubFetch(202, { job: { jobId: "j1", status: "pending" } });
    await startAtlassianConnectorSync(METADATA.authRef, { spaceKeys: ["ENG"] });
    const cancelCalls = stubFetch(202, { job: { jobId: "j1", status: "cancelled" } });
    await cancelAtlassianConnectorSyncJob("j1");
    expect(cancelCalls[0]?.url).toBe("/api/atlassian-connectors/sync-jobs/j1/cancel");
    const listCalls = stubFetch(200, { approvals: [] });
    await listAtlassianConnectorApprovals();
    expect(listCalls[0]?.url).toBe("/api/atlassian-connectors/action-approvals");
    const approveCalls = stubFetch(200, {
      disposition: "review-required",
      result: { status: "succeeded" },
    });
    await approveAtlassianConnectorAction("ap1");
    expect(approveCalls[0]?.url).toBe("/api/atlassian-connectors/action-approvals/ap1/approve");
    const rejectCalls = stubFetch(200, {
      approvalId: "ap1",
      disposition: "review-required",
      outcome: "cancelled",
    });
    await rejectAtlassianConnectorAction("ap1");
    expect(rejectCalls[0]?.url).toBe("/api/atlassian-connectors/action-approvals/ap1/reject");
  });

  it("reads a sync job, connector activity, and one approval on the right GET routes", async () => {
    const jobCalls = stubFetch(200, { job: { jobId: "j1", status: "running" } });
    await getAtlassianConnectorSyncJob("j1");
    expect(jobCalls[0]?.url).toBe("/api/atlassian-connectors/sync-jobs/j1");
    expect(jobCalls[0]?.method).toBe("GET");
    const activityCalls = stubFetch(200, { activity: [] });
    await listAtlassianConnectorActivity(METADATA.authRef);
    expect(activityCalls[0]?.url).toBe(
      `/api/atlassian-connectors/credentials/${encodeURIComponent(METADATA.authRef)}/activity`,
    );
    const approvalCalls = stubFetch(200, { approval: { approvalId: "ap1" } });
    await getAtlassianConnectorApproval("ap1");
    expect(approvalCalls[0]?.url).toBe("/api/atlassian-connectors/action-approvals/ap1");
  });

  it("starts a Jira sync with the project scope body and exposes a bound default client", async () => {
    const calls = stubFetch(202, { job: { jobId: "j1", status: "pending" } });
    await startAtlassianConnectorSync(METADATA.authRef, {
      projectKeys: ["PROJ"],
      jql: "updated >= -1d",
    });
    expect(calls[0]?.url).toBe(
      `/api/atlassian-connectors/credentials/${encodeURIComponent(METADATA.authRef)}/sync-jobs`,
    );
    expect(calls[0]?.body).toContain("PROJ");
    expect(calls[0]?.body).toContain("updated >= -1d");
    expect(typeof defaultAtlassianConnectorsClient.listConnectors).toBe("function");
    expect(typeof defaultAtlassianConnectorsClient.getApproval).toBe("function");
  });

  it("sends the CSRF header and JSON content-type on state-changing requests", async () => {
    const calls = stubFetch(200, { ok: true });
    await deleteAtlassianConnector(METADATA.authRef);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers["X-Keiko-CSRF"]).toBe("1");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });
});

describe("atlassian-connectors-api — write-only token", () => {
  it("sends the token in the create request body exactly once and never returns it", async () => {
    const calls = stubFetch(200, METADATA);
    const metadata = await createAtlassianConnector({
      provider: "confluence",
      displayName: "Docs",
      baseUrl: "https://x.atlassian.net",
      accountEmail: "me@example.com",
      apiToken: "s3cr3t-token",
    });
    // The create request is the ONE hop the token makes.
    expect(calls[0]?.body).toContain("s3cr3t-token");
    // The returned metadata carries no token field.
    expect(JSON.stringify(metadata)).not.toContain("s3cr3t-token");
    expect((metadata as unknown as Record<string, unknown>).apiToken).toBeUndefined();
  });
});

describe("atlassian-connectors-api — body-safe errors", () => {
  it("throws a typed ApiError from the error envelope without leaking a raw body", async () => {
    stubFetch(400, { error: { code: "VALIDATION_FAILED", message: "baseUrl invalid" } });
    await expect(verifyAtlassianConnector(METADATA.authRef)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "baseUrl invalid",
      status: 400,
    });
  });

  it("uses a friendly message when the error body is not a parseable envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((): Promise<Response> =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: (): string | null => null },
          json: (): Promise<unknown> => Promise.reject(new Error("not json")),
        } as unknown as Response),
      ),
    );
    const error = await listAtlassianConnectors().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain("HTTP 500");
    expect((error as ApiError).code).toBe("INTERNAL");
  });
});
