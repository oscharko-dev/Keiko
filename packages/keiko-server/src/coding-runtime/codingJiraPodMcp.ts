import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpRequest,
  JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type {
  JiraMutationAttempt,
  JiraMutationOperation,
  JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ExternalMcpConnection,
  ManagedMcpHost,
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  createManagedMcpHost,
  createMcpRelayEndpoint,
  ManagedMcpError,
} from "@oscharko-dev/keiko-mcp";

import type { AtlassianConnectorCredentialDeps } from "../atlassian/credentialRoutes.js";
import { createJiraProviderForCatalog } from "../atlassian/jiraManagedProvider.js";
import {
  jiraAttemptToolResult,
  jiraLinkCountsOfResult,
  validJiraMutationAttempt,
} from "../atlassian/jiraMutationResult.js";
import { jiraIssueTemplateSource, recordJiraTemplateAttempt } from "../atlassian/jiraTemplateLog.js";
import type { JiraPodAccessDeps, JiraLivePodCredential } from "../atlassian/jiraPodAccess.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ConfiguredMcpConnections } from "../mcp/mcpConfiguredConnections.js";

import {
  bindingOfCredential,
  CODING_JIRA_SERVER_NAME,
  CODING_JIRA_TOOL_RISKS,
  currentBoundCodingJiraPod,
  currentCodingJiraPod,
  recordCodingJiraPod,
  type CodingJiraPodBinding,
  type CodingJiraPodLine,
  type CodingJiraPodRefusal,
  type CodingJiraPodResolution,
  type CodingJiraTool,
} from "./codingJiraPodBinding.js";

/**
 * Keiko's managed Jira provider as a Coding run's MCP server (owner decision 2026-10-30). The
 * production relay already serves every managed server of a native run through
 * `ConfiguredMcpConnections`; this adapter serves the run's bound Pod through the same relay
 * endpoint and the same managed MCP host Chat uses (descriptor drift, result validation, deadlines
 * and `mcp.managed.lifecycle` lines are the host's). The Pod credential never leaves custody: the
 * provider receives a transport that adds it, and every effect is gated on the Pod still being the
 * exact credential the human chose when the run started.
 */

export interface CodingJiraPodDeps extends JiraPodAccessDeps {
  /** The skill library holds the customer-defined issue templates every Jira write is checked by. */
  readonly store?: Pick<UiHandlerDeps["store"], "markdownSkills"> | undefined;
  readonly atlassianConnectorCredentials?:
    Pick<AtlassianConnectorCredentialDeps, "custody" | "httpBodyPortFactory"> | undefined;
}

export type CodingJiraConnections = Pick<ConfiguredMcpConnections, "generation" | "serve">;

export interface CodingJiraPods {
  /** Before the start confirmation is consumed: the caller's own, ready Pod, or a closed reason. */
  readonly resolve: (podId: string) => CodingJiraPodResolution;
  /** The start's binding decision, one body-free line under the run's correlation. */
  readonly recordBind: (
    correlationId: string,
    decision:
      | { readonly outcome: "bound" }
      | { readonly outcome: "refused"; readonly reason: CodingJiraPodRefusal },
  ) => void;
  /** The relay's view of a run: the registry's servers as before, plus the bound Pod's tools. */
  readonly connections: (
    base: CodingJiraConnections | undefined,
    binding: CodingJiraPodBinding,
  ) => CodingJiraConnections;
  /** Late binding: the custody graph exists only after the coding runtime was composed. */
  readonly attach: (deps: CodingJiraPodDeps) => void;
  readonly close: () => Promise<void>;
}

interface PodEntry {
  readonly binding: CodingJiraPodBinding;
  readonly lifetime: AbortController;
  readonly ready: Promise<ReturnType<typeof createMcpRelayEndpoint>>;
  readonly host: ManagedMcpHost<ManagedMcpInvocationContext>;
}

const ENTRY_MAX = 8;
const NOT_ADMITTED = (): ManagedMcpError => new ManagedMcpError("not-admitted");

interface Dispatch {
  dispatched: boolean;
  acknowledged: boolean;
}

function mutationOutcome(attempt: JiraMutationAttempt, dispatch: Dispatch): JiraMutationOutcome {
  if (!dispatch.dispatched) return attempt.ok ? "unknown" : "rejected";
  if (!dispatch.acknowledged) return "unknown";
  return attempt.ok ? "succeeded" : "succeeded-unconfirmed";
}

function isWrite(request: AtlassianHttpRequest | AtlassianHttpBodyRequest): boolean {
  return request.method !== "GET";
}

function callToolResult(data: CatalogJsonObject, isError: boolean): CatalogJsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

function toolOf(name: string): CodingJiraTool | undefined {
  return Object.hasOwn(CODING_JIRA_TOOL_RISKS, name) ? (name as CodingJiraTool) : undefined;
}

type CallLine = Pick<CodingJiraPodLine, "action" | "tool" | "risk">;

/** Link counts of a Jira write result, for its one body-free decision line (#4176). */
function linkLineCounts(
  data: CatalogJsonObject | undefined,
): Pick<CodingJiraPodLine, "linkRequestedCount" | "linkCreatedCount" | "linkFailedCount"> {
  const counts = jiraLinkCountsOfResult(data);
  return counts === undefined
    ? {}
    : {
        linkRequestedCount: counts.requested,
        linkCreatedCount: counts.created,
        linkFailedCount: counts.failed,
      };
}

/** The result a provider reported with its failure; absent for any other kind of failure. */
function providerResult(error: unknown): CatalogJsonObject | undefined {
  return error instanceof ManagedMcpError ? error.structuredResult : undefined;
}

class CodingJiraPodService implements CodingJiraPods {
  readonly #entries = new Map<string, PodEntry>();
  readonly #disposed = new WeakSet<PodEntry>();
  #deps: CodingJiraPodDeps | undefined;
  #closed = false;

  public constructor(private readonly log: ServerLogSink | undefined) {}

  public attach(deps: CodingJiraPodDeps): void {
    this.#deps = deps;
  }

  public resolve(podId: string): CodingJiraPodResolution {
    const deps = this.#deps;
    if (deps === undefined || this.#closed) return { ok: false, reason: "unavailable" };
    const current = currentCodingJiraPod(deps, podId);
    return current.ok ? { ok: true, binding: bindingOfCredential(current.credential) } : current;
  }

  public recordBind: CodingJiraPods["recordBind"] = (correlationId, decision) => {
    recordCodingJiraPod(this.log, correlationId, {
      action: "bind",
      ...decision,
      ...(decision.outcome === "bound"
        ? { toolCount: Object.keys(CODING_JIRA_TOOL_RISKS).length }
        : {}),
    });
  };

  public connections(
    base: CodingJiraConnections | undefined,
    binding: CodingJiraPodBinding,
  ): CodingJiraConnections {
    return {
      generation: (server, correlationId) =>
        this.isJira(server)
          ? this.jiraGeneration(binding, correlationId)
          : this.requireBase(base).generation(server, correlationId),
      serve: async (name, request, context) =>
        name === CODING_JIRA_SERVER_NAME
          ? this.serveJira(binding, request, context)
          : this.requireBase(base).serve(name, request, context),
    };
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((entry) => this.dispose(entry)));
  }

  /** A Pod that is no longer the chosen one yields a revoked signal, so no relay is bound for it. */
  private jiraGeneration(binding: CodingJiraPodBinding, correlationId: string): AbortSignal {
    return this.current(binding) === undefined
      ? AbortSignal.abort()
      : this.entry(binding, correlationId).lifetime.signal;
  }

  private isJira(server: McpServerDefinition): boolean {
    return server.name === CODING_JIRA_SERVER_NAME;
  }

  private requireBase(base: CodingJiraConnections | undefined): CodingJiraConnections {
    if (base === undefined) throw NOT_ADMITTED();
    return base;
  }

  private key(binding: CodingJiraPodBinding): string {
    return `${binding.podId}:${String(binding.authenticationGeneration)}:${String(binding.verificationRevision)}`;
  }

  /** The credential of the bound Pod when it is still exactly the one the human chose. */
  private current(binding: CodingJiraPodBinding): JiraLivePodCredential | undefined {
    const deps = this.#deps;
    const current = deps === undefined ? undefined : currentBoundCodingJiraPod(deps, binding);
    if (current?.ok === true) return current.credential;
    // A changed or revoked Pod ends the binding for good: later calls fail without any HTTP.
    this.#entries.get(this.key(binding))?.lifetime.abort();
    return undefined;
  }

  private entry(binding: CodingJiraPodBinding, correlationId: string): PodEntry {
    if (this.#closed) throw NOT_ADMITTED();
    const key = this.key(binding);
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.lifetime.signal.aborted) return existing;
    if (existing !== undefined) void this.dispose(existing);
    this.evictOldest();
    const created = this.open(binding, correlationId);
    this.#entries.set(key, created);
    created.lifetime.signal.addEventListener(
      "abort",
      () => {
        void this.forget(key, created);
      },
      { once: true },
    );
    return created;
  }

  private evictOldest(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size < ENTRY_MAX) break;
      this.#entries.delete(key);
      void this.dispose(entry);
    }
  }

  private async forget(key: string, entry: PodEntry): Promise<void> {
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    await this.dispose(entry);
  }

  private async dispose(entry: PodEntry): Promise<void> {
    entry.lifetime.abort();
    if (this.#disposed.has(entry)) return;
    this.#disposed.add(entry);
    try {
      await entry.ready.then(
        (endpoint) => endpoint.close(),
        () => undefined,
      );
      await entry.host.close();
    } catch (error) {
      recordCodingJiraPod(this.log, UNKNOWN_CORRELATION_ID, {
        action: "call",
        outcome: "failed",
        reason: "internal",
        error,
      });
    }
  }

  private open(binding: CodingJiraPodBinding, correlationId: string): PodEntry {
    const lifetime = new AbortController();
    const host = createManagedMcpHost<ManagedMcpInvocationContext>({
      providers: [
        createJiraProviderForCatalog(
          (context) => this.connection(binding, context),
          Object.keys(CODING_JIRA_TOOL_RISKS) as CodingJiraTool[],
          (operation, _args, context, execute) => this.mutate(binding, operation, context, execute),
        ),
      ],
      log: this.log ?? { write: (): void => undefined },
    });
    const ready = host
      .admit(correlationId)
      .then(() =>
        createMcpRelayEndpoint(
          this.hostConnection(host, lifetime.signal, binding),
          CODING_JIRA_TOOL_RISKS,
        ),
      );
    // A host that cannot be admitted ends the binding; the rejection reaches the awaiting serve.
    ready.catch((error: unknown) => {
      lifetime.abort();
      recordCodingJiraPod(this.log, correlationId, {
        action: "call",
        outcome: "failed",
        reason: "internal",
        error,
      });
    });
    return { binding, lifetime, ready, host };
  }

  private async serveJira(
    binding: CodingJiraPodBinding,
    request: Request,
    context: ManagedMcpInvocationContext,
  ): Promise<Response> {
    if (this.current(binding) === undefined) {
      // The request names its tool only inside the MCP body, so this line carries none.
      recordCodingJiraPod(this.log, context.correlationId, {
        action: "call",
        outcome: "refused",
        reason: "pod-changed",
      });
      throw NOT_ADMITTED();
    }
    const endpoint = await this.entry(binding, context.correlationId).ready;
    return endpoint.fetch(request, context);
  }

  private connection(
    binding: CodingJiraPodBinding,
    context: ManagedMcpInvocationContext,
  ): JiraManagedConnection {
    const credential = this.current(binding);
    const factory = this.#deps?.atlassianConnectorCredentials?.httpBodyPortFactory;
    if (credential === undefined || factory === undefined) throw NOT_ADMITTED();
    return {
      baseUrl: credential.baseUrl,
      deployment: credential.deployment,
      http: factory(credential, context.correlationId, {
        beforeDispatch: () => this.admit(binding, context),
      }),
      ...(this.#deps?.store === undefined
        ? {}
        : { issueTemplates: jiraIssueTemplateSource(this.#deps.store) }),
    };
  }

  /** Every request, read or write, is gated on the run and on the Pod being exactly as chosen. */
  private admit(binding: CodingJiraPodBinding, context: ManagedMcpInvocationContext): boolean {
    return !context.signal.aborted && context.beforeEffect() && this.current(binding) !== undefined;
  }

  private async mutate(
    binding: CodingJiraPodBinding,
    operation: JiraMutationOperation,
    context: ManagedMcpInvocationContext,
    execute: (http: AtlassianHttpBodyPort) => Promise<JiraMutationAttempt>,
  ): Promise<ManagedMcpToolResult> {
    const credential = this.current(binding);
    const factory = this.#deps?.atlassianConnectorCredentials?.httpBodyPortFactory;
    if (credential === undefined || factory === undefined) throw NOT_ADMITTED();
    const dispatch: Dispatch = { dispatched: false, acknowledged: false };
    const http = this.trackedTransport(factory, credential, binding, context, dispatch);
    let attempt: JiraMutationAttempt;
    try {
      attempt = validJiraMutationAttempt(await execute(http), operation);
      recordJiraTemplateAttempt(context.correlationId, operation, attempt);
    } catch (error) {
      recordCodingJiraPod(this.log, context.correlationId, {
        action: "call",
        outcome: "failed",
        reason: "internal",
        tool: operation,
        risk: "write",
        error,
      });
      attempt = { ok: false, reason: "unavailable" };
    }
    return jiraAttemptToolResult(mutationOutcome(attempt, dispatch), attempt);
  }

  private trackedTransport(
    factory: NonNullable<CodingJiraPodDeps["atlassianConnectorCredentials"]>["httpBodyPortFactory"],
    credential: AtlassianCredentialMetadata,
    binding: CodingJiraPodBinding,
    context: ManagedMcpInvocationContext,
    dispatch: Dispatch,
  ): AtlassianHttpBodyPort {
    return factory(credential, context.correlationId, {
      beforeDispatch: (request) => {
        if (!this.admit(binding, context)) return false;
        if (isWrite(request)) dispatch.dispatched = true;
        return true;
      },
      onResponse: (request) => {
        if (isWrite(request)) dispatch.acknowledged = true;
        return true;
      },
    });
  }

  private hostConnection(
    host: ManagedMcpHost<ManagedMcpInvocationContext>,
    signal: AbortSignal,
    binding: CodingJiraPodBinding,
  ): ExternalMcpConnection {
    return {
      signal,
      tools: host.catalog().map(({ name, descriptor }) => ({
        name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      })),
      call: (name, args, context) => this.call(host, binding, name, args, context),
      close: () => host.close(),
    };
  }

  /** One decision line per call: the closed tool, its risk and whether the Pod let it through. */
  private async call(
    host: ManagedMcpHost<ManagedMcpInvocationContext>,
    binding: CodingJiraPodBinding,
    name: string,
    args: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ): Promise<CatalogJsonObject> {
    const tool = toolOf(name);
    const started = Date.now();
    const line: CallLine = {
      action: "call",
      tool,
      risk: tool === undefined ? undefined : CODING_JIRA_TOOL_RISKS[tool],
    };
    if (this.current(binding) === undefined)
      return this.refuseCall(context.correlationId, line, started);
    try {
      const data = await host.call(name, args, context);
      recordCodingJiraPod(this.log, context.correlationId, {
        ...line,
        outcome: "completed",
        ...linkLineCounts(data),
        durationMs: Date.now() - started,
      });
      return callToolResult(data, false);
    } catch (error) {
      const provider = providerResult(error);
      recordCodingJiraPod(this.log, context.correlationId, {
        ...line,
        outcome: "failed",
        reason: provider === undefined ? "internal" : "tool-failed",
        ...linkLineCounts(provider),
        durationMs: Date.now() - started,
        ...(provider === undefined ? { error } : {}),
      });
      // A failure the provider reported is data for the model; any other failure stays a failure.
      if (provider !== undefined) return callToolResult(provider, true);
      throw error instanceof ManagedMcpError ? error : new ManagedMcpError("tool-error");
    }
  }

  private refuseCall(correlationId: string, line: CallLine, started: number): never {
    recordCodingJiraPod(this.log, correlationId, {
      ...line,
      outcome: "refused",
      reason: "pod-changed",
      durationMs: Date.now() - started,
    });
    throw NOT_ADMITTED();
  }
}

/** One service per application graph; hosts open lazily per bound Pod credential. */
export function createCodingJiraPods(log: ServerLogSink | undefined): CodingJiraPods {
  return new CodingJiraPodService(log);
}
