import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ExternalMcpTool, ManagedMcpHost, ManagedMcpInvocationContext, ManagedMcpLogPort, ManagedMcpProvider } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createManagedMcpHost, ManagedMcpError } from "@oscharko-dev/keiko-mcp";
import { createJiraCatalogDiscoveryProvider, JIRA_CATALOG_DISCOVERY_TOOLS, jiraToolsForIdentities, type JiraCatalogDiscoveryContext } from "../atlassian/jiraCatalogDiscovery.js";
import { CatalogDispatchFault, requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import type { CodingJiraTool } from "./codingJiraPodBinding.js";
import { DEFAULT_SERVER_DIAGNOSTIC_SUMMARY, emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

export function isCodingJiraDiscovery(name: string): name is (typeof JIRA_CATALOG_DISCOVERY_TOOLS)[number] {
  return name === "jira.discover" || name === "jira.describe";
}
function advertised<Context extends ManagedMcpInvocationContext>(host: ManagedMcpHost<Context>): readonly ExternalMcpTool[] {
  return Object.freeze(host.catalog().map(({ name, descriptor }) => Object.freeze({ name,
    description: descriptor.description, inputSchema: descriptor.inputSchema })));
}
export interface CodingJiraCatalog<Context extends ManagedMcpInvocationContext> {
  readonly ready: Promise<void>;
  readonly tools: readonly ExternalMcpTool[];
  readonly call: (name: string, args: CatalogJsonObject, context: Context) => Promise<CatalogJsonObject>;
  readonly close: () => Promise<void>;
}

async function retire<Context extends ManagedMcpInvocationContext>(
  host: ManagedMcpHost<Context> | undefined, correlationId: string,
): Promise<void> {
  try { await host?.close(); }
  catch (error) {
    // ManagedHost marks itself closed and aborts before awaiting SDK teardown. Once the new
    // selection is published, a teardown failure cannot turn it into a refused selection.
    emitServerDiagnostic(undefined, serverDiagnosticFromError({ correlationId,
      operation: "coding.jira-pod.catalog-cleanup", source: "coding.jira-pod", error,
      redact: () => DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
    }));
  }
}

/** One run's replaceable subset, using the same managed hosts and local discovery as Chat. */
export function createCodingJiraCatalog<Context extends ManagedMcpInvocationContext>(input: {
  readonly tools: readonly CodingJiraTool[];
  readonly provider: (tools: readonly CodingJiraTool[]) => ManagedMcpProvider<Context>;
  readonly log: ManagedMcpLogPort;
  readonly correlationId: string;
  readonly admitted: (tool: CodingJiraTool, context: ManagedMcpInvocationContext) => boolean;
}): CodingJiraCatalog<Context> {
  const allowed = new Set<string>(input.tools);
  const discovery = createManagedMcpHost<JiraCatalogDiscoveryContext>({
    providers: [createJiraCatalogDiscoveryProvider({ tools: allowed, nativeToolNames: true })], log: input.log,
  });
  const initial = advertised(discovery);
  let tools = initial;
  let selected: ManagedMcpHost<Context> | undefined;
  let selecting = false;
  let active = 0;
  let closed = false;

  function requireCurrent(context: ManagedMcpInvocationContext): void {
    requireDispatch(!closed && active === 0 && !context.signal.aborted && context.beforeEffect(), "denied", "effect-denied");
  }
  function selectedNames(identities: readonly string[], context: ManagedMcpInvocationContext): CodingJiraTool[] {
    return jiraToolsForIdentities(identities).map((name) => {
      const tool = input.tools.find((allowedName) => allowedName === name);
      requireDispatch(tool !== undefined, "denied", "effect-denied");
      requireDispatch(input.admitted(tool, context), "denied", "effect-denied");
      return tool;
    });
  }

  async function select(identities: readonly string[], context: ManagedMcpInvocationContext): Promise<void> {
    requireCurrent(context);
    requireDispatch(!selecting, "denied", "effect-denied");
    const narrowed = selectedNames(identities, context);
    selecting = true;
    let candidate: ManagedMcpHost<Context> | undefined;
    try {
      if (narrowed.length > 0)
        candidate = createManagedMcpHost({ providers: [input.provider(narrowed)], log: input.log });
      const next = [...initial, ...(candidate === undefined ? [] : advertised(candidate))];
      requireDispatch(Buffer.byteLength(JSON.stringify(next)) <= TOOL_CATALOG_LIMITS.maxResultBytes, "denied", "budget-exhausted");
      await candidate?.admit(context.correlationId);
      requireCurrent(context);
      requireDispatch(narrowed.every((name) => input.admitted(name, context)), "denied", "effect-denied");
      const previous = selected;
      selected = candidate;
      candidate = undefined;
      tools = Object.freeze(next);
      await retire(previous, context.correlationId);
    } catch (error) {
      if (error instanceof ManagedMcpError)
        throw new CatalogDispatchFault("failed", "handler-unavailable", error);
      throw error;
    } finally {
      selecting = false;
      await retire(candidate, context.correlationId);
    }
  }

  return {
    ready: discovery.admit(input.correlationId),
    get tools(): readonly ExternalMcpTool[] { return tools; },
    async call(name: string, args: CatalogJsonObject, context: Context): Promise<CatalogJsonObject> {
      if (closed || context.signal.aborted || !context.beforeEffect()) throw new ManagedMcpError("not-admitted");
      if (isCodingJiraDiscovery(name)) return discovery.call(name, args, { ...context,
        jiraDiscoveryResultFits: (result) => Buffer.byteLength(JSON.stringify(result)) <= TOOL_CATALOG_LIMITS.maxResultBytes,
        selectJiraOperations: (identities) => select(identities, context),
      });
      const host = selected;
      if (selecting || host === undefined || !tools.some((tool) => tool.name === name))
        throw new ManagedMcpError("not-admitted", undefined, "none");
      active += 1;
      try { return await host.call(name, args, context); }
      finally { active -= 1; }
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all([discovery.close(), selected?.close()]);
    },
  };
}
