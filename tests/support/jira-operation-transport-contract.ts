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

export interface Scenario {
  readonly tool: JiraOperationTool;
  readonly args: CatalogJsonObject;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly primaryMethodIndex?: number;
  /** Only explicitly documented native absence or aggregate-reference proof limits opt in. */
  readonly expectedOutcome?: "succeeded-unconfirmed";
  readonly expectedReceipt?: CatalogJsonObject;
}
export interface Observation {
  readonly requests: readonly AtlassianHttpBodyRequest[];
  readonly result: ManagedMcpToolResult;
  readonly definition: Extract<JiraOperationDefinition, { readonly kind: "native" }>;
}
const UNCONFIRMED_NATIVE_OPERATIONS: ReadonlySet<string> = new Set([
  "jira.delete-filter", "jira.delete-my-preference", "jira.delete-component",
  "jira.merge-version", "jira.remove-and-swap-version",
]);
export async function observeNativeJiraOperation(
  scenario: Scenario,
  supplied: JiraManagedConnection,
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
    requests,
    result,
    definition: contract.definition,
  };
}
export function assertNativeJiraPrimary(observation: Observation, scenario: Scenario): void {
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
