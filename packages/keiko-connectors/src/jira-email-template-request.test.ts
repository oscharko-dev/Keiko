import { describe, expect, it, vi, type Mock } from "vitest";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { jiraEmailTemplateRequest } from "./jira-email-template-request.js";

interface EmailFixture {
  readonly bytes: Uint8Array;
  readonly http: Mock<AtlassianHttpBodyPort>;
  readonly beforeEffect: Mock<() => boolean>;
  readonly controller: AbortController;
  readonly request: ReturnType<typeof jiraEmailTemplateRequest>;
}
function fixture(allowed = true): EmailFixture {
  const bytes = new Uint8Array([0x50, 0x4b, 0, 0xff, 0xc0, 0x80]);
  const http = vi.fn<AtlassianHttpBodyPort>(() =>
    Promise.resolve({
      kind: "response",
      status: 200,
      bodyText: "",
      bodyBytes: bytes.byteLength,
      archiveBytes: bytes,
      truncated: false,
    }),
  );
  const beforeEffect = vi.fn(() => allowed);
  const controller = new AbortController();
  const context = {
    invocationId: "email-template",
    correlationId: "email-template",
    signal: controller.signal,
    beforeEffect,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return {
    bytes,
    http,
    beforeEffect,
    controller,
    request: jiraEmailTemplateRequest(connection, context),
  };
}
describe("fixed email-template archive request constructor", () => {
  it("keeps non-UTF8 bytes exact and carries no model selector or header", async () => {
    const f = fixture();
    expect(await f.request.download()).toEqual({ ok: true, status: 200, bytes: f.bytes });
    expect(f.http).toHaveBeenCalledOnce();
    expect(f.http.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: "https://jira.example.invalid/context/rest/api/2/email-templates",
      jiraEmailTemplateArchive: true,
      maxBodyBytes: JIRA_ATTACHMENT_MAX_BYTES,
    });
    expect(f.http.mock.calls[0]?.[0]).not.toHaveProperty("upload");
    expect(f.http.mock.calls[0]?.[0]).not.toHaveProperty("bodyJson");
    expect(f.beforeEffect).toHaveBeenCalledOnce();
  });
  it("copies the selected upload before admission and sends one raw ZIP POST", async () => {
    const f = fixture();
    const selected = new Uint8Array(f.bytes);
    const original = new Uint8Array(selected);
    f.beforeEffect.mockImplementation(() => {
      selected.fill(0);
      return true;
    });
    f.http.mockResolvedValue({
      kind: "response",
      status: 204,
      bodyText: "",
      bodyBytes: 0,
      truncated: false,
    });
    expect(await f.request.upload(selected)).toEqual({ ok: true, status: 204, body: undefined });
    const sent = f.http.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      method: "POST",
      jiraEmailTemplateArchive: true,
      upload: { contentType: "application/zip", bytes: original },
      timeoutMs: 60_000,
    });
    expect(sent?.upload?.bytes).not.toBe(selected);
    expect(sent?.upload?.bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(sent).not.toHaveProperty("bodyJson");
  });
  it("refuses oversized bytes before admission or transport", async () => {
    const f = fixture();
    expect(await f.request.upload(new Uint8Array(JIRA_ATTACHMENT_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: "bounds-exceeded",
    });
    expect(f.beforeEffect).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });
  it("does not replay a POST after a lost acknowledgement", async () => {
    const f = fixture();
    f.http.mockResolvedValue({ kind: "timeout" });
    expect(await f.request.upload(f.bytes)).toEqual({ ok: false, reason: "timeout" });
    expect(f.http).toHaveBeenCalledOnce();
  });
  it("preserves the observed late POST acknowledgement over cancellation", async () => {
    const f = fixture();
    f.http.mockImplementation(() => {
      f.controller.abort();
      return Promise.resolve({
        kind: "response",
        status: 202,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    });
    expect(await f.request.upload(f.bytes)).toEqual({ ok: true, status: 202, body: undefined });
    expect(f.http).toHaveBeenCalledOnce();
  });
  it("refuses authority locally without inventing Jira permission failure", async () => {
    const f = fixture(false);
    expect(await f.request.download()).toEqual({ ok: false, reason: "effect-denied" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("classifies cancellation before either GET or POST without transport", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await f.request.download()).toEqual({ ok: false, reason: "cancelled" });
    expect(await f.request.upload(f.bytes)).toEqual({ ok: false, reason: "cancelled" });
    expect(f.http).not.toHaveBeenCalled();
  });
});
