import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
  JiraManagedConnection,
  JiraManagedMutationExecutor,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  FIELDS,
  LINKS_FIELD,
  REQUIRED_CUSTOM,
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import {
  createJiraProviderForCatalog,
  jiraOperationContracts,
  jiraOperationForTool,
} from "./jiraManagedProvider.js";
import type { JiraOperationDefinition, JiraOperationTool } from "./jiraOperationRegistry.js";

interface Scenario {
  readonly tool: JiraOperationTool;
  readonly args: CatalogJsonObject;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly primaryMethodIndex?: number;
}
const ISSUE_PARAMETERS = { issueIdOrKey: "SYN-1" };
const PAGING = { startAt: "0", maxResults: "25" };
const CREATE = {
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "After", customfield_10000: "Required" },
};
// Inputs and selected resource identities are independent fixtures, not generated from the registry.
const SCENARIOS: readonly Scenario[] = [
  { tool: "jira.projects", args: {} },
  { tool: "jira.filter", args: { filterId: "37" }, parameters: { filterId: "37" } },
  { tool: "jira.favourite-filters", args: { startAt: 0, maxResults: 25 } },
  {
    tool: "jira.components",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  { tool: "jira.component", args: { componentId: "71" }, parameters: { id: "71" } },
  {
    tool: "jira.versions",
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  { tool: "jira.version", args: { versionId: "81" }, parameters: { id: "81" } },
  { tool: "jira.create-component", args: { projectIdOrKey: "SYN", name: "After" } },
  {
    tool: "jira.update-component",
    args: { componentId: "71", name: "After" },
    parameters: { id: "71" },
  },
  { tool: "jira.create-version", args: { projectId: "10000", name: "After" } },
  {
    tool: "jira.update-version",
    args: { versionId: "81", name: "After" },
    parameters: { id: "81" },
  },
  { tool: "jira.project", args: { projectIdOrKey: "SYN" }, parameters: { projectIdOrKey: "SYN" } },
  { tool: "jira.validate-project-key", args: { key: "SYN" }, query: { key: "SYN" } },
  {
    tool: "jira.project-permissions",
    args: { projectIdOrKey: "10000" },
    query: { projectId: "10000" },
  },
  {
    tool: "jira.project-type",
    args: { projectTypeKey: "software" },
    parameters: { projectTypeKey: "software" },
  },
  {
    tool: "jira.create-project",
    args: { key: "SYN", name: "After", lead: "synthetic-user", projectTypeKey: "software" },
  },
  {
    tool: "jira.update-project",
    args: { projectIdOrKey: "SYN", name: "After" },
    parameters: { projectIdOrKey: "10000" },
  },
  {
    tool: "jira.issue-types",
    args: { projectKey: "SYN" },
    parameters: { projectIdOrKey: "SYN" },
    query: PAGING,
  },
  {
    tool: "jira.create-fields",
    args: { projectKey: "SYN", issueTypeId: "10001", maxResults: 100 },
    parameters: { projectIdOrKey: "SYN", issueTypeId: "10001" },
    query: { ...PAGING, maxResults: "100" },
  },
  { tool: "jira.edit-fields", args: { issueKey: "SYN-1" }, parameters: ISSUE_PARAMETERS },
  {
    tool: "jira.search",
    args: { jql: "project = SYN", maxResults: 50 },
    query: {
      ...PAGING,
      jql: "project = SYN",
      maxResults: "50",
      fields: "summary,status,issuetype,project,assignee,priority,labels,created,updated",
    },
  },
  {
    tool: "jira.issue",
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: {
      fields:
        "summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated",
    },
  },
  {
    tool: "jira.comments",
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: PAGING,
  },
  {
    tool: "jira.transitions",
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: { expand: "transitions.fields" },
  },
  {
    tool: "jira.assignable-users",
    args: { issueKey: "SYN-1", query: "synthetic" },
    query: { ...PAGING, issueKey: "SYN-1", username: "synthetic" },
  },
  { tool: "jira.create", args: CREATE },
  {
    tool: "jira.edit",
    args: { issueKey: "SYN-1", fields: { summary: "After" } },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.assign",
    args: { issueKey: "SYN-1", assigneeName: "synthetic-user" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.comment",
    args: { issueKey: "SYN-1", body: "Approved comment" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.transition",
    args: { issueKey: "SYN-1", transitionId: "31", fields: { customfield_10000: "Required" } },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.attach",
    args: { issueKey: "SYN-1", source: { kind: "connected-file", path: "note.txt" } },
    parameters: ISSUE_PARAMETERS,
  },
];
interface RemoteState extends SyntheticJira {
  project: Record<string, unknown>;
  component: Record<string, unknown>;
  version: Record<string, unknown>;
}
function structureRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "component/71") return response(state.component);
  if (path === "version/81") return response(state.version);
  if (path === "project/10000/components") return response([state.component]);
  if (path === "project/10000/versions") return response([state.version]);
  return undefined;
}
function structureWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  if (path === "component" || path === "component/71") {
    state.component = { ...state.component, ...body };
    return response(state.component, request.method === "POST" ? 201 : 200);
  }
  if (path === "version" || path === "version/81") {
    state.version = { ...state.version, ...body };
    return response(state.version, request.method === "POST" ? 201 : 200);
  }
  return undefined;
}
function projectRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "project") return response([state.project]);
  if (path === "project/SYN" || path === "project/10000") return response(state.project);
  if (path === "projectvalidate/key") return response({ errors: {}, errorMessages: [] });
  if (path === "mypermissions")
    return response({ permissions: { ADMINISTER: { havePermission: true } } });
  if (path === "project/type/software/accessible")
    return response({ key: "software", formattedKey: "Software" });
  return undefined;
}
function filterRead(path: string): AtlassianHttpBodyResult | undefined {
  const filter = {
    id: "37",
    name: "Scoped",
    jql: "project=SYN",
    owner: { name: "synthetic-user" },
    sharePermissions: [],
  };
  if (path === "filter/37") return response(filter);
  if (path === "filter/favourite") return response([filter]);
  return undefined;
}
function issueMetadata(path: string): AtlassianHttpBodyResult | undefined {
  if (path.endsWith("/issuetypes"))
    return response({
      values: [{ id: "10001", name: "Story", subtask: false }],
      start: 0,
      size: 1,
      last: true,
      total: 1,
    });
  if (path.includes("createmeta"))
    return response({
      values: [...FIELDS, LINKS_FIELD],
      start: 0,
      size: 100,
      last: true,
      total: FIELDS.length + 1,
    });
  if (path.endsWith("/transitions"))
    return response({
      transitions: [
        {
          id: "31",
          name: "Done",
          to: { id: "3", name: "Done" },
          fields: { customfield_10000: REQUIRED_CUSTOM },
        },
      ],
    });
  if (path === "user/assignable/search")
    return response([{ name: "synthetic-user", displayName: "Synthetic", active: true }]);
  if (path === "issue/SYN-1/comment")
    return response({ comments: [], startAt: 0, maxResults: 25, total: 0 });
  return undefined;
}
function projectWrite(
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult {
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  state.project = {
    ...state.project,
    ...body,
    ...(typeof body.lead === "string" ? { lead: { name: body.lead } } : {}),
  };
  return request.method === "POST"
    ? response({ id: 10000, key: "SYN" }, 201)
    : response(state.project);
}
function remote(): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> {
  const state: RemoteState = {
    fields: {
      summary: "Before",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: [],
      issuelinks: [],
      attachment: [],
    },
    comment: "",
    component: { id: "71", project: "SYN", name: "Before" },
    version: { id: "81", projectId: 10000, name: "Before" },
    project: {
      id: "10000",
      key: "SYN",
      name: "Before",
      lead: { name: "synthetic-user" },
      projectTypeKey: "software",
    },
  };
  return vi.fn<AtlassianHttpBodyPort>((request) => {
    const absolute = new URL(request.url).pathname;
    const path = absolute.replace("/context/rest/api/2/", "");
    if (request.method === "GET")
      return Promise.resolve(
        projectRead(path, state) ??
          structureRead(path, state) ??
          filterRead(path) ??
          issueMetadata(path) ??
          fixtureRead(absolute, state),
      );
    return Promise.resolve(
      path === "project" || path === "project/10000"
        ? projectWrite(request, state)
        : (structureWrite(path, request, state) ??
            fixtureWrite(absolute, request.bodyJson, state, request.upload)),
    );
  });
}
function connection(http: AtlassianHttpBodyPort): JiraManagedConnection {
  const bytes = new TextEncoder().encode("Governed attachment fixture");
  return {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http,
    attachmentSource: () =>
      Promise.resolve({
        ok: true,
        content: {
          name: "note.txt",
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
  };
}
interface Observation {
  readonly requests: readonly AtlassianHttpBodyRequest[];
  readonly result: ManagedMcpToolResult;
  readonly definition: Extract<JiraOperationDefinition, { readonly kind: "native" }>;
}
async function observe(scenario: Scenario): Promise<Observation> {
  const http = remote();
  const executor: JiraManagedMutationExecutor<ManagedMcpInvocationContext> = async (
    _operation,
    _args,
    _context,
    execute,
  ) => {
    const attempt = await execute(http);
    expect(attempt).toMatchObject({ ok: true });
    return { data: { outcome: "succeeded", ...attempt.receipt } };
  };
  const provider = createJiraProviderForCatalog(() => connection(http), [scenario.tool], executor);
  const tool = provider.tools()[0];
  const contract = jiraOperationForTool(scenario.tool);
  if (tool === undefined || contract?.definition.kind !== "native")
    throw new TypeError("Missing native fixture operation");
  expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, scenario.args)).toBeUndefined();
  const result = await tool.execute(structuredClone(scenario.args), {
    invocationId: "transport-contract",
    correlationId: "transport-contract",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  });
  expect(result).toMatchObject({
    data: { outcome: "succeeded", operationBinding: contract.binding },
  });
  expect(result.isError).toBeUndefined();
  return {
    requests: http.mock.calls.map(([request]) => request),
    result,
    definition: contract.definition,
  };
}
function assertPrimary(observation: Observation, scenario: Scenario): void {
  const { definition, requests } = observation;
  const primary = requests
    .filter((request) => request.method === definition.method)
    .at(scenario.primaryMethodIndex ?? 0);
  if (primary === undefined) throw new TypeError("No native operation was dispatched");
  const expectedPath =
    definition.apiRoot +
    definition.pathTemplate.replaceAll(/\{([^{}]+)\}/gu, (_match, parameter: string) => {
      const value = scenario.parameters?.[parameter];
      if (value === undefined) throw new TypeError(`Missing fixture path parameter ${parameter}`);
      return encodeURIComponent(value);
    });
  const actual = new URL(primary.url);
  expect([primary.method, actual.origin, actual.pathname]).toEqual([
    definition.method,
    "https://jira.example.invalid",
    `/context${expectedPath}`,
  ]);
  expect(Object.fromEntries(actual.searchParams)).toEqual(scenario.query ?? {});
  expect(definition.identity).toBe(
    `${primary.method} ${definition.apiRoot}${definition.pathTemplate}`,
  );
}

describe("native Jira registry and real connector transport agreement", () => {
  it("covers every current platform native operation exactly once", () => {
    const platformRoots = new Set(["/rest/api/2"]);
    const native = jiraOperationContracts().filter(
      ({ definition }) => definition.kind === "native" && platformRoots.has(definition.apiRoot),
    );
    expect(native).toHaveLength(31);
    expect(SCENARIOS).toHaveLength(native.length);
    expect(new Set(SCENARIOS.map(({ tool }) => tool))).toEqual(
      new Set(native.map(({ definition }) => definition.tool)),
    );
  });
  it.each(SCENARIOS)("binds $tool to its actual primary HTTP request", async (scenario) => {
    const observed = await observe(scenario);
    assertPrimary(observed, scenario);
    const writes = observed.requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(observed.definition.method === "GET" ? 0 : 1);
  });
  it.each(["jira.create", "jira.edit"] as const)(
    "keeps %s's approved link continuation on POST issueLink",
    async (tool) => {
      const original = SCENARIOS.find((scenario) => scenario.tool === tool);
      if (original === undefined) throw new TypeError("Missing linked mutation fixture");
      const scenario = {
        ...original,
        args: {
          ...original.args,
          links: [
            { type: "Relates", direction: "outward", issueKey: "SYN-2" },
            { type: "Relates", direction: "outward", issueKey: "SYN-3" },
          ],
        },
      };
      const observed = await observe(scenario);
      assertPrimary(observed, scenario);
      expect(observed.definition.continuationPolicy).toBe("approved-issue-links");
      const writes = observed.requests.filter((request) => request.method !== "GET");
      expect(writes).toHaveLength(2);
      const continuation = writes[1];
      expect([continuation?.method, continuation?.url]).toEqual([
        "POST",
        "https://jira.example.invalid/context/rest/api/2/issueLink",
      ]);
      expect(JSON.parse(continuation?.bodyJson ?? "{}")).toEqual({
        type: { name: "Relates" },
        inwardIssue: { key: "SYN-1" },
        outwardIssue: { key: "SYN-3" },
      });
    },
  );
});
