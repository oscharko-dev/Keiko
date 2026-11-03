import { expect, it, vi } from "vitest";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import type {
  JiraManagedConnection,
  JiraManagedMutationExecutor,
} from "@oscharko-dev/keiko-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { response } from "../../../../tests/support/jira-managed-remote.js";

it("requires a server mutation executor before advertising any write", () => {
  const connection = vi.fn();
  expect(() => createJiraProviderForCatalog(connection, ["jira.comment"])).toThrow(TypeError);
  expect(connection).not.toHaveBeenCalled();
});
it("isolates admitted arguments and the resolved connection from later owner mutation", async () => {
  const sent: string[] = [];
  const selected: JiraManagedConnection = {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http: vi.fn(() => {
      throw new Error("Read port cannot dispatch writes");
    }),
  };
  const executor: JiraManagedMutationExecutor<ManagedMcpInvocationContext> = async (
    _operation,
    args,
    _context,
    execute,
  ) => {
    Object.assign(args, { body: "Changed by caller" });
    Object.assign(selected, { baseUrl: "https://substituted.example.invalid" });
    const attempt = await execute((request) => {
      sent.push(request.url);
      if (request.method === "POST") {
        expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ body: "Approved" });
        return Promise.resolve(response({ id: "10002" }, 201));
      }
      return Promise.resolve(response({ id: "10002", body: "Approved" }));
    });
    expect(attempt).toMatchObject({ ok: true });
    return { data: { outcome: "succeeded" } };
  };
  const provider = createJiraProviderForCatalog(() => selected, ["jira.comment"], executor);
  await provider.tools()[0]?.execute(
    { issueKey: "SYN-1", body: "Approved" },
    {
      invocationId: "synthetic",
      correlationId: "synthetic",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
  );
  expect(sent).toHaveLength(2);
  expect(sent.every((url) => url.startsWith("https://jira.example.invalid/context/"))).toBe(true);
});
it("advertises all canonical write declarations only with a server mutation executor", () => {
  const connection = vi.fn();
  const executeMutation = vi.fn();
  const provider = createJiraProviderForCatalog(
    connection,
    JIRA_MUTATION_OPERATIONS,
    executeMutation,
  );
  expect(provider.tools().map((tool) => [tool.name, tool.risk])).toEqual(
    JIRA_MUTATION_OPERATIONS.map((name) => [name, "write"]),
  );
  expect(connection).not.toHaveBeenCalled();
  expect(executeMutation).not.toHaveBeenCalled();
});
