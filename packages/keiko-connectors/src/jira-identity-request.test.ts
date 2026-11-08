import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { jiraIdentityRequests } from "./jira-identity-request.js";
import { jiraProjectLifecycleRequests } from "./jira-project-lifecycle-request.js";

function fixture() {
  const http = vi.fn<AtlassianHttpBodyPort>(() =>
    Promise.resolve({
      kind: "response",
      status: 204,
      bodyText: "",
      bodyBytes: 0,
      truncated: false,
    }),
  );
  const beforeEffect = vi.fn(() => true);
  const controller = new AbortController();
  const context = {
    invocationId: "fixed-native",
    correlationId: "fixed-native",
    signal: controller.signal,
    beforeEffect,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return {
    http,
    beforeEffect,
    controller,
    identity: jiraIdentityRequests(connection, context),
    project: jiraProjectLifecycleRequests(connection, context),
  };
}
describe("fixed native identity/project experimental constructors", () => {
  it("preserves status-only user update/delete ACKs and exact key selectors without inventing JSON", async () => {
    const f = fixture();
    expect(await f.identity.user("PUT", "native-key", { active: false })).toEqual({
      ok: true,
      status: 204,
    });
    expect(await f.identity.user("DELETE", "native-key", undefined)).toEqual({
      ok: true,
      status: 204,
    });
    expect(
      f.http.mock.calls.map(([request]) => [
        request.method,
        request.url,
        request.bodyJson,
        request.jiraIdentityExperimental,
      ]),
    ).toEqual([
      [
        "PUT",
        "https://jira.example.invalid/context/rest/api/2/user?key=native-key",
        '{"active":false}',
        true,
      ],
      [
        "DELETE",
        "https://jira.example.invalid/context/rest/api/2/user?key=native-key",
        undefined,
        true,
      ],
    ]);
  });
  it("reads the create ACK identity but sends no model password or optional native defaults", async () => {
    const f = fixture();
    const bodyText = '{"key":"new-key","name":"Native Name"}';
    f.http.mockResolvedValue({
      kind: "response",
      status: 201,
      bodyText,
      bodyBytes: bodyText.length,
      truncated: false,
    });
    expect(
      await f.identity.user("POST", undefined, {
        name: "Native Name",
        displayName: "Native Display",
        emailAddress: "synthetic@example.invalid",
      }),
    ).toMatchObject({ ok: true, body: { key: "new-key" } });
    expect(f.http.mock.calls[0]?.[0]?.bodyJson).toBe(
      '{"name":"Native Name","displayName":"Native Display","emailAddress":"synthetic@example.invalid"}',
    );
  });
  it("binds exact project path IDs and rejects unsafe numeric scheme bodies before admission", async () => {
    const f = fixture();
    expect(await f.project.priority.assign("9007199254740993", "7")).toMatchObject({ ok: true });
    expect(
      await f.project.priority.remove("9007199254740993", "9223372036854775807"),
    ).toMatchObject({ ok: true });
    expect(f.http.mock.calls[0]?.[0]).toMatchObject({
      method: "PUT",
      url: "https://jira.example.invalid/context/rest/api/2/project/9007199254740993/priorityscheme",
      bodyJson: '{"id":7}',
      jiraProjectPriority: true,
    });
    expect(f.http.mock.calls[1]?.[0]).toMatchObject({
      method: "DELETE",
      url: "https://jira.example.invalid/context/rest/api/2/project/9007199254740993/priorityscheme/9223372036854775807",
    });
    f.http.mockClear();
    f.beforeEffect.mockClear();
    expect(await f.project.priority.assign("7", "9007199254740993")).toMatchObject({ ok: false });
    expect(await f.project.priority.remove("../7", "8")).toMatchObject({ ok: false });
    expect(f.http).not.toHaveBeenCalled();
    expect(f.beforeEffect).not.toHaveBeenCalled();
  });
  it("does not replay writes after a lost response, and retains real late ACKs", async () => {
    const f = fixture();
    f.http.mockResolvedValue({ kind: "timeout" });
    expect(await f.identity.user("DELETE", "native-key", undefined)).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(f.http).toHaveBeenCalledOnce();
    const acknowledged = fixture();
    acknowledged.http.mockImplementation(() => {
      acknowledged.controller.abort();
      return Promise.resolve({
        kind: "response",
        status: 202,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      });
    });
    expect(await acknowledged.project.priority.remove("7", "8")).toMatchObject({
      ok: true,
      status: 202,
    });
    expect(acknowledged.http).toHaveBeenCalledOnce();
  });
});
