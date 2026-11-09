import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ExternalMcpTool,
  ManagedMcpHost,
  ManagedMcpInvocationContext,
  ManagedMcpLogPort,
  ManagedMcpProvider,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  createManagedMcpHost,
  ManagedMcpError,
  MANAGED_MCP_TOOLS_MAX,
} from "@oscharko-dev/keiko-mcp";
import { ToolCatalogError } from "@oscharko-dev/keiko-tool-catalog";
import {
  createJiraCatalogDiscoveryProvider,
  JIRA_CATALOG_DISCOVERY_TOOLS,
  jiraToolsForIdentities,
  type JiraCatalogDiscoveryContext,
} from "../atlassian/jiraCatalogDiscovery.js";
import { CatalogDispatchFault, requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import type { CodingJiraTool } from "./codingJiraPodBinding.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "../diagnostics-log.js";

export function isCodingJiraDiscovery(
  name: string,
): name is (typeof JIRA_CATALOG_DISCOVERY_TOOLS)[number] {
  return name === "jira.discover" || name === "jira.describe";
}
function advertised<Context extends ManagedMcpInvocationContext>(
  host: ManagedMcpHost<Context>,
): readonly ExternalMcpTool[] {
  return Object.freeze(
    host.catalog().map(({ name, descriptor }) =>
      Object.freeze({
        name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      }),
    ),
  );
}
export interface CodingJiraCatalog<Context extends ManagedMcpInvocationContext> {
  readonly ready: Promise<void>;
  readonly tools: readonly ExternalMcpTool[];
  readonly call: (
    name: string,
    args: CatalogJsonObject,
    context: Context,
  ) => Promise<CatalogJsonObject>;
  readonly close: () => Promise<void>;
}

async function retire<Context extends ManagedMcpInvocationContext>(
  host: ManagedMcpHost<Context> | undefined,
  correlationId: string,
): Promise<void> {
  try {
    await host?.close();
  } catch (error) {
    // ManagedHost marks itself closed and aborts before awaiting SDK teardown. Once the new
    // selection is published, a teardown failure cannot turn it into a refused selection.
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId,
        operation: "coding.jira-pod.catalog-cleanup",
        source: "coding.jira-pod",
        error,
        redact: () => DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      }),
    );
  }
}

interface CodingJiraCatalogInput<Context extends ManagedMcpInvocationContext> {
  readonly tools: readonly CodingJiraTool[];
  readonly provider: (tools: readonly CodingJiraTool[]) => ManagedMcpProvider<Context>;
  readonly log: ManagedMcpLogPort;
  readonly correlationId: string;
  readonly admitted: (tool: CodingJiraTool, context: ManagedMcpInvocationContext) => boolean;
  /** Undefined is unavailable accounting, distinct from an exhausted observed budget. */
  readonly fits: (
    tools: readonly ExternalMcpTool[],
    result: CatalogJsonObject,
  ) => boolean | undefined;
}
class JiraCatalogSelection<Context extends ManagedMcpInvocationContext> {
  readonly discovery: ManagedMcpHost<JiraCatalogDiscoveryContext>;
  private initial: readonly ExternalMcpTool[];
  tools: readonly ExternalMcpTool[];
  selected: ManagedMcpHost<Context> | undefined;
  selecting = false;
  active = 0;
  closed = false;

  constructor(private readonly input: CodingJiraCatalogInput<Context>) {
    const allowed = new Set<string>(input.tools);
    this.discovery = createManagedMcpHost<JiraCatalogDiscoveryContext>({
      providers: [createJiraCatalogDiscoveryProvider({ tools: allowed, nativeToolNames: true })],
      log: input.log,
    });
    this.initial = Object.freeze([]);
    this.tools = this.initial;
  }
  /** Admits the local discovery host; the selection advertises nothing until this settles. */
  async start(): Promise<void> {
    await this.discovery.admit(this.input.correlationId);
    if (this.closed) throw new ManagedMcpError("not-admitted");
    this.initial = advertised(this.discovery);
    this.tools = this.initial;
  }
  private requireCurrent(context: ManagedMcpInvocationContext): void {
    requireDispatch(
      !this.closed && this.active === 0 && !context.signal.aborted && context.beforeEffect(),
      "denied",
      "effect-denied",
    );
  }
  private selectedNames(
    identities: readonly string[],
    context: ManagedMcpInvocationContext,
  ): CodingJiraTool[] {
    return jiraToolsForIdentities(identities).map((name) => {
      const tool = this.input.tools.find((allowedName) => allowedName === name);
      requireDispatch(tool !== undefined, "denied", "effect-denied");
      requireDispatch(this.input.admitted(tool, context), "denied", "effect-denied");
      return tool;
    });
  }
  private requireFittingSelection(
    narrowed: readonly CodingJiraTool[],
    next: readonly ExternalMcpTool[],
    result: CatalogJsonObject,
  ): void {
    if (narrowed.length > 0) {
      const fits = this.input.fits(next, result);
      requireDispatch(fits !== undefined, "failed", "handler-unavailable");
      requireDispatch(fits, "denied", "budget-exhausted");
    }
  }

  async select(
    identities: readonly string[],
    result: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ): Promise<void> {
    this.requireCurrent(context);
    requireDispatch(!this.selecting, "denied", "effect-denied");
    const narrowed = this.selectedNames(identities, context);
    // The same refusal as the Chat catalog: an oversized selection never reaches a host.
    if (narrowed.length > MANAGED_MCP_TOOLS_MAX) throw new ToolCatalogError("input-bound");
    this.selecting = true;
    let candidate: ManagedMcpHost<Context> | undefined;
    try {
      if (narrowed.length > 0)
        candidate = createManagedMcpHost({
          providers: [this.input.provider(narrowed)],
          log: this.input.log,
        });
      await candidate?.admit(context.correlationId);
      const next = [...this.initial, ...(candidate === undefined ? [] : advertised(candidate))];
      requireDispatch(
        Buffer.byteLength(JSON.stringify(next)) <= TOOL_CATALOG_LIMITS.maxResultBytes,
        "denied",
        "budget-exhausted",
      );
      this.requireCurrent(context);
      requireDispatch(
        narrowed.every((name) => this.input.admitted(name, context)),
        "denied",
        "effect-denied",
      );
      this.requireFittingSelection(narrowed, next, result);
      const previous = this.selected;
      this.selected = candidate;
      candidate = undefined;
      this.tools = Object.freeze(next);
      await retire(previous, context.correlationId);
    } catch (error) {
      if (error instanceof ManagedMcpError)
        throw new CatalogDispatchFault("failed", "handler-unavailable", error);
      throw error;
    } finally {
      this.selecting = false;
      await retire(candidate, context.correlationId);
    }
  }
}

/** One run's replaceable subset, using the same managed hosts and local discovery as Chat. */
export function createCodingJiraCatalog<Context extends ManagedMcpInvocationContext>(
  input: CodingJiraCatalogInput<Context>,
): CodingJiraCatalog<Context> {
  const selection = new JiraCatalogSelection(input);
  const ready = selection.start();

  return {
    ready,
    get tools(): readonly ExternalMcpTool[] {
      return selection.tools;
    },
    async call(
      name: string,
      args: CatalogJsonObject,
      context: Context,
    ): Promise<CatalogJsonObject> {
      if (selection.closed || context.signal.aborted || !context.beforeEffect())
        throw new ManagedMcpError("not-admitted");
      if (isCodingJiraDiscovery(name))
        return selection.discovery.call(name, args, {
          ...context,
          jiraDiscoveryResultFits: (result) =>
            Buffer.byteLength(JSON.stringify(result)) <= TOOL_CATALOG_LIMITS.maxResultBytes,
          selectJiraOperations: (identities, result) =>
            selection.select(identities, result, context),
        });
      const host = selection.selected;
      if (
        selection.selecting ||
        host === undefined ||
        !selection.tools.some((tool) => tool.name === name)
      )
        throw new ManagedMcpError("not-admitted", undefined, "none");
      selection.active += 1;
      try {
        return await host.call(name, args, context);
      } finally {
        selection.active -= 1;
      }
    },
    async close(): Promise<void> {
      selection.closed = true;
      selection.tools = Object.freeze([]);
      await Promise.all([selection.discovery.close(), selection.selected?.close()]);
    },
  };
}
