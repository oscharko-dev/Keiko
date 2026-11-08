import { expect } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
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
  createJiraProviderForCatalog,
  jiraOperationForTool,
} from "../../packages/keiko-server/src/atlassian/jiraManagedProvider.js";
import type {
  JiraOperationDefinition,
  JiraOperationTool,
} from "../../packages/keiko-server/src/atlassian/jiraOperationRegistry.js";
import { FINAL_EXPECTED_OUTCOMES } from "./jira-managed-final-scenarios.js";

export interface Scenario {
  readonly tool: JiraOperationTool;
  readonly args: CatalogJsonObject;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly primaryMethodIndex?: number;
  /** Only explicitly documented native absence or aggregate-reference proof limits opt in. */
  readonly expectedOutcome?: "succeeded-unconfirmed";
  readonly expectedReceipt?: CatalogJsonObject;
  /** Independent literal native fixture route, never constructed from the production registry. */
  readonly expectedPrimary?: {
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly apiRoot: "/rest/api/2" | "/rest/auth/1" | "/rest/agile/1.0";
    /** Independent concrete route, including its complete query when present. */
    readonly path: string;
  };
}
export interface Observation {
  readonly requests: readonly AtlassianHttpBodyRequest[];
  readonly result: ManagedMcpToolResult;
  readonly definition: Extract<JiraOperationDefinition, { readonly kind: "native" }>;
}
const UNCONFIRMED_NATIVE_OPERATIONS: ReadonlySet<string> = new Set([
  ...Object.entries(FINAL_EXPECTED_OUTCOMES).filter(([, outcome]) => outcome === "succeeded-unconfirmed").map(([name]) => name),
  "jira.add-group-user",
  "jira.add-user-application",
  "jira.approve-cluster-upgrade",
  "jira.cancel-cluster-upgrade",
  "jira.create-custom-field",
  "jira.create-index-snapshot",
  "jira.create-issue-type",
  "jira.delete-cluster-node",
  "jira.delete-custom-fields",
  "jira.delete-group",
  "jira.delete-issue-type",
  "jira.delete-link-type",
  "jira.mark-cluster-node-offline",
  "jira.move-link-type",
  "jira.notify-issue",
  "jira.process-reindex-requests",
  "jira.reindex-issues",
  "jira.remove-group-user",
  "jira.remove-user-application",
  "jira.request-cluster-index-snapshot",
  "jira.reset-link-type-order",
  "jira.reset-user-columns",
  "jira.retry-cluster-upgrade",
  "jira.run-upgrade",
  "jira.set-application-role",
  "jira.set-application-roles",
  "jira.start-cluster-upgrade",
  "jira.start-reindex",

  "jira.delete-issue-type-scheme", "jira.add-issue-type-scheme-projects", "jira.set-issue-type-scheme-projects",
  "jira.clear-issue-type-scheme-projects", "jira.remove-issue-type-scheme-project", "jira.delete-priority-scheme",
  "jira.delete-workflow-scheme", "jira.set-workflow-scheme-default", "jira.delete-workflow-scheme-default",
  "jira.set-workflow-scheme-issue-type", "jira.delete-workflow-scheme-issue-type",
  "jira.set-workflow-scheme-workflow", "jira.delete-workflow-scheme-workflow", "jira.set-instance-base-url",
  "jira.upload-email-template-pack", "jira.apply-email-template-pack", "jira.revert-email-template-pack",
  "jira.delete-filter", "jira.delete-my-preference", "jira.delete-component",
  "jira.merge-version", "jira.remove-and-swap-version",
  "jira.add-default-screen-field", "jira.delete-board",
  "jira.delete-sprint", "jira.swap-sprints", "jira.unmap-all-sprints",
  "jira.delete-project-category", "jira.rank-epic", "jira.rank-issues",
  "jira.delete-permission-scheme", "jira.delete-role", "jira.add-role-default-actors",
  "jira.delete-role-default-actor", "jira.add-project-role-actors",
  "jira.set-project-role-actors", "jira.delete-project-role-actor",
]);
export async function observeNativeJiraOperation(
  scenario: Scenario,
  supplied: JiraManagedConnection,
  privateRequests: readonly AtlassianHttpBodyRequest[] = [],
): Promise<Observation> {
  const requests: AtlassianHttpBodyRequest[] = [];
  const http: AtlassianHttpBodyPort = (request) => {
    requests.push(request);
    return supplied.http(request);
  };
  const executor: JiraManagedMutationExecutor<ManagedMcpInvocationContext> = async (
    operation,
    _args,
    _context,
    execute,
  ) => {
    const attempt = await execute(http);
    if (scenario.expectedOutcome === "succeeded-unconfirmed") {
      if (!UNCONFIRMED_NATIVE_OPERATIONS.has(operation))
        throw new TypeError(
          "Only the declared native proof limitations may expect an unconfirmed transport result",
        );
      if (scenario.expectedReceipt === undefined)
        throw new TypeError(
          "An unconfirmed deletion must retain an independently specified known receipt",
        );
      expect(attempt).toMatchObject({
        ok: false,
        reason: "unavailable",
        receipt: scenario.expectedReceipt,
      });
      if (attempt.ok || attempt.receipt === undefined)
        throw new TypeError("Expected acknowledged, unconfirmed deletion with known target");
      return {
        data: { outcome: "succeeded-unconfirmed", reason: attempt.reason, ...attempt.receipt },
        isError: true,
      };
    }
    expect(attempt).toMatchObject({ ok: true });
    return { data: { outcome: "succeeded", ...attempt.receipt } };
  };
  const provider = createJiraProviderForCatalog(
    () => ({ ...supplied, http }),
    [scenario.tool],
    executor,
  );
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
    data: { outcome: scenario.expectedOutcome ?? "succeeded", operationBinding: contract.binding },
  });
  if (scenario.expectedOutcome === "succeeded-unconfirmed") {
    expect(result).toMatchObject({
      isError: true,
      data: { reason: "unavailable", ...scenario.expectedReceipt },
    });
  } else expect(result.isError).toBeUndefined();
  return {
    requests: [...requests, ...privateRequests],
    result,
    definition: contract.definition,
  };
}
export function assertNativeJiraPrimary(observation: Observation, scenario: Scenario): void {
  const expected = scenario.expectedPrimary;
  if (expected === undefined) throw new TypeError("Missing independent native primary expectation");
  const primary = observation.requests
    .filter((request) => request.method === expected.method)
    .at(scenario.primaryMethodIndex ?? 0);
  if (primary === undefined) throw new TypeError("No independent native operation was dispatched");
  expect([primary.method, primary.url]).toEqual([expected.method,
    `https://jira.example.invalid/context${expected.apiRoot}/${expected.path}`]);
  expect([observation.definition.method, observation.definition.apiRoot]).toEqual([expected.method, expected.apiRoot]);
}

/** Registry agreement is additional consistency evidence, never an independent native oracle. */
export function assertNativeJiraRegistryAgreement(observation: Observation, scenario: Scenario): void {
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
