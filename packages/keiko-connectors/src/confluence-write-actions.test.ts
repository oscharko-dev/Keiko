// Hermetic tests for the governed Confluence write executors (Issue #2244). The transport port
// is a scripted fixture; assertions cover the exact v2 endpoints, escaped storage-format bodies,
// the optimistic version bump with its typed conflict, and content-freedom.

import { describe, expect, it } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  addConfluencePageComment,
  createConfluencePage,
  updateConfluencePage,
  type ConfluenceWriteActionDeps,
} from "./confluence-write-actions.js";

const BASE = "https://example.atlassian.net";

function response(status: number, bodyText = "{}"): AtlassianHttpBodyResult {
  return { kind: "response", status, bodyText, bodyBytes: bodyText.length, truncated: false };
}

function scripted(results: readonly AtlassianHttpBodyResult[]): {
  deps: ConfluenceWriteActionDeps;
  requests: AtlassianHttpBodyRequest[];
} {
  const requests: AtlassianHttpBodyRequest[] = [];
  const queue = [...results];
  const port: AtlassianHttpBodyPort = (request) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted port exhausted");
    return Promise.resolve(next);
  };
  return { deps: { http: port, baseUrl: BASE }, requests };
}

describe("createConfluencePage", () => {
  it("POSTs /wiki/api/v2/pages with the escaped storage body and returns id + version", async () => {
    const { deps, requests } = scripted([response(200, '{"id":"123","version":{"number":1}}')]);
    const result = await createConfluencePage(deps, {
      spaceId: "777",
      parentId: "555",
      title: "Runbook",
      bodyText: "Steps & notes\n\n- first < second",
    });
    expect(result).toEqual({ ok: true, pageId: "123", version: 1 });
    expect(requests[0]).toMatchObject({ method: "POST", url: `${BASE}/wiki/api/v2/pages` });
    expect(JSON.parse(requests[0]?.bodyJson ?? "{}")).toEqual({
      spaceId: "777",
      status: "current",
      title: "Runbook",
      parentId: "555",
      body: {
        representation: "storage",
        value: "<p>Steps &amp; notes</p><ul><li>first &lt; second</li></ul>",
      },
    });
  });

  it("rejects invalid ids and titles as field-validation without a port call", async () => {
    const { deps, requests } = scripted([]);
    expect(await createConfluencePage(deps, { spaceId: "ENG", title: "T", bodyText: "b" })).toEqual(
      { ok: false, reason: "field-validation" },
    );
    expect(
      await createConfluencePage(deps, {
        spaceId: "777",
        parentId: "x",
        title: "T",
        bodyText: "b",
      }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(await createConfluencePage(deps, { spaceId: "777", title: "", bodyText: "b" })).toEqual({
      ok: false,
      reason: "field-validation",
    });
    expect(requests).toHaveLength(0);
  });

  it("maps provider failures typed and content-free", async () => {
    const { deps } = scripted([response(403, '{"detail":"space is read-only for you"}')]);
    const result = await createConfluencePage(deps, { spaceId: "777", title: "T", bodyText: "b" });
    expect(result).toEqual({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect(JSON.stringify(result)).not.toContain("read-only");
  });
});

describe("updateConfluencePage — optimistic version bump", () => {
  it("PUTs /wiki/api/v2/pages/{id} with version = currentVersion + 1", async () => {
    const { deps, requests } = scripted([response(200, '{"id":"123","version":{"number":5}}')]);
    const result = await updateConfluencePage(deps, {
      pageId: "123",
      title: "Runbook v2",
      bodyText: "updated",
      currentVersion: 4,
    });
    expect(result).toEqual({ ok: true, pageId: "123", version: 5 });
    expect(requests[0]).toMatchObject({ method: "PUT", url: `${BASE}/wiki/api/v2/pages/123` });
    expect(JSON.parse(requests[0]?.bodyJson ?? "{}")).toEqual({
      id: "123",
      status: "current",
      title: "Runbook v2",
      body: { representation: "storage", value: "<p>updated</p>" },
      version: { number: 5 },
    });
  });

  it("maps the provider 409 to the typed conflict result (Scope 4)", async () => {
    const { deps } = scripted([response(409, '{"detail":"version conflict"}')]);
    const result = await updateConfluencePage(deps, {
      pageId: "123",
      title: "T",
      bodyText: "b",
      currentVersion: 4,
    });
    expect(result).toEqual({ ok: false, reason: "conflict", httpStatus: 409 });
    expect(JSON.stringify(result)).not.toContain("version conflict");
  });

  it("rejects a non-positive or non-integer currentVersion locally", async () => {
    const { deps, requests } = scripted([]);
    for (const currentVersion of [0, -1, 1.5, Number.NaN]) {
      expect(
        await updateConfluencePage(deps, {
          pageId: "123",
          title: "T",
          bodyText: "b",
          currentVersion,
        }),
      ).toEqual({ ok: false, reason: "field-validation" });
    }
    expect(requests).toHaveLength(0);
  });
});

describe("addConfluencePageComment", () => {
  it("POSTs /wiki/api/v2/footer-comments with the escaped storage body", async () => {
    const { deps, requests } = scripted([response(201, '{"id":"9001"}')]);
    const result = await addConfluencePageComment(deps, {
      pageId: "123",
      commentText: "Looks good <now>",
    });
    expect(result).toEqual({ ok: true, commentId: "9001" });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/wiki/api/v2/footer-comments`,
    });
    expect(JSON.parse(requests[0]?.bodyJson ?? "{}")).toEqual({
      pageId: "123",
      body: { representation: "storage", value: "<p>Looks good &lt;now&gt;</p>" },
    });
  });

  it("classifies a malformed created-comment payload typed", async () => {
    const { deps } = scripted([response(201, '{"id":"not numeric"}')]);
    expect(await addConfluencePageComment(deps, { pageId: "123", commentText: "hi" })).toEqual({
      ok: false,
      reason: "malformed-payload",
      httpStatus: 201,
    });
  });

  it("maps rate limiting typed after the transport surfaced it", async () => {
    const { deps } = scripted([response(429, "{}")]);
    expect(await addConfluencePageComment(deps, { pageId: "123", commentText: "hi" })).toEqual({
      ok: false,
      reason: "rate-limited",
      httpStatus: 429,
    });
  });
});
