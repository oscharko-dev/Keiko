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
import { recordJiraCatalogSelection } from "../atlassian/jiraCatalogSelectionActivity.js";
import { processServerLogSink } from "../process-log-sink.js";
import type {
  CodingJiraFitBasis,
  CodingJiraSelectionStage,
  CodingJiraTool,
} from "./codingJiraPodBinding.js";
import { CODING_JIRA_SERVER_NAME } from "./codingJiraPodBinding.js";
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
  /** What the accounting stood on, for the body-free line of a refusal it could not establish. */
  readonly fitBasis?: (() => CodingJiraFitBasis) | undefined;
  /** One body-free observation per refused selection: the check that refused, never its input. */
  readonly observeRefusal?: (
    refusal: CodingJiraSelectionRefusal,
    context: ManagedMcpInvocationContext,
  ) => void;
}

/** The closed facts of a refused describe: which check, which fault, what the budget stood on. */
export interface CodingJiraSelectionRefusal {
  readonly stage: CodingJiraSelectionStage;
  readonly reason: "effect-denied" | "handler-unavailable" | "budget-exhausted" | "input-bound";
  readonly fitBasis?: CodingJiraFitBasis | undefined;
}

interface SelectionTrace {
  stage: CodingJiraSelectionStage;
  fitBasis?: CodingJiraFitBasis;
}
class JiraCatalogSelection<Context extends ManagedMcpInvocationContext> {
  readonly discovery: ManagedMcpHost<JiraCatalogDiscoveryContext>;
  private initial: readonly ExternalMcpTool[];
  tools: readonly ExternalMcpTool[];
  selected: ManagedMcpHost<Context> | undefined;
  /** Identities of the published selection, which the next describe replaces. */
  identities: readonly string[] = [];
  selecting = false;
  active = 0;
  closed = false;

  constructor(private readonly input: CodingJiraCatalogInput<Context>) {
    const allowed = new Set<string>(input.tools);
    this.discovery = createManagedMcpHost<JiraCatalogDiscoveryContext>({
      providers: [
        createJiraCatalogDiscoveryProvider({
          tools: allowed,
          nativeToolNames: true,
          callNamespace: CODING_JIRA_SERVER_NAME,
        }),
      ],
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
    trace: SelectionTrace,
  ): CodingJiraTool[] {
    return jiraToolsForIdentities(identities).map((name) => {
      trace.stage = "identity";
      const tool = this.input.tools.find((allowedName) => allowedName === name);
      requireDispatch(tool !== undefined, "denied", "effect-denied");
      trace.stage = "scope";
      requireDispatch(this.input.admitted(tool, context), "denied", "effect-denied");
      return tool;
    });
  }
  /** The checks between a candidate host and its publication, each naming itself for the log. */
  private requireSelectable(
    narrowed: readonly CodingJiraTool[],
    next: readonly ExternalMcpTool[],
    result: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
    trace: SelectionTrace,
  ): void {
    trace.stage = "size";
    requireDispatch(
      Buffer.byteLength(JSON.stringify(next)) <= TOOL_CATALOG_LIMITS.maxResultBytes,
      "denied",
      "budget-exhausted",
    );
    trace.stage = "current";
    this.requireCurrent(context);
    trace.stage = "scope";
    requireDispatch(
      narrowed.every((name) => this.input.admitted(name, context)),
      "denied",
      "effect-denied",
    );
    this.requireFittingSelection(narrowed, next, result, trace);
  }

  private requireFittingSelection(
    narrowed: readonly CodingJiraTool[],
    next: readonly ExternalMcpTool[],
    result: CatalogJsonObject,
    trace: SelectionTrace,
  ): void {
    if (narrowed.length > 0) {
      trace.stage = "fits";
      const fits = this.input.fits(next, result);
      if (this.input.fitBasis !== undefined) trace.fitBasis = this.input.fitBasis();
      requireDispatch(fits !== undefined, "failed", "handler-unavailable");
      requireDispatch(fits, "denied", "budget-exhausted");
    }
  }

  /** Publishes a selection that replaces the previous one and records the replacement. */
  private publish(
    next: readonly ExternalMcpTool[],
    identities: readonly string[],
    correlationId: string,
  ): void {
    this.tools = Object.freeze(next);
    recordJiraCatalogSelection(processServerLogSink(), {
      correlationId,
      surface: "coding",
      previous: this.identities,
      selected: identities,
    });
    this.identities = Object.freeze([...identities]);
  }

  /** Selects like the Chat catalog and reports which check refused, as closed words only. */
  async select(
    identities: readonly string[],
    result: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ): Promise<void> {
    const trace: SelectionTrace = { stage: "current" };
    try {
      await this.selectChecked(identities, result, context, trace);
    } catch (error) {
      const reason = refusalReason(error);
      if (reason !== undefined)
        this.input.observeRefusal?.(
          {
            stage: trace.stage,
            reason,
            ...(trace.fitBasis === undefined ? {} : { fitBasis: trace.fitBasis }),
          },
          context,
        );
      throw error;
    }
  }

  private async selectChecked(
    identities: readonly string[],
    result: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
    trace: SelectionTrace,
  ): Promise<void> {
    this.requireCurrent(context);
    trace.stage = "busy";
    requireDispatch(!this.selecting, "denied", "effect-denied");
    const narrowed = this.selectedNames(identities, context, trace);
    // The same refusal as the Chat catalog: an oversized selection never reaches a host.
    trace.stage = "size";
    if (narrowed.length > MANAGED_MCP_TOOLS_MAX) throw new ToolCatalogError("input-bound");
    this.selecting = true;
    let candidate: ManagedMcpHost<Context> | undefined;
    try {
      if (narrowed.length > 0)
        candidate = createManagedMcpHost({
          providers: [this.input.provider(narrowed)],
          log: this.input.log,
        });
      trace.stage = "admit";
      await candidate?.admit(context.correlationId);
      const next = [...this.initial, ...(candidate === undefined ? [] : advertised(candidate))];
      this.requireSelectable(narrowed, next, result, context, trace);
      const previous = this.selected;
      this.selected = candidate;
      candidate = undefined;
      this.publish(next, identities, context.correlationId);
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

/** The closed fault a refused selection carries; anything else is not a refusal of this catalog. */
function refusalReason(error: unknown): CodingJiraSelectionRefusal["reason"] | undefined {
  if (error instanceof ToolCatalogError)
    return error.reason === "input-bound" ? "input-bound" : undefined;
  if (error instanceof ManagedMcpError) return "handler-unavailable";
  if (!(error instanceof CatalogDispatchFault)) return undefined;
  if (error.reason === "budget-exhausted") return "budget-exhausted";
  return error.reason === "handler-unavailable" ? "handler-unavailable" : "effect-denied";
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
          selectedJiraOperations: () => selection.identities,
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
