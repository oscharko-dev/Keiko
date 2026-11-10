import { expect, it, vi } from "vitest";
import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  type AtlassianHttpBodyPort,
} from "./atlassian-http-port.js";
import { jiraAgileRequest, jiraAgileRequests } from "./jira-agile-request.js";
import { requestFor } from "./jira-managed-mutations.js";
import { jiraObjectMutationBody } from "./jira-test-request/_support.js";

const OWNERS = [
  { root: "api/2", create: requestFor, path: "issue/10002/properties/keiko" },
  { root: "agile/1.0", create: jiraAgileRequest, path: "board/7/properties/keiko" },
] as const;
const VALUES: readonly CatalogJsonValue[] = [
  false,
  0,
  "",
  null,
  [],
  {},
  { nested: [false, 0, "", null] },
];
function fixture(): {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly controller: AbortController;
  readonly beforeEffect: ReturnType<typeof vi.fn<() => boolean>>;
  readonly connection: Parameters<typeof requestFor>[0];
  readonly context: Parameters<typeof requestFor>[1];
} {
  const http = vi.fn<AtlassianHttpBodyPort>().mockResolvedValue({
    kind: "response",
    status: 204,
    bodyText: "",
    bodyBytes: 0,
    truncated: false,
  });
  const controller = new AbortController();
  const beforeEffect = vi.fn<() => boolean>().mockReturnValue(true);
  return {
    http,
    controller,
    beforeEffect,
    connection: {
      deployment: "data-center" as const,
      baseUrl: "https://jira.example.invalid/context",
      http,
    },
    context: {
      invocationId: "native-json-body",
      correlationId: "native-json-body",
      signal: controller.signal,
      beforeEffect,
    },
  };
}

it.each(OWNERS)("preserves every JSON root on the existing $root body channel", async (owner) => {
  const f = fixture();
  const request = owner.create(f.connection, f.context);
  for (const value of VALUES) {
    expect(await request(owner.path, "PUT", value, "none")).toMatchObject({
      ok: true,
      status: 204,
    });
  }
  expect(f.http.mock.calls.map(([request]) => request.bodyJson)).toEqual(
    VALUES.map((value) => JSON.stringify(value)),
  );
  for (const [call] of f.http.mock.calls) {
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(`https://jira.example.invalid/context/rest/${owner.root}/${owner.path}`);
    expect(call.upload).toBeUndefined();
  }
});

it.each(OWNERS)("distinguishes omitted body from explicit JSON null on $root", async (owner) => {
  const f = fixture();
  const request = owner.create(f.connection, f.context);
  await request(owner.path, "PUT", undefined, "none");
  await request(owner.path, "PUT", null, "none");
  expect(f.http.mock.calls[0]?.[0]).not.toHaveProperty("bodyJson");
  expect(f.http.mock.calls[1]?.[0].bodyJson).toBe("null");
});

it.each(OWNERS)("retains the UTF-8 request ceiling on $root JSON values", async (owner) => {
  const f = fixture();
  const request = owner.create(f.connection, f.context);
  expect(
    await request(owner.path, "PUT", "é".repeat(ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES / 2), "none"),
  ).toEqual({ ok: false, reason: "bounds-exceeded" });
  expect(f.http).not.toHaveBeenCalled();
});

it.each(OWNERS)("keeps scalar bodies off GET and DELETE on $root", async (owner) => {
  const f = fixture();
  const request = owner.create(f.connection, f.context);
  for (const method of ["GET", "DELETE"] as const) {
    expect(await request(owner.path, method, false, "none")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
  }
  expect(f.http).not.toHaveBeenCalled();
});

it.each(OWNERS)("keeps current authority refusal ahead of $root JSON egress", async (owner) => {
  const f = fixture();
  f.beforeEffect.mockReturnValue(false);
  const request = owner.create(f.connection, f.context);
  expect(await request(owner.path, "PUT", false, "none")).toEqual({
    ok: false,
    reason: "effect-denied",
  });
  expect(f.beforeEffect).toHaveBeenCalledOnce();
  expect(f.http).not.toHaveBeenCalled();
});

it.each(OWNERS)("does not retry $root JSON mutations after a server failure", async (owner) => {
  const f = fixture();
  f.http.mockResolvedValue({
    kind: "response",
    status: 503,
    bodyText: "",
    bodyBytes: 0,
    truncated: false,
  });
  const request = owner.create(f.connection, f.context);
  expect(await request(owner.path, "PUT", false, "none")).toMatchObject({
    ok: false,
    reason: "unavailable",
  });
  expect(f.http).toHaveBeenCalledTimes(1);
});

it("does not widen the existing Agile readback phase into a mutation port", async () => {
  const f = fixture();
  const readback = jiraAgileRequests(f.connection, f.context).readback();
  expect(await readback.agile("board/7/properties/keiko", "PUT", false, "none")).toEqual({
    ok: false,
    reason: "unavailable",
  });
  expect(f.http).not.toHaveBeenCalled();
});

it("retains multipart exclusion for a present scalar body", async () => {
  const f = fixture();
  const request = requestFor(f.connection, f.context);
  expect(
    await request("issue/10002/attachments", "POST", false, "none", {
      contentType: "multipart/form-data; boundary=synthetic",
      bytes: new Uint8Array(1),
    }),
  ).toEqual({ ok: false, reason: "malformed-payload" });
  expect(f.http).not.toHaveBeenCalled();
});

it.each([undefined, null, false, 0, "text", []])(
  "keeps object-only native fixtures strict for %j",
  (value) => {
    expect(() => jiraObjectMutationBody(value)).toThrow(TypeError);
  },
);
