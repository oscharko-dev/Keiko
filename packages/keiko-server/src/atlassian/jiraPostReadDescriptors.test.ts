import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";
import { postAndIdentityReadTransport } from "../../../../tests/support/jira-post-and-identity-read-fixture.js";

it.each([
  { tool: "jira.search-post", args: { jql: "project = SYN" }, identity: "POST /rest/api/2/search" },
  {
    tool: "jira.worklogs-by-id",
    args: { worklogIds: ["7", "8"] },
    identity: "POST /rest/api/2/worklog/list",
  },
] as const)(
  "runs $tool through read admission without calling the mutation executor",
  async ({ tool, args, identity }) => {
    const mutation = vi.fn();
    const http = vi.fn(postAndIdentityReadTransport);
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http,
      }),
      [tool],
      mutation,
    );
    const declaration = provider.tools()[0];
    if (declaration === undefined) throw new TypeError("Missing native POST read declaration");
    expect(declaration.risk).toBe("read");
    const result = await declaration.execute(args, {
      invocationId: "read-post",
      correlationId: "read-post",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    });
    expect(result.data).toMatchObject({ outcome: "succeeded", operationBinding: { identity } });
    expect(result.data).not.toHaveProperty("mutationOutcome");
    expect(mutation).not.toHaveBeenCalled();
    expect(http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect(jiraOperationForTool(tool)?.definition.effects).toEqual(["remote-read"]);
  },
);

it("keeps the search field schema shared and the selected worklog result bounded", () => {
  const search = jiraOperationForTool("jira.search");
  const posted = jiraOperationForTool("jira.search-post");
  expect(posted?.declaration.descriptor.inputSchema).toEqual(
    search?.declaration.descriptor.inputSchema,
  );
  const worklogs = jiraOperationForTool("jira.worklogs-by-id");
  if (worklogs === undefined) throw new TypeError("Missing native worklog selection contract");
  const schema = worklogs.declaration.descriptor.resultSchema;
  expect(
    describeCatalogSchemaMismatch(schema, {
      outcome: "succeeded",
      operationBinding: worklogs.binding,
      selectionScope: "native-visible-requested-worklogs",
      requestedCount: 2,
      returnedCount: 0,
      unreturnedWorklogIds: ["7", "8"],
      items: [],
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(schema, {
      outcome: "succeeded",
      operationBinding: worklogs.binding,
      total: 0,
      items: [],
    }),
  ).toBeDefined();
});
