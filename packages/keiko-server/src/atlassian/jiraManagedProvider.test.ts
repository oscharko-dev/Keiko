import { afterEach, expect, it, vi } from "vitest";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  createJiraProviderForCatalog,
  jiraOperationBindingForTool,
} from "./jiraManagedProvider.js";
import type {
  JiraManagedConnection,
  JiraManagedMutationExecutor,
} from "@oscharko-dev/keiko-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { response } from "../../../../tests/support/jira-managed-remote.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";

afterEach(resetServerLogger);

it.each(["jira.create", "jira.draft", "jira.edit", "jira.attach"] as const)(
  "records the selected %s provider identity independently of its shared authority action",
  async (operation) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const executor = vi.fn<JiraManagedMutationExecutor<ManagedMcpInvocationContext>>(() =>
      Promise.resolve({
        data: { outcome: "unconfirmed", issueKey: "SYN-1", operation: "jira.proxy" },
      }),
    );
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: vi.fn(),
      }),
      [operation],
      executor,
    );
    const tool = provider.tools()[0];
    if (tool === undefined) throw new TypeError("Missing selected provider tool");
    const result = await tool.execute(
      {},
      {
        invocationId: "provider-alias",
        correlationId: "provider-alias",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    expect(executor.mock.calls.map(([name]) => name)).toEqual([operation]);
    expect(result.data).toMatchObject({ outcome: "unconfirmed", issueKey: "SYN-1" });
    const events = sink.events.filter(({ op }) => op.startsWith("jira.operation."));
    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    expect(expectActivityLogProof("jira.operation.core.line", line)).toMatchObject({
      operation,
      stage: "provider-call",
      outcome: "completed",
      reason: "none",
      correlationId: "provider-alias",
    });
    expect(line).not.toMatch(/jira\.proxy|SYN-1|jira\.example/u);
  },
);

it("preserves a known unconfirmed receipt when the provider activity sink fails", async () => {
  const write = vi.fn(() => {
    throw new Error("Synthetic private sink failure");
  });
  setServerLogger(createServerLogger({ sink: { write }, level: "debug" }));
  const provider = createJiraProviderForCatalog(
    () => ({
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: vi.fn(),
    }),
    ["jira.attach"],
    () =>
      Promise.resolve({
        data: { outcome: "unconfirmed", issueKey: "SYN-1", attachmentId: "10001" },
      }),
  );
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing attachment provider");
  const result = await tool.execute(
    {},
    {
      invocationId: "provider-loss",
      correlationId: "provider-loss",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
  );
  expect(write).toHaveBeenCalled();
  expect(result.data).toMatchObject({
    outcome: "unconfirmed",
    issueKey: "SYN-1",
    attachmentId: "10001",
  });
});

it("logs a provider exception without replacing the original error or inferring an effect", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const failure = new Error("Synthetic private provider failure");
  const provider = createJiraProviderForCatalog(
    () => ({
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: vi.fn(),
    }),
    ["jira.attach"],
    () => Promise.reject(failure),
  );
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing attachment provider");
  await expect(
    tool.execute(
      {},
      {
        invocationId: "provider-failure",
        correlationId: "provider-failure",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    ),
  ).rejects.toBe(failure);
  const event = sink.events.find(({ op }) => op === "jira.operation.core");
  const line = formatActivityLogProofLine(event ?? {});
  expect(expectActivityLogProof("jira.operation.core.line", line)).toMatchObject({
    operation: "jira.attach",
    stage: "provider-call",
    outcome: "failed",
    reason: "tool-failed",
  });
  expect(line).not.toMatch(/Synthetic|private|provider failure/u);
});

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
it("steers a model that is asked about many issues to jira.report, whose input names no field to guess", () => {
  const provider = createJiraProviderForCatalog(vi.fn(), [
    "jira.search",
    "jira.issue",
    "jira.report",
  ]);
  const describe = (name: string): string =>
    provider.tools().find((tool) => tool.name === name)?.descriptor.description ?? "";
  expect(describe("jira.search")).toContain("jira.report");
  expect(describe("jira.issue")).toContain("jira.report");
  const report = provider.tools().find((tool) => tool.name === "jira.report");
  expect(report?.descriptor.description).toMatch(/not jira\.search or jira\.issue/u);
  expect(report?.descriptor.description).toContain("requirementsFromPods");
  expect(report?.descriptor.description).toContain("report.figures");
  expect(JSON.stringify(report?.descriptor.inputSchema)).toContain("requirementsFromPods");
});

it("advertises the real paging contract of jira.report: summary first, then sections with startAt", () => {
  const provider = createJiraProviderForCatalog(vi.fn(), ["jira.report"]);
  const text = provider.tools().find((tool) => tool.name === "jira.report")?.descriptor.description;
  expect(text).not.toMatch(/section on the first call/iu);
  expect(text).toMatch(/without a section[^.]*summary/iu);
  expect(text).toContain("startAt");
  expect(text).toMatch(/names a section[^.]*only that page/iu);
});

it("builds canonical field metadata descriptors that admit the advertised input schema as data", () => {
  const connection = vi.fn();
  const provider = createJiraProviderForCatalog(connection, ["jira.create-fields"]);
  const descriptor = provider.tools()[0]?.descriptor;
  if (descriptor === undefined) throw new TypeError("Expected canonical create-fields descriptor");
  expect(descriptor.resultSchema).toMatchObject({
    properties: {
      items: {
        items: {
          properties: {
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: true,
            },
          },
        },
      },
    },
  });
  const operationBinding = jiraOperationBindingForTool("jira.create-fields");
  if (operationBinding === undefined)
    throw new TypeError("Expected create-fields operation binding");
  const data = {
    outcome: "succeeded",
    operationBinding,
    items: [
      {
        id: "description",
        name: "Description",
        required: false,
        hasDefaultValue: false,
        kind: "text",
        richText: true,
        operations: ["set"],
        inputSchema: {
          oneOf: [
            { type: "string", maxLength: 32768 },
            {
              type: "object",
              additionalProperties: false,
              required: ["format", "text"],
              properties: {
                format: { type: "string", enum: ["markdown"] },
                text: { type: "string", maxLength: 32768 },
              },
            },
          ],
        },
        nativeFormat: "jira-wiki",
        markdownSerialization: "supported-markdown",
      },
    ],
  };
  expect(describeCatalogSchemaMismatch(descriptor.resultSchema, data)).toBeUndefined();
  expect(connection).not.toHaveBeenCalled();
});
