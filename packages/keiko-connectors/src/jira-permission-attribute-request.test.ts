import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { jiraPermissionAttributeRequest } from "./jira-permission-attribute-request.js";

function fixture(allowed = true) {
  const http = vi.fn<AtlassianHttpBodyPort>(() => Promise.resolve({
    kind: "response", status: 204, bodyText: "", bodyBytes: 0, truncated: false,
  }));
  const beforeEffect = vi.fn(() => allowed);
  const controller = new AbortController();
  const context = { invocationId: "permission-attribute", correlationId: "permission-attribute",
    signal: controller.signal, beforeEffect };
  const connection = { deployment: "data-center" as const, baseUrl: "https://jira.example.invalid/context", http };
  return { http, beforeEffect, controller, request: jiraPermissionAttributeRequest(connection, context) };
}
describe("fixed native permission attribute boolean transport", () => {
  it.each([true, false])("sends %s as plain native bytes on exactly one fixed PUT", async (value) => {
    const f = fixture();
    expect(await f.request("9223372036854775807", "selected-attribute", value))
      .toEqual({ ok: true, status: 204, body: undefined });
    expect(f.http).toHaveBeenCalledOnce();
    expect(f.http.mock.calls[0]?.[0]).toMatchObject({
      method: "PUT", url: "https://jira.example.invalid/context/rest/api/2/permissionscheme/9223372036854775807/attribute/selected-attribute",
      bodyJson: String(value), jiraPermissionAttribute: true,
    });
    expect(f.http.mock.calls[0]?.[0]).not.toHaveProperty("jiraExperimental");
    expect(f.beforeEffect).toHaveBeenCalledOnce();
  });
  it.each([
    { id: "0", key: "selected" }, { id: "01", key: "selected" },
    { id: "9223372036854775808", key: "selected" },
    { id: "7", key: "" }, { id: "7", key: "../other" },
    { id: "7", key: "selected/other" }, { id: "7", key: "%2fescape" },
  ])("refuses invalid selector $id/$key before admission and HTTP", async ({ id, key }) => {
    const f = fixture();
    expect(await f.request(id, key, false)).toEqual({ ok: false, reason: "field-validation" });
    expect(f.http).not.toHaveBeenCalled();
    expect(f.beforeEffect).not.toHaveBeenCalled();
  });
  it("encodes a valid native attribute key exactly once", async () => {
    const f = fixture();
    expect(await f.request("7", "prüfstand.enabled", false)).toMatchObject({ ok: true });
    expect(f.http.mock.calls[0]?.[0].url)
      .toBe("https://jira.example.invalid/context/rest/api/2/permissionscheme/7/attribute/pr%C3%BCfstand.enabled");
  });
  it("classifies refused authority locally without a fabricated native status", async () => {
    const f = fixture(false);
    expect(await f.request("7", "selected", true)).toEqual({ ok: false, reason: "effect-denied" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("classifies caller cancellation before any native request", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await f.request("7", "selected", true)).toEqual({ ok: false, reason: "cancelled" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("never retries the PUT after an acknowledgement is lost", async () => {
    const f = fixture();
    f.http.mockResolvedValue({ kind: "timeout" });
    expect(await f.request("7", "selected", false)).toEqual({ ok: false, reason: "timeout" });
    expect(f.http).toHaveBeenCalledOnce();
  });
});
