import { describe, expect, it, vi } from "vitest";
import {
  ATLASSIAN_HTTP_UPLOAD_MAX_BYTES,
  ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
  AtlassianCredentialCustodyError,
  type AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { atlassianHttpRequestLifecycle } from "./httpRequestLifecycle.js";

const BASE = "https://acme.example/context";
const BYTES = new Uint8Array([0x50, 0x4b, 0, 0xff, 0xc0, 0x80]);
const REQUEST: AtlassianHttpBodyRequest = {
  method: "GET",
  url: `${BASE}/rest/api/2/email-templates`,
  timeoutMs: 1000,
  maxBodyBytes: 64,
  jiraEmailTemplateArchive: true,
};
function lifecycleOptions() {
  return {
    authRef: "synthetic-email-template-reference",
    correlationId: "email-template",
    beforeDispatch: vi.fn(() => true),
    onResponse: vi.fn(() => true),
    credentials: {
      resolveForExecution: vi.fn(() => ({
        scheme: "bearer-pat" as const,
        apiToken: "synthetic-email-template-token",
      })),
    },
  };
}
function fixture(
  response: () => Response = () =>
    new Response(new Uint8Array(BYTES), { headers: { "content-type": "application/zip" } }),
) {
  const options = lifecycleOptions();
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  return {
    ...options,
    fetchImpl,
    port: createGatewayAtlassianHttpBodyPort({ ...options, baseUrl: BASE, fetchImpl }),
  };
}
describe("fixed email-template archive HTTP transport", () => {
  it("reads non-UTF8 bytes exactly under the configured Jira context and closed Accept header", async () => {
    const f = fixture();
    expect(await f.port(REQUEST)).toEqual({
      kind: "response",
      status: 200,
      bodyText: "",
      archiveBytes: BYTES,
      bodyBytes: BYTES.byteLength,
      truncated: false,
    });
    const sent = f.fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(sent?.headers).get("accept")).toBe("application/zip");
    expect(new Headers(sent?.headers).has("x-atlassian-token")).toBe(false);
    expect(f.beforeDispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ jiraEmailTemplateArchive: true }),
    );
    expect(f.onResponse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ method: "GET" }),
      200,
    );
  });
  it("caps binary streaming without decoding, returning truncated evidence instead of a complete archive", async () => {
    const cancelled = vi.fn();
    const f = fixture(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0x50, 0x4b, 0xff, 0x80, 1, 2]));
            },
            cancel: cancelled,
          }),
          { headers: { "content-type": "application/zip" } },
        ),
    );
    expect(await f.port({ ...REQUEST, maxBodyBytes: 4 })).toMatchObject({
      bodyText: "",
      bodyBytes: 4,
      archiveBytes: new Uint8Array([0x50, 0x4b, 0xff, 0x80]),
      truncated: true,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("keeps the existing exact-cap refusal instead of claiming unobserved stream completion", async () => {
    const f = fixture();
    expect(await f.port({ ...REQUEST, maxBodyBytes: BYTES.byteLength })).toMatchObject({
      bodyBytes: BYTES.byteLength,
      archiveBytes: BYTES,
      truncated: true,
    });
  });
  it("never returns a partial archive when the response stream fails after its status is observed", async () => {
    const f = fixture(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("Synthetic incomplete ZIP stream"));
            },
          }),
          { headers: { "content-type": "application/zip" } },
        ),
    );
    expect(await f.port(REQUEST)).toMatchObject({ kind: "network-error" });
    expect(f.onResponse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ method: "GET" }),
      200,
    );
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([undefined, "application/json", "text/html", "application/octet-stream"])(
    "does not decode unsupported download media %s as an archive",
    async (contentType) => {
      const f = fixture(
        () =>
          new Response(new Uint8Array(BYTES), {
            headers: contentType === undefined ? {} : { "content-type": contentType },
          }),
      );
      expect(await f.port(REQUEST)).toEqual({
        kind: "response",
        status: 200,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    },
  );
  it("retains bounded native JSON error bodies and never exposes response headers", async () => {
    const text = '{"errorMessages":["Template archive rejected"]}';
    const f = fixture(
      () =>
        new Response(text, {
          status: 400,
          headers: { "content-type": "application/json", "x-private-value": "hidden" },
        }),
    );
    const result = await f.port({ ...REQUEST, maxBodyBytes: JIRA_ATTACHMENT_MAX_BYTES });
    expect(result).toEqual({
      kind: "response",
      status: 400,
      bodyText: text,
      bodyBytes: text.length,
      truncated: false,
    });
    expect(result).not.toHaveProperty("headers");
    expect(result).not.toHaveProperty("archiveBytes");
  });
  it("applies the ordinary response byte ceiling to archive errors", async () => {
    const f = fixture(
      () => new Response("x".repeat(ATLASSIAN_WRITE_RESPONSE_MAX_BYTES + 1), { status: 400 }),
    );
    const result = await f.port({ ...REQUEST, maxBodyBytes: JIRA_ATTACHMENT_MAX_BYTES });
    expect(result).toMatchObject({
      status: 400,
      bodyBytes: ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
      truncated: true,
    });
    expect(result).not.toHaveProperty("archiveBytes");
  });
  it("copies a raw ZIP upload before awaiting egress and emits no multipart/XSRF header", async () => {
    const f = fixture(() => new Response(null, { status: 204 }));
    const bytes = new Uint8Array(BYTES);
    const pending = f.port({
      ...REQUEST,
      method: "POST",
      upload: { contentType: "application/zip", bytes },
    });
    bytes.fill(0);
    expect(await pending).toMatchObject({ kind: "response", status: 204 });
    const sent = f.fetchImpl.mock.calls[0]?.[1];
    expect(sent?.body).toEqual(BYTES);
    expect(sent?.body).not.toBe(bytes);
    expect(new Headers(sent?.headers).get("content-type")).toBe("application/zip");
    expect(new Headers(sent?.headers).has("x-atlassian-token")).toBe(false);
    expect(f.onResponse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ method: "POST" }),
      204,
    );
  });
  it("records the real upload ACK before a late abort without replay", async () => {
    const controller = new AbortController();
    const options = lifecycleOptions();
    options.onResponse.mockImplementation(() => {
      controller.abort();
      return true;
    });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    const port = createGatewayAtlassianHttpBodyPort({ ...options, baseUrl: BASE, fetchImpl });
    expect(
      await port({
        ...REQUEST,
        method: "POST",
        signal: controller.signal,
        upload: { contentType: "application/zip", bytes: BYTES },
      }),
    ).toMatchObject({ kind: "response", status: 202 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(options.onResponse).toHaveBeenCalledOnce();
  });
  it.each([
    { url: "https://other.example/context/rest/api/2/email-templates" },
    { url: "https://acme.example/rest/api/2/email-templates" },
    { url: `${BASE}/extra/rest/api/2/email-templates` },
    { url: `${REQUEST.url}/other` },
    { url: `${REQUEST.url}/` },
    { url: `${REQUEST.url}?download=true` },
    { url: `${REQUEST.url}#fragment` },
    { url: "https://acme.example/context%2fextra/rest/api/2/email-templates" },
    { method: "PUT" },
    { method: "DELETE" },
    { method: "POST" },
    { bodyJson: "{}" },
    { jiraExperimental: true },
    { jiraPermissionAttribute: true },
    { maxBodyBytes: 0 },
    { maxBodyBytes: Number.NaN },
    { maxBodyBytes: JIRA_ATTACHMENT_MAX_BYTES + 1 },
    { upload: { contentType: "application/zip", bytes: BYTES } },
    { method: "POST", upload: { contentType: "application/zip; charset=utf-8", bytes: BYTES } },
    {
      method: "POST",
      upload: { contentType: "multipart/form-data; boundary=synthetic", bytes: BYTES },
    },
  ] satisfies readonly Partial<AtlassianHttpBodyRequest>[])(
    "rejects invalid target/body/media/bounds before dispatch and custody",
    async (override) => {
      const f = fixture();
      await expect(f.port({ ...REQUEST, ...override })).rejects.toBeInstanceOf(
        AtlassianCredentialCustodyError,
      );
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.beforeDispatch).not.toHaveBeenCalled();
      expect(f.credentials.resolveForExecution).not.toHaveBeenCalled();
    },
  );
  it("never admits a ZIP upload on the ordinary unflagged multipart channel", async () => {
    const f = fixture();
    await expect(
      f.port({
        ...REQUEST,
        method: "POST",
        jiraEmailTemplateArchive: undefined,
        upload: { contentType: "application/zip", bytes: BYTES },
      }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
  it("refuses bytes beyond the unchanged upload ceiling before custody", async () => {
    const f = fixture();
    await expect(
      f.port({
        ...REQUEST,
        method: "POST",
        upload: {
          contentType: "application/zip",
          bytes: new Uint8Array(ATLASSIAN_HTTP_UPLOAD_MAX_BYTES + 1),
        },
      }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
  it.each([false, "true", 1, null])(
    "refuses forged archive opt-in %j at lifecycle admission",
    (value) => {
      const options = lifecycleOptions();
      const request = { ...REQUEST };
      Reflect.set(request, "jiraEmailTemplateArchive", value);
      expect(() => atlassianHttpRequestLifecycle(options, request)).toThrow(
        AtlassianCredentialCustodyError,
      );
      expect(options.beforeDispatch).not.toHaveBeenCalled();
      expect(options.credentials.resolveForExecution).not.toHaveBeenCalled();
    },
  );
  it("preserves ordinary JSON response decoding", async () => {
    const f = fixture(
      () => new Response('{"value":false}', { headers: { "content-type": "application/json" } }),
    );
    expect(await f.port({ ...REQUEST, jiraEmailTemplateArchive: undefined })).toEqual({
      kind: "response",
      status: 200,
      bodyText: '{"value":false}',
      bodyBytes: 15,
      truncated: false,
    });
  });
});
