import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraWorkflowSchemeRead,
  isJiraWorkflowSchemeRead,
} from "./jira-managed-workflow-schemes.js";

type Operation = Parameters<typeof executeJiraWorkflowSchemeRead>[0];
const SCHEME = {
  id: 37,
  name: "Delivery",
  defaultWorkflow: "Default",
  draft: false,
  issueTypeMappings: { "1": "Flow", "2": "Second" },
  self: "https://untrusted.invalid",
  lastModifiedUser: { emailAddress: "private@example.invalid" },
};
const requestFor = (body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> =>
  vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
const read = (
  operation: Operation,
  body: Record<string, unknown>,
  args: CatalogJsonObject = { schemeId: "37" },
): ReturnType<typeof executeJiraWorkflowSchemeRead> =>
  executeJiraWorkflowSchemeRead(operation, args, requestFor(body));
const CASES: readonly {
  operation: Operation;
  suffix: string;
  args?: CatalogJsonObject;
  body: Record<string, unknown>;
}[] = [
  { operation: "jira.workflow-scheme", suffix: "", body: SCHEME },
  {
    operation: "jira.workflow-scheme-draft",
    suffix: "/draft",
    body: { ...SCHEME, id: 38, draft: true },
  },
  { operation: "jira.workflow-scheme-default", suffix: "/default", body: { workflow: "Default" } },
  {
    operation: "jira.workflow-scheme-draft-default",
    suffix: "/draft/default",
    body: { workflow: "Default" },
  },
  {
    operation: "jira.workflow-scheme-issue-type",
    suffix: "/issuetype/1",
    args: { issueTypeId: "1" },
    body: { issueType: "1", workflow: "Flow" },
  },
  {
    operation: "jira.workflow-scheme-draft-issue-type",
    suffix: "/draft/issuetype/1",
    args: { issueTypeId: "1" },
    body: { issueType: "1", workflow: "Flow" },
  },
  {
    operation: "jira.workflow-scheme-workflows",
    suffix: "/workflow?workflowName=Flow",
    args: { workflowName: "Flow" },
    body: { workflow: "Flow", issueTypes: ["1"], defaultMapping: false },
  },
  {
    operation: "jira.workflow-scheme-draft-workflows",
    suffix: "/draft/workflow?workflowName=Flow",
    args: { workflowName: "Flow" },
    body: { workflow: "Flow", issueTypes: ["1"] },
  },
];
describe("published native workflow-scheme reads", () => {
  it.each(CASES)(
    "routes $operation to its single closed identity",
    async ({ operation, suffix, args, body }) => {
      const request = requestFor(body);
      const result = await executeJiraWorkflowSchemeRead(
        operation,
        { schemeId: "37", ...args },
        request,
      );
      expect(result.data.outcome).toBe("succeeded");
      expect(request.mock.calls).toEqual([
        [`workflowscheme/37${suffix}`, "GET", undefined, "json"],
      ]);
      expect(isJiraWorkflowSchemeRead(operation)).toBe(true);
    },
  );
  it("retains scheme/draft identity separately from the requested parent and paginates mapping differences", async () => {
    const result = await read(
      "jira.workflow-scheme-draft",
      {
        ...SCHEME,
        id: 38,
        draft: true,
        originalIssueTypeMappings: { "1": "Before", "3": "Removed" },
        originalDefaultWorkflow: "Old default",
      },
      { schemeId: "37", startAt: 1, maxResults: 1 },
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      schemeId: "37",
      id: "38",
      name: "Delivery",
      draft: true,
      defaultWorkflow: "Default",
      originalDefaultWorkflow: "Old default",
      startAt: 1,
      total: 3,
      nextStartAt: 2,
      items: [{ issueTypeId: "2", workflow: "Second" }],
    });
    expect(JSON.stringify(result)).not.toContain("untrusted");
    expect(JSON.stringify(result)).not.toContain("private@");
  });
  it("preserves original-only issue type mappings without inventing a current workflow", async () => {
    expect(
      (
        await read("jira.workflow-scheme-draft", {
          ...SCHEME,
          draft: true,
          issueTypeMappings: {},
          originalIssueTypeMappings: { "3": "Removed" },
        })
      ).data.items,
    ).toEqual([{ issueTypeId: "3", originalWorkflow: "Removed" }]);
  });
  it.each([undefined, null])(
    "keeps missing mapping collections and draft flags unknown",
    async (missing) => {
      const result = await read("jira.workflow-scheme", {
        id: 37,
        issueTypeMappings: missing,
        originalIssueTypeMappings: missing,
        draft: missing,
        description: missing,
      });
      expect(result.data).toEqual({ outcome: "succeeded", schemeId: "37", id: "37" });
    },
  );
  it("retains explicit empty collections and false flags", async () => {
    expect(
      (await read("jira.workflow-scheme", { id: 37, issueTypeMappings: {}, draft: false })).data,
    ).toEqual({
      outcome: "succeeded",
      schemeId: "37",
      id: "37",
      draft: false,
      items: [],
      startAt: 0,
      total: 0,
    });
  });
  it("forwards the documented draft selector explicitly without claiming a draft response", async () => {
    const request = requestFor({ workflow: "Default" });
    expect(
      (
        await executeJiraWorkflowSchemeRead(
          "jira.workflow-scheme-default",
          { schemeId: "37", returnDraftIfExists: true },
          request,
        )
      ).data,
    ).toEqual({ outcome: "succeeded", schemeId: "37", workflow: "Default" });
    expect(request.mock.calls[0]?.[0]).toBe("workflowscheme/37/default?returnDraftIfExists=true");
  });
  it.each(["jira.workflow-scheme-workflows", "jira.workflow-scheme-draft-workflows"] as const)(
    "uses native array decoding and local pagination for unfiltered %s",
    async (operation) => {
      const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
        ok: true,
        status: 200,
        body: undefined,
        items: [
          { workflow: "First", issueTypes: [] },
          { workflow: "Second", issueTypes: ["9007199254740993"], defaultMapping: true },
        ],
      });
      expect(
        (
          await executeJiraWorkflowSchemeRead(
            operation,
            { schemeId: "37", startAt: 1, maxResults: 1 },
            request,
          )
        ).data,
      ).toEqual({
        outcome: "succeeded",
        schemeId: "37",
        startAt: 1,
        total: 2,
        items: [{ workflow: "Second", issueTypeIds: ["9007199254740993"], defaultMapping: true }],
      });
      expect(request.mock.calls[0]?.[3]).toBe("json-array");
      expect(request.mock.calls[0]?.[0]).not.toContain("startAt");
    },
  );
  it("encodes the workflow name as one query value", async () => {
    const workflowName = "R&D / urgent?x=y";
    const request = requestFor({ workflow: workflowName });
    expect(
      (
        await executeJiraWorkflowSchemeRead(
          "jira.workflow-scheme-workflows",
          { schemeId: "37", workflowName },
          request,
        )
      ).data.outcome,
    ).toBe("succeeded");
    expect(request.mock.calls[0]?.[0]).toBe(
      "workflowscheme/37/workflow?workflowName=R%26D+%2F+urgent%3Fx%3Dy",
    );
  });
  it.each([
    { schemeId: "../37" },
    { schemeId: "01" },
    { schemeId: "9223372036854775808" },
    { schemeId: "37", returnDraftIfExists: null },
    { schemeId: "37", returnDraftIfExists: "true" },
    { schemeId: "37", startAt: null },
    { schemeId: "37", maxResults: 101 },
    { schemeId: "37", method: "POST" },
  ])("refuses invalid or widened input before HTTP", async (args) => {
    const request = requestFor(SCHEME);
    expect(
      (await executeJiraWorkflowSchemeRead("jira.workflow-scheme", args, request)).data.reason,
    ).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects active-only selectors on a draft endpoint", async () => {
    const request = requestFor(SCHEME);
    expect(
      (
        await executeJiraWorkflowSchemeRead(
          "jira.workflow-scheme-draft",
          { schemeId: "37", returnDraftIfExists: true },
          request,
        )
      ).data.reason,
    ).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { id: 38 },
    { id: 9007199254740992 },
    { draft: true },
    { draft: "false" },
    { name: 1 },
    { description: "x".repeat(32769) },
    { issueTypeMappings: { "1": null } },
    { issueTypeMappings: { "../1": "Flow" } },
  ])("refuses mismatched or malformed active scheme facts", async (patch) => {
    expect((await read("jira.workflow-scheme", { ...SCHEME, ...patch })).data.reason).toBe(
      "malformed-payload",
    );
  });
  it("does not relabel a mismatched active ID as a draft merely because returnDraftIfExists was requested", async () => {
    expect(
      (
        await read(
          "jira.workflow-scheme",
          { ...SCHEME, id: 38 },
          { schemeId: "37", returnDraftIfExists: true },
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("preserves a precise string scheme ID beyond Number.MAX_SAFE_INTEGER", async () => {
    expect(
      (
        await read(
          "jira.workflow-scheme",
          { id: "9007199254740993" },
          { schemeId: "9007199254740993" },
        )
      ).data.id,
    ).toBe("9007199254740993");
  });
  it.each([
    { workflow: "Wrong" },
    { workflow: "Flow", issueTypes: ["1", "1"] },
    { workflow: "Flow", issueTypes: [1] },
    { workflow: "Flow", defaultMapping: "false" },
  ])("refuses unproven selected workflow mappings", async (body) => {
    expect(
      (await read("jira.workflow-scheme-workflows", body, { schemeId: "37", workflowName: "Flow" }))
        .data.reason,
    ).toBe("malformed-payload");
  });
  it("binds the selected issue type instead of accepting another native mapping", async () => {
    expect(
      (
        await read(
          "jira.workflow-scheme-issue-type",
          { issueType: "2", workflow: "Flow" },
          { schemeId: "37", issueTypeId: "1" },
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("refuses duplicate native workflows instead of counting them as distinct", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: undefined,
      items: [{ workflow: "Same" }, { workflow: "Same" }],
    });
    expect(
      (
        await executeJiraWorkflowSchemeRead(
          "jira.workflow-scheme-workflows",
          { schemeId: "37" },
          request,
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("refuses oversized native collections without silently truncating them", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: undefined,
      items: Array.from({ length: 1001 }, (_, index) => ({ workflow: `Flow ${String(index)}` })),
    });
    expect(
      (
        await executeJiraWorkflowSchemeRead(
          "jira.workflow-scheme-workflows",
          { schemeId: "37" },
          request,
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it.each(["auth-failed", "permission-denied", "not-found", "timeout"] as const)(
    "propagates %s without probing for privileged alternatives",
    async (reason) => {
      const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason });
      expect(
        (await executeJiraWorkflowSchemeRead("jira.workflow-scheme", { schemeId: "37" }, request))
          .data.reason,
      ).toBe(reason);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("exposes only the eight reviewed read names", () => {
    expect(isJiraWorkflowSchemeRead("jira.create-workflow-scheme")).toBe(false);
    expect(isJiraWorkflowSchemeRead("toString")).toBe(false);
  });
});
