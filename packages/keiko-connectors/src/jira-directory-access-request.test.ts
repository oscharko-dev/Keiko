import { describe, expect, it, vi, type Mock } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeAtlassianWriteRequest } from "./atlassian-write-http.js";
import { jiraDirectoryAccessRequests } from "./jira-directory-access-request.js";

const ROLE = { key: "jira-software", groups: ["R&D team"], defaultGroups: ["R&D team"] } as const;
const VERSION = '"native-role-version"';
interface DirectoryFixture {
  readonly http: Mock<AtlassianHttpBodyPort>;
  readonly controller: AbortController;
  readonly beforeEffect: Mock<() => boolean>;
  readonly ports: ReturnType<typeof jiraDirectoryAccessRequests>;
}
function fixture(): DirectoryFixture {
  const http = vi.fn<AtlassianHttpBodyPort>(() =>
    Promise.resolve({
      kind: "response",
      status: 204,
      bodyText: "",
      bodyBytes: 0,
      truncated: false,
    }),
  );
  const controller = new AbortController();
  const beforeEffect = vi.fn(() => true);
  const ports = jiraDirectoryAccessRequests(
    { deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http },
    {
      invocationId: "directory",
      correlationId: "directory",
      signal: controller.signal,
      beforeEffect,
    },
  );
  return { http, controller, beforeEffect, ports };
}
describe("fixed directory native transport constructors", () => {
  it("obtains only the admitted native collection's version and preserves list JSON", async () => {
    const f = fixture();
    const bodyText = JSON.stringify([ROLE]);
    f.http.mockResolvedValue({
      kind: "response",
      status: 200,
      bodyText,
      bodyBytes: bodyText.length,
      truncated: false,
      applicationRoleVersion: VERSION,
    });
    expect(await f.ports.roles.read()).toMatchObject({
      ok: true,
      items: [ROLE],
      applicationRoleVersion: VERSION,
    });
    expect(f.http.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: "https://jira.example.invalid/context/rest/api/2/applicationrole",
      jiraApplicationRole: "version",
    });
    const normal = await executeAtlassianWriteRequest(
      { http: f.http },
      {
        method: "GET",
        url: "https://jira.example.invalid/context/rest/api/2/applicationrole",
        expect: "json-array",
      },
    );
    expect(normal).not.toHaveProperty("applicationRoleVersion");
  });
  it.each([false, true])(
    "uses exact single/bulk shape and a native If-Match token, bulk=%s",
    async (bulk) => {
      const f = fixture();
      expect(await f.ports.roles.write(VERSION, [ROLE], bulk)).toMatchObject({ ok: true });
      expect(f.http.mock.calls[0]?.[0]).toMatchObject({
        method: "PUT",
        jiraApplicationRole: { ifMatch: VERSION },
        url: `https://jira.example.invalid/context/rest/api/2/applicationrole${bulk ? "" : "/jira-software"}`,
        bodyJson: JSON.stringify(bulk ? [ROLE] : ROLE),
      });
      expect(f.http).toHaveBeenCalledOnce();
    },
  );
  it.each(["*", "unquoted", 'W/"weak"', '"one", "two"', '"line\nbreak"', `"${"x".repeat(255)}"`])(
    "refuses invalid CAS token before admission: %s",
    async (version) => {
      const f = fixture();
      expect(await f.ports.roles.write(version, [ROLE], false)).toMatchObject({ ok: false });
      expect(f.http).not.toHaveBeenCalled();
      expect(f.beforeEffect).not.toHaveBeenCalled();
    },
  );
  it("maps only the fixed role PUT's real 412 to conflict without retry", async () => {
    const f = fixture();
    f.http.mockResolvedValue({
      kind: "response",
      status: 412,
      bodyText: "{}",
      bodyBytes: 2,
      truncated: false,
    });
    expect(await f.ports.roles.write(VERSION, [ROLE], false)).toMatchObject({
      ok: false,
      reason: "conflict",
      httpStatus: 412,
    });
    expect(f.http).toHaveBeenCalledOnce();
    expect(
      await executeAtlassianWriteRequest(
        { http: f.http },
        {
          method: "PUT",
          url: "https://jira.example.invalid/context/rest/api/2/other",
          bodyJson: "{}",
          expect: "none",
        },
      ),
    ).toMatchObject({ ok: false, reason: "unavailable", httpStatus: 412 });
  });
  it("does not publish a private version alongside incomplete collection JSON", async () => {
    const f = fixture();
    f.http.mockResolvedValue({
      kind: "response",
      status: 200,
      bodyText: "[",
      bodyBytes: 1,
      truncated: true,
      applicationRoleVersion: VERSION,
    });
    const result = await f.ports.roles.read();
    expect(result).toMatchObject({ ok: false, reason: "malformed-payload" });
    expect(result).not.toHaveProperty("applicationRoleVersion");
  });
  it("serializes its own role body before admission can mutate the caller's groups", async () => {
    const f = fixture();
    const role = { key: "jira-software", groups: ["R&D team"], defaultGroups: ["R&D team"] };
    f.beforeEffect.mockImplementation(() => {
      role.groups.length = 0;
      return true;
    });
    await f.ports.roles.write(VERSION, [role], false);
    expect(f.http.mock.calls[0]?.[0]?.bodyJson).toBe(JSON.stringify(ROLE));
  });
  it.each([true, false])(
    "sends only the exact experimental query-only application operation present=%s",
    async (present) => {
      const f = fixture();
      await f.ports.application("Target User", "jira-software", present);
      expect(f.http.mock.calls[0]?.[0]).toMatchObject({
        method: present ? "POST" : "DELETE",
        jiraUserApplication: true,
        url: "https://jira.example.invalid/context/rest/api/2/user/application?username=Target+User&applicationKey=jira-software",
      });
      expect(f.http.mock.calls[0]?.[0]).not.toHaveProperty("bodyJson");
      expect(f.http.mock.calls[0]?.[0]).not.toHaveProperty("jiraExperimental");
    },
  );
  it("serializes one bound username and repeated column parameters in native order", async () => {
    const f = fixture();
    await f.ports.columns("Target User", ["summary", "customfield_1", "summary"]);
    expect(f.http.mock.calls[0]?.[0]).toMatchObject({
      method: "PUT",
      jiraUserColumns: true,
      url: "https://jira.example.invalid/context/rest/api/2/user/columns",
      bodyJson: "username=Target+User&columns=summary&columns=customfield_1&columns=summary",
    });
  });
  it("preserves real late ACK/status over cancellation and never retries a lost mutation", async () => {
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
    expect(await f.ports.columns("Target User", ["summary"])).toMatchObject({
      ok: true,
      status: 202,
    });
    expect(f.http).toHaveBeenCalledOnce();
    const lost = fixture();
    lost.http.mockResolvedValue({ kind: "timeout" });
    expect(await lost.ports.roles.write(VERSION, [ROLE], false)).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(lost.http).toHaveBeenCalledOnce();
  });
  it("honors closed admission before every special request", async () => {
    const f = fixture();
    f.beforeEffect.mockReturnValue(false);
    expect(await f.ports.roles.read()).toMatchObject({ ok: false, reason: "effect-denied" });
    expect(await f.ports.roles.write(VERSION, [ROLE], true)).toMatchObject({
      ok: false,
      reason: "effect-denied",
    });
    expect(await f.ports.application("Target User", "jira-software", false)).toMatchObject({
      ok: false,
      reason: "effect-denied",
    });
    expect(await f.ports.columns("Target User", ["summary"])).toMatchObject({
      ok: false,
      reason: "effect-denied",
    });
    expect(f.http).not.toHaveBeenCalled();
  });
});
