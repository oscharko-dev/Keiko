import { afterEach, expect, it, vi } from "vitest";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraAttemptToolResult } from "./jiraMutationResult.js";
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

// #4354 (AC6 f): an attachment call the Release 1 switch refuses leaves one closed line under the
// turn's correlation, naming the refusal and the operation, nothing the model sent.
it.each(["jira.attach", "jira.delete-attachment"] as const)(
  "records a %s call refused by the release switch as one closed release-scope line",
  async (operation) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: vi.fn(),
      }),
      [operation],
      // The real connector runs behind `execute`: the refusal is the switch's own, not a stub's.
      async (_operation, _args, _context, execute) =>
        jiraAttemptToolResult("rejected", await execute(vi.fn())),
    );
    const tool = provider.tools()[0];
    if (tool === undefined) throw new TypeError("Missing selected provider tool");
    await tool.execute(
      { fileName: "private-report.txt" },
      {
        invocationId: "release-scope",
        correlationId: "turn-correlation",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    const events = sink.events.filter(({ op }) => op.startsWith("jira.operation."));
    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    expect(expectActivityLogProof("jira.operation.core.line", line)).toMatchObject({
      operation,
      stage: "release-scope",
      outcome: "refused",
      reason: "unavailable",
      correlationId: "turn-correlation",
    });
    expect(line).not.toMatch(/private-report|jira\.example/u);
  },
);

// The label belongs to the switch's own refusal only: an attachment call that failed for another
// reason is an ordinary failed provider call, not a release-scope line.
it("does not label another failure of a withheld operation as the release switch's", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const provider = createJiraProviderForCatalog(
    () => ({
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: vi.fn(),
    }),
    ["jira.attach"],
    () => Promise.resolve({ isError: true, data: { outcome: "rejected", reason: "timeout" } }),
  );
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing selected provider tool");
  await tool.execute(
    {},
    {
      invocationId: "other-failure",
      correlationId: "turn-correlation",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
  );
  const events = sink.events.filter(({ op }) => op.startsWith("jira.operation."));
  expect(events).toHaveLength(1);
  expect(events[0]?.extra).toMatchObject({ stage: "provider-call", outcome: "failed" });
});

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
it("points figures across many issues to jira.report without attracting every project question to it (#4357)", () => {
  const provider = createJiraProviderForCatalog(vi.fn(), [
    "jira.search",
    "jira.search-post",
    "jira.issue",
    "jira.report",
  ]);
  const describe = (name: string): string =>
    provider.tools().find((tool) => tool.name === name)?.descriptor.description ?? "";
  // The pointer stays, narrowed to what the report computes: a model must not page or loop for totals.
  // The old incident: models paged search results or read issues one by one to total a project.
  // These descriptors must keep sending such totals to the report; the behavioural proof is the
  // S10 case of the Jira lab on the integrated head (the project-statuses case stays separate).
  for (const name of ["jira.search", "jira.search-post", "jira.issue"]) {
    expect(describe(name), name).toMatch(/across many issues come from jira\.report/u);
    expect(describe(name), name).toMatch(/not from (paging results|reading issues one by one)/u);
  }
  // What a description promises the report computes must be in the report's own documented coverage:
  // "totals across many issues" sent logged-time questions there, which the report does not answer.
  const reportCoverage = describe("jira.report");
  for (const name of ["jira.search", "jira.search-post", "jira.issue"]) {
    expect(describe(name), name).toMatch(
      /progress, estimates and template compliance across many issues come from jira\.report/iu,
    );
    expect(describe(name), name).not.toMatch(/\btotals across\b/iu);
  }
  for (const metric of ["progress", "estimates", "template compliance"])
    expect(reportCoverage).toContain(metric);
  const report = provider.tools().find((tool) => tool.name === "jira.report");
  // Both attempts of the selection lane asked for project statuses and were answered by the report.
  expect(report?.descriptor.description).not.toMatch(
    /not jira\.search|whole project|any question/u,
  );
  expect(report?.descriptor.description).toMatch(/^Deterministic Jira report computed by Keiko/u);
  expect(report?.descriptor.description).toContain("requirementsFromPods");
  expect(report?.descriptor.description).toContain("report.figures");
  expect(JSON.stringify(report?.descriptor.inputSchema)).toContain("requirementsFromPods");
});

it("describes jira.search by what it really does: page sizes, per-row field values and the report alternative", () => {
  const provider = createJiraProviderForCatalog(vi.fn(), ["jira.search", "jira.search-post"]);
  for (const name of ["jira.search", "jira.search-post"]) {
    const tool = provider.tools().find((entry) => entry.name === name);
    const text = tool?.descriptor.description ?? "";
    expect(text).toMatch(/25 .*100/u);
    expect(text).toMatch(/fields[^.]*per.issue|per.issue[^.]*fields/iu);
    expect(text).toContain("jira.report");
    expect(text).not.toMatch(/returns issue summaries; fetch an issue/iu);
    const properties = (tool?.descriptor.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect((properties.fields as { description?: string }).description).toMatch(/\S/u);
  }
});

it("admits the closed guidance member of a search result in the advertised result schema", () => {
  const descriptor = createJiraProviderForCatalog(vi.fn(), ["jira.search"]).tools()[0]?.descriptor;
  if (descriptor === undefined) throw new TypeError("Expected the search descriptor");
  const operationBinding = jiraOperationBindingForTool("jira.search");
  if (operationBinding === undefined) throw new TypeError("Expected search operation binding");
  const data = {
    outcome: "succeeded",
    operationBinding,
    items: [],
    startAt: 0,
    total: 240,
    guidance: "Use jira.report.",
  };
  expect(describeCatalogSchemaMismatch(descriptor.resultSchema, data)).toBeUndefined();
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
