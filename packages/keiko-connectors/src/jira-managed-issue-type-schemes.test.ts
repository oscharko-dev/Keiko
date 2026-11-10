import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraIssueTypeSchemeRead } from "./jira-managed-issue-type-schemes.js";

const TYPE = { id: "10001", name: "Task", subtask: false, self: "https://untrusted.invalid/type" };
const SCHEME = {
  id: "10000",
  name: "Delivery",
  description: "",
  issueTypes: [TYPE],
  defaultIssueType: TYPE,
  self: "https://untrusted.invalid/scheme",
};
describe("native issue-type scheme inspection", () => {
  it("uses only the two closed expansion tokens and projects nested identities without URLs", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: true, status: 200, body: { schemes: [SCHEME] } });
    const result = await executeJiraIssueTypeSchemeRead(
      "jira.issue-type-schemes",
      { includeIssueTypes: true, includeDefaultIssueType: true },
      request,
    );
    expect(request).toHaveBeenCalledWith(
      "issuetypescheme?expand=schemes.issueTypes%2Cschemes.defaultIssueType",
    );
    expect(result.data).toMatchObject({
      items: [
        {
          id: "10000",
          name: "Delivery",
          issueTypes: [{ id: "10001", name: "Task", subtask: false }],
          defaultIssueType: { id: "10001", name: "Task", subtask: false },
        },
      ],
      total: 1,
      startAt: 0,
    });
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });
  it("keeps omitted expansion metadata unknown", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        schemes: [{ id: "10000", name: "Delivery", issueTypes: null, defaultIssueType: null }],
      },
    });
    const result = await executeJiraIssueTypeSchemeRead("jira.issue-type-schemes", {}, request);
    expect(request).toHaveBeenCalledWith("issuetypescheme");
    expect(result.data).toMatchObject({ items: [{ id: "10000", name: "Delivery" }] });
    expect(JSON.stringify(result)).not.toContain("issueTypes");
    expect(JSON.stringify(result)).not.toContain("defaultIssueType");
  });
  it("reads one exact scheme identity", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: true, status: 200, body: SCHEME });
    expect(
      await executeJiraIssueTypeSchemeRead(
        "jira.issue-type-scheme",
        { schemeId: "10000" },
        request,
      ),
    ).toMatchObject({ data: { schemeId: "10000", items: [{ id: "10000" }], total: 1 } });
    expect(request).toHaveBeenCalledWith("issuetypescheme/10000");
  });
  it("refuses a mismatching single resource", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: true, status: 200, body: SCHEME });
    expect(
      await executeJiraIssueTypeSchemeRead(
        "jira.issue-type-scheme",
        { schemeId: "10002" },
        request,
      ),
    ).toMatchObject({ data: { outcome: "failed", reason: "conflict" } });
  });
  it("locally pages the native associated-project array without a fabricated remote cursor", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: undefined,
      items: [
        { id: "10", key: "APP", name: "App", archived: false },
        { id: "11", key: "OPS", name: "Operations" },
      ],
    });
    const result = await executeJiraIssueTypeSchemeRead(
      "jira.issue-type-scheme-projects",
      { schemeId: "10000", startAt: 1, maxResults: 1 },
      request,
    );
    expect(request).toHaveBeenCalledWith(
      "issuetypescheme/10000/associations",
      "GET",
      undefined,
      "json-array",
    );
    expect(result.data).toMatchObject({
      schemeId: "10000",
      startAt: 1,
      total: 2,
      items: [{ id: "11", key: "OPS", name: "Operations" }],
    });
  });
  it.each([
    ["jira.issue-type-schemes", { expand: "everything" }],
    ["jira.issue-type-schemes", { includeIssueTypes: null }],
    ["jira.issue-type-schemes", { includeDefaultIssueType: "true" }],
    ["jira.issue-type-schemes", { startAt: null }],
    ["jira.issue-type-schemes", { maxResults: 101 }],
    ["jira.issue-type-scheme", { schemeId: "../escape" }],
    ["jira.issue-type-scheme", { schemeId: "01" }],
    ["jira.issue-type-scheme", { schemeId: "9223372036854775808" }],
    ["jira.issue-type-scheme-projects", { schemeId: "10", expand: "*" }],
  ] as const)("refuses unsupported %s input before HTTP", async (name, args) => {
    const request = vi.fn<JiraMutationRequest>();
    expect(await executeJiraIssueTypeSchemeRead(name, args, request)).toMatchObject({
      data: { outcome: "failed", reason: "invalid-input" },
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { schemes: [SCHEME, SCHEME] },
    { schemes: [{ ...SCHEME, id: 10000 }] },
    { schemes: [{ ...SCHEME, issueTypes: [TYPE, TYPE] }] },
    { schemes: [{ ...SCHEME, defaultIssueType: { id: "1" } }] },
    { schemes: [{ ...SCHEME, name: "x".repeat(256) }] },
    { schemes: [{ ...SCHEME, issueTypes: [{ ...TYPE, subtask: "false" }] }] },
  ])("refuses malformed collections rather than inventing scheme metadata", async (body) => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
    expect(
      await executeJiraIssueTypeSchemeRead("jira.issue-type-schemes", {}, request),
    ).toMatchObject({ data: { outcome: "failed", reason: "malformed-payload" } });
  });
  it("enforces the existing collection budget", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        schemes: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, i) => ({
          id: String(i + 1),
          name: "Scheme",
        })),
      },
    });
    expect(
      await executeJiraIssueTypeSchemeRead("jira.issue-type-schemes", {}, request),
    ).toMatchObject({ data: { outcome: "failed", reason: "bounds-exceeded" } });
  });
  it.each(["permission-denied", "auth-failed", "not-found"] as const)(
    "preserves native %s as failure without fallback",
    async (reason) => {
      const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason });
      expect(
        await executeJiraIssueTypeSchemeRead(
          "jira.issue-type-scheme",
          { schemeId: "10000" },
          request,
        ),
      ).toMatchObject({ data: { outcome: "failed", reason } });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
