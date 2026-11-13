import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  prepareCodingJiraHumanInput,
  currentCodingJiraInput,
  type CodingJiraCurrentInputResolver,
  type CodingJiraInputAuthority,
  type PendingCodingJiraInput,
} from "./codingJiraHumanInput.js";
import { recordJiraHumanInput } from "../atlassian/credentialActivity.js";
import { createJiraPrivateLifetime } from "../atlassian/httpPrivateIdentity.js";
import {
  jiraRequiredConnectorScope,
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MUTATION_OPERATIONS,
  sanitizeJiraMutationFailureDetail,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  createCodingJiraCatalog,
  isCodingJiraDiscovery,
  type CodingJiraCatalog,
} from "./codingJiraCatalog.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { JIRA_TOOL_GUIDANCE } from "../atlassian/jiraToolGuidance.js";
import {
  checkJiraManagedMutation,
  createJiraReportStore,
  JiraAcknowledgedMutationError,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpRequest,
  type JiraManagedConnection,
  type JiraReportStore,
} from "@oscharko-dev/keiko-connectors";
import type {
  JiraMutationAttempt,
  JiraMutationOperation,
  JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { createMcpRelayEndpoint, ManagedMcpError } from "@oscharko-dev/keiko-mcp";

import type { AtlassianConnectorCredentialDeps } from "../atlassian/credentialRoutes.js";
import { createJiraProviderForCatalog } from "../atlassian/jiraManagedProvider.js";
import { recordJiraReportActivity } from "../atlassian/jiraReportActivity.js";
import {
  jiraAttemptToolResult,
  jiraLinkCountsOfResult,
  jiraMutationToolResult,
  validJiraMutationAttempt,
} from "../atlassian/jiraMutationResult.js";
import {
  jiraIssueTemplateSource,
  recordJiraTemplateAttempt,
  recordJiraTemplateMetadata,
  recordJiraTemplateRefusal,
} from "../atlassian/jiraTemplateLog.js";
import type { JiraPodAccessDeps, JiraLivePodCredential } from "../atlassian/jiraPodAccess.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "../diagnostics-log.js";
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
 * provider receives a transport that adds it. Every native request rechecks both the exact
 * credential the human chose and the current run envelope scope required by the canonical tool.
 */

export interface CodingJiraPodDeps extends JiraPodAccessDeps {
  readonly codingRuntimeOrchestrator?:
    Pick<NonNullable<UiHandlerDeps["codingRuntimeOrchestrator"]>, "refreshHistory"> | undefined;
  /** Bound by server composition to its current credential floor; never supplied by the runtime. */
  readonly emailTemplateInspection?: (
    signal: AbortSignal,
  ) => NonNullable<JiraManagedConnection["emailTemplates"]>;
  /**
   * The skill library holds the customer-defined issue templates every Jira write is checked by.
   * Required: a Pod wired without it would write unchecked, so that cannot be expressed.
   */
  readonly store: Pick<UiHandlerDeps["store"], "markdownSkills" | "codingHistory">;
  readonly atlassianConnectorCredentials?:
    | Pick<
        AtlassianConnectorCredentialDeps,
        "custody" | "httpBodyPortFactory" | "jiraPrivatePortFactory" | "activityLog" | "diagnostics"
      >
    | undefined;
}

export type CodingJiraConnections = Pick<ConfiguredMcpConnections, "generation" | "serve">;

export interface CodingJiraRunAuthority {
  readonly runId: string;
  /** Existing server-owned run cancellation, never a serialized Authority Envelope field. */
  readonly signal?: AbortSignal;
  /** Revalidates the same live run envelope; an absent/revoked envelope grants nothing. */
  readonly currentScopes: (
    phase: "discovery" | "effect",
  ) => readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly currentInputAuthority?: () => CodingJiraInputAuthority | undefined;
  /** Composed with the actual model geometry and provider-reported context usage. */
  readonly catalogFits?: Parameters<typeof createCodingJiraCatalog>[0]["fits"] | undefined;
}

function requiredScope(tool: CodingJiraTool): CodingWorkbenchConnectorScope {
  return jiraRequiredConnectorScope(tool);
}

function scopedTools(scopes: readonly CodingWorkbenchConnectorScope[]): CodingJiraTool[] {
  return Object.keys(CODING_JIRA_TOOL_RISKS).flatMap((name) => {
    const tool = toolOf(name);
    return tool !== undefined && scopes.includes(requiredScope(tool)) ? [tool] : [];
  });
}

export interface CodingJiraPods {
  readonly currentInputContext: CodingJiraCurrentInputResolver;
  /** Before the start confirmation is consumed: the caller's own, ready Pod, or a closed reason. */
  readonly resolve: (podId: string) => CodingJiraPodResolution;
  /** The start's binding decision, one body-free line under the run's correlation. */
  readonly recordBind: (
    correlationId: string,
    decision:
      | { readonly outcome: "bound" }
      | { readonly outcome: "refused"; readonly reason: CodingJiraPodRefusal },
    scopes?: readonly CodingWorkbenchConnectorScope[],
  ) => void;
  /** The relay's view of a run: the registry's servers as before, plus the bound Pod's tools. */
  readonly connections: (
    base: CodingJiraConnections | undefined,
    binding: CodingJiraPodBinding,
    authority?: CodingJiraRunAuthority,
  ) => CodingJiraConnections;
  /**
   * The dry run of a managed Jira write the human is about to be asked about (#4354 L4): the model
   * facing refusal when the write breaks the customer's issue templates, so no card is raised for a
   * write that cannot proceed. `undefined` admits the card; the executor gate stays authoritative.
   */
  readonly preflightWrite: (
    binding: CodingJiraPodBinding,
    authority: CodingJiraRunAuthority,
    call: { readonly tool: string; readonly arguments: CatalogJsonObject },
  ) => Promise<string | undefined>;
  /** Late binding: the custody graph exists only after the coding runtime was composed. */
  readonly attach: (deps: CodingJiraPodDeps) => void;
  readonly close: () => Promise<void>;
  readonly closeRun: (runId: string) => Promise<void>;
}

interface PodEntry {
  readonly runId: string;
  readonly binding: CodingJiraPodBinding;
  readonly lifetime: AbortController;
  readonly ready: Promise<ReturnType<typeof createMcpRelayEndpoint>>;
  readonly host: CodingJiraCatalog<JiraInvocationContext>;
  readonly inputs: Map<string, PendingCodingJiraInput>;
  readonly privateLifetime: ReturnType<typeof createJiraPrivateLifetime>;
}

const ENTRY_MAX = 8;
/** The most characters of a dry-run refusal handed to the runtime as its deny message. */
const PREFLIGHT_REFUSAL_CHARS_MAX = 6000;
const NOT_ADMITTED = (): ManagedMcpError => new ManagedMcpError("not-admitted");

interface Dispatch {
  dispatched: boolean;
  acknowledged: boolean;
}
interface JiraInvocationContext extends ManagedMcpInvocationContext {
  readonly dispatch: Dispatch;
  readonly scopeState: { missing: boolean };
  readonly inputAuthority: () => CodingJiraInputAuthority | undefined;
  readonly humanInput?: PendingCodingJiraInput;
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

function toolOf(name: string): CodingJiraPodLine["tool"] {
  return Object.hasOwn(JIRA_MANAGED_ACTION_TYPES, name) &&
    Object.hasOwn(CODING_JIRA_TOOL_RISKS, name)
    ? (name as NonNullable<CodingJiraPodLine["tool"]>)
    : undefined;
}

type CallLine = Pick<CodingJiraPodLine, "action" | "tool" | "risk">;
interface NativeCall {
  readonly host: PodEntry["host"];
  readonly binding: CodingJiraPodBinding;
  readonly name: string;
  readonly args: CatalogJsonObject;
  readonly context: JiraInvocationContext;
  readonly inputs: Map<string, PendingCodingJiraInput>;
  readonly line: CallLine;
  readonly started: number;
}

function boundRunLifetime(authority: CodingJiraRunAuthority): AbortController {
  const lifetime = new AbortController();
  const endRun = (): void => {
    lifetime.abort();
  };
  authority.signal?.addEventListener("abort", endRun, { once: true });
  lifetime.signal.addEventListener(
    "abort",
    (): void => {
      authority.signal?.removeEventListener("abort", endRun);
    },
    { once: true },
  );
  if (authority.signal?.aborted === true) endRun();
  return lifetime;
}

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

function failureReason(
  scopeMissing: boolean,
  provider: CatalogJsonObject | undefined,
): "scope-missing" | "internal" | "tool-failed" {
  if (scopeMissing) return "scope-missing";
  return provider === undefined ? "internal" : "tool-failed";
}

/** The existing failed-call observation and capture boundary, shared by the call's catch. */
function recordJiraCallFailure(
  log: ServerLogSink | undefined,
  error: unknown,
  line: CallLine,
  started: number,
  context: JiraInvocationContext,
): CatalogJsonObject {
  const provider = providerResult(error);
  const scopeMissing = context.scopeState.missing;
  recordCodingJiraPod(log, context.correlationId, {
    ...line,
    outcome: "failed",
    reason: failureReason(scopeMissing, provider),
    ...linkLineCounts(provider),
    durationMs: Date.now() - started,
    ...(provider === undefined ? { error } : {}),
  });
  if (scopeMissing) return throwScopeFailure(context, provider);
  // A failure the provider reported is data for the model; any other failure stays a failure.
  if (provider !== undefined) {
    const retained = context.retainProviderResult?.({ data: provider, isError: true });
    return callToolResult(retained?.data ?? provider, true);
  }
  throw error instanceof ManagedMcpError ? error : new ManagedMcpError("tool-error");
}

function throwScopeFailure(
  context: JiraInvocationContext,
  provider: CatalogJsonObject | undefined,
): never {
  if (provider === undefined) context.retainLocalFailure?.("connector-scope-missing");
  else context.retainProviderResult?.({ data: provider, isError: true });
  throw new ManagedMcpError(
    "connector-scope-missing",
    undefined,
    context.dispatch.dispatched ? "possible" : "none",
  );
}

/** The model-facing text of a refused dry run, logged by its violations when there are any. */
function preflightRefusal(
  runId: string,
  operation: JiraMutationOperation,
  checked: Extract<Awaited<ReturnType<typeof checkJiraManagedMutation>>, { ok: false }>,
): string {
  if (checked.violations !== undefined)
    recordJiraTemplateRefusal(runId, {
      operation,
      stage: "pre-approval",
      violations: checked.violations,
    });
  return JSON.stringify(
    jiraMutationToolResult(
      "rejected",
      checked.reason,
      {},
      false,
      sanitizeJiraMutationFailureDetail(checked.detail),
      undefined,
      checked.violations,
    ).data,
  ).slice(0, PREFLIGHT_REFUSAL_CHARS_MAX);
}

class CodingJiraPodService implements CodingJiraPods {
  readonly #entries = new Map<string, PodEntry>();
  readonly #disposed = new WeakMap<PodEntry, Promise<void>>();
  /** Reports of Coding runs; each belongs to the Pod binding that started it. */
  readonly #reports: JiraReportStore = createJiraReportStore();
  #deps: CodingJiraPodDeps | undefined;
  #closed = false;

  public constructor(private readonly log: ServerLogSink | undefined) {}

  public attach(deps: CodingJiraPodDeps): void {
    this.#deps = deps;
  }

  public currentInputContext: CodingJiraCurrentInputResolver = (binding, requestId) => {
    if (this.#closed || binding.context.kind !== "coding") return undefined;
    for (const entry of this.#entries.values()) {
      if (entry.lifetime.signal.aborted) continue;
      const found = currentCodingJiraInput(
        entry.inputs.get(binding.context.callId),
        binding,
        requestId,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  };

  public resolve(podId: string): CodingJiraPodResolution {
    const deps = this.#deps;
    if (deps === undefined || this.#closed) return { ok: false, reason: "unavailable" };
    const current = currentCodingJiraPod(deps, podId);
    return current.ok ? { ok: true, binding: bindingOfCredential(current.credential) } : current;
  }

  public recordBind: CodingJiraPods["recordBind"] = (correlationId, decision, scopes) => {
    recordCodingJiraPod(this.log, correlationId, {
      action: "bind",
      ...decision,
      ...(decision.outcome === "bound" && scopes !== undefined
        ? { toolCount: scopedTools(scopes).length }
        : {}),
    });
  };

  public connections(
    base: CodingJiraConnections | undefined,
    binding: CodingJiraPodBinding,
    authority?: CodingJiraRunAuthority,
  ): CodingJiraConnections {
    return {
      generation: (server, correlationId) =>
        this.isJira(server)
          ? this.jiraGeneration(binding, correlationId, authority)
          : this.requireBase(base).generation(server, correlationId),
      serve: async (name, request, context) =>
        name === CODING_JIRA_SERVER_NAME
          ? this.serveJira(binding, request, context, authority)
          : this.requireBase(base).serve(name, request, context),
    };
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((entry) => this.dispose(entry)));
  }
  public async closeRun(runId: string): Promise<void> {
    const entries = [...this.#entries].filter(([, entry]) => entry.runId === runId);
    await Promise.allSettled(entries.map(([key, entry]) => this.forget(key, entry)));
  }

  /** A Pod that is no longer the chosen one yields a revoked signal, so no relay is bound for it. */
  private jiraGeneration(
    binding: CodingJiraPodBinding,
    correlationId: string,
    authority: CodingJiraRunAuthority | undefined,
  ): AbortSignal {
    if (authority?.runId !== correlationId || authority.signal?.aborted === true)
      return AbortSignal.abort();
    if (this.current(binding) === undefined) return AbortSignal.abort();
    const scopes = authority.currentScopes("discovery");
    return scopes === undefined
      ? AbortSignal.abort()
      : this.entry(binding, correlationId, authority, scopes).lifetime.signal;
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
    for (const entry of this.#entries.values()) {
      if (this.key(entry.binding) === this.key(binding)) entry.lifetime.abort();
    }
    return undefined;
  }

  private entry(
    binding: CodingJiraPodBinding,
    correlationId: string,
    authority: CodingJiraRunAuthority,
    scopes: readonly CodingWorkbenchConnectorScope[],
  ): PodEntry {
    if (this.#closed || authority.signal?.aborted === true) throw NOT_ADMITTED();
    const key = `${this.key(binding)}:${authority.runId}:${[...scopes].sort(compareStrings).join(",")}`;
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.lifetime.signal.aborted) return existing;
    if (existing !== undefined) {
      void this.forget(key, existing);
      throw NOT_ADMITTED();
    }
    this.evictOldest();
    if (this.#entries.size >= ENTRY_MAX) throw NOT_ADMITTED();
    const created = this.open(binding, correlationId, authority, scopedTools(scopes));
    this.#entries.set(key, created);
    created.lifetime.signal.addEventListener(
      "abort",
      () => {
        void this.forget(key, created);
      },
      { once: true },
    );
    if (created.lifetime.signal.aborted) void this.forget(key, created);
    return created;
  }

  private evictOldest(): void {
    if (this.#entries.size < ENTRY_MAX) return;
    const first = this.#entries.entries().next().value;
    if (first !== undefined) void this.forget(first[0], first[1]);
  }

  private async forget(key: string, entry: PodEntry): Promise<void> {
    try {
      await this.dispose(entry);
    } finally {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    }
  }

  private async dispose(entry: PodEntry): Promise<void> {
    const previous = this.#disposed.get(entry);
    if (previous !== undefined) return previous;
    // Publish the disposal promise before abort synchronously notifies the same entry again.
    const disposal = Promise.resolve().then(() => this.disposeEntry(entry));
    this.#disposed.set(entry, disposal);
    return disposal;
  }

  private async disposeEntry(entry: PodEntry): Promise<void> {
    entry.lifetime.abort();
    for (const pending of entry.inputs.values()) pending.release();
    entry.inputs.clear();
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
    } finally {
      await entry.privateLifetime.finish();
    }
  }

  private open(
    binding: CodingJiraPodBinding,
    correlationId: string,
    authority: CodingJiraRunAuthority,
    tools: readonly CodingJiraTool[],
  ): PodEntry {
    const lifetime = boundRunLifetime(authority);
    const privateLifetime = createJiraPrivateLifetime(lifetime.signal, correlationId);
    const inputs = new Map<string, PendingCodingJiraInput>();
    const host = createCodingJiraCatalog<JiraInvocationContext>({
      tools,
      correlationId,
      admitted: (tool, context) =>
        this.current(binding) !== undefined &&
        this.scopeRefusal(authority, context, requiredScope(tool)) === undefined,
      fits: (selected, result) => authority.catalogFits?.(selected, result),
      provider: (selected) =>
        createJiraProviderForCatalog(
          (context) => this.connection(binding, context, privateLifetime),
          selected,
          (operation, _args, context, execute) => this.mutate(binding, operation, context, execute),
          {
            store: this.#reports,
            owner: () => this.key(binding),
            activity: (activity, context) => {
              recordJiraReportActivity(this.log, context.correlationId, activity);
            },
          },
        ),
      log: this.log ?? { write: (): void => undefined },
    });
    const ready = host.ready.then(() =>
      createMcpRelayEndpoint(
        this.hostConnection(host, lifetime.signal, binding, authority, inputs),
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
    return { runId: authority.runId, binding, lifetime, ready, host, inputs, privateLifetime };
  }

  private async serveJira(
    binding: CodingJiraPodBinding,
    request: Request,
    context: ManagedMcpInvocationContext,
    authority: CodingJiraRunAuthority | undefined,
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
    if (authority?.runId !== context.correlationId) throw NOT_ADMITTED();
    const scopes = authority.currentScopes("discovery");
    if (scopes === undefined) throw NOT_ADMITTED();
    const endpoint = await this.entry(binding, context.correlationId, authority, scopes).ready;
    return endpoint.fetch(request, context);
  }

  private connection(
    binding: CodingJiraPodBinding,
    context: JiraInvocationContext,
    privateLifetime: ReturnType<typeof createJiraPrivateLifetime>,
  ): JiraManagedConnection {
    const credential = this.current(binding);
    const deps = this.#deps;
    const factory = deps?.atlassianConnectorCredentials?.httpBodyPortFactory;
    if (credential === undefined || factory === undefined || deps === undefined)
      throw NOT_ADMITTED();
    return {
      baseUrl: credential.baseUrl,
      deployment: credential.deployment,
      identity: `${credential.authRef}:${String(credential.generation)}`,
      http: factory(credential, context.correlationId, {
        beforeDispatch: () => this.admit(binding, context),
      }),
      issueTemplates: jiraIssueTemplateSource(deps.store),
      ...this.privateConnection(binding, context, credential, privateLifetime),
      ...(deps.emailTemplateInspection === undefined
        ? {}
        : { emailTemplates: deps.emailTemplateInspection(context.signal) }),
      templateMetadataActivity: (activity): void => {
        recordJiraTemplateMetadata(undefined, context.correlationId, activity);
      },
    };
  }

  private privateConnection(
    binding: CodingJiraPodBinding,
    context: JiraInvocationContext,
    credential: JiraLivePodCredential,
    privateLifetime: ReturnType<typeof createJiraPrivateLifetime>,
  ): Pick<JiraManagedConnection, "privateIdentity" | "avatars"> {
    const deps = this.#deps;
    const factory = deps?.atlassianConnectorCredentials?.jiraPrivatePortFactory;
    const authority = context.inputAuthority();
    if (factory === undefined || authority === undefined) return {};
    const pending = context.humanInput;
    const selection = pending?.selection;
    const ports = factory(
      credential,
      context,
      {
        lifetimeSignal: privateLifetime.signal,
        sessionScope: {
          context: { kind: "coding", taskId: authority.taskId, runId: authority.authority.runId },
          authority: authority.authority,
          principalDigest: authority.principalDigest,
          authRef: credential.authRef,
          authenticationGeneration: credential.generation,
          verificationRevision: credential.livePod.verificationRevision,
          expiresAt: authority.expiresAt,
        },
        ...(selection === undefined ? {} : { selection }),
        onConsumed: (view) => {
          if (pending === undefined || selection?.requestId !== view.requestId)
            throw NOT_ADMITTED();
          pending.publish(view);
          recordJiraHumanInput(
            deps?.atlassianConnectorCredentials,
            context.correlationId,
            "consumed",
          );
        },
      },
      this.transportLifecycle(binding, context, context.dispatch),
    );
    privateLifetime.register(ports.finish);
    // Session access is real; no Coding filesystem source or image inspection is inferred here.
    return {
      privateIdentity: ports.identity,
      avatars: {
        withSession: ports.withAvatarSession,
        legacyTemporaryRelease: ports.legacyTemporaryRelease,
      },
    };
  }

  public async preflightWrite(
    binding: CodingJiraPodBinding,
    authority: CodingJiraRunAuthority,
    call: { readonly tool: string; readonly arguments: CatalogJsonObject },
  ): Promise<string | undefined> {
    const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === call.tool);
    if (operation === undefined || this.#closed || authority.signal?.aborted === true)
      return undefined;
    const lifetime = boundRunLifetime(authority);
    const privateLifetime = createJiraPrivateLifetime(lifetime.signal, authority.runId);
    const context: JiraInvocationContext = {
      invocationId: `preflight-${authority.runId}`,
      correlationId: authority.runId,
      signal: lifetime.signal,
      beforeEffect: () => !lifetime.signal.aborted,
      dispatch: { dispatched: false, acknowledged: false },
      scopeState: { missing: false },
      inputAuthority: () => undefined,
    };
    try {
      const checked = await checkJiraManagedMutation(
        operation,
        call.arguments,
        context,
        this.connection(binding, context, privateLifetime),
      );
      return checked.ok ? undefined : preflightRefusal(authority.runId, operation, checked);
    } catch (error) {
      // A dry run that cannot complete decides nothing: the card is asked and the executor gate
      // refuses after approval if the write is not allowed. The failure is recorded, never hidden.
      recordCodingJiraPod(this.log, authority.runId, {
        action: "call",
        outcome: "failed",
        reason: "internal",
        error,
      });
      return undefined;
    } finally {
      await privateLifetime.finish();
      lifetime.abort();
    }
  }

  /** Every request, read or write, is gated on the run and on the Pod being exactly as chosen. */
  private admit(binding: CodingJiraPodBinding, context: ManagedMcpInvocationContext): boolean {
    return !context.signal.aborted && context.beforeEffect() && this.current(binding) !== undefined;
  }

  private async mutate(
    binding: CodingJiraPodBinding,
    operation: JiraMutationOperation,
    context: JiraInvocationContext,
    execute: (http: AtlassianHttpBodyPort) => Promise<JiraMutationAttempt>,
  ): Promise<ManagedMcpToolResult> {
    const tool = toolOf(operation);
    if (tool === undefined) throw NOT_ADMITTED();
    const credential = this.current(binding);
    const factory = this.#deps?.atlassianConnectorCredentials?.httpBodyPortFactory;
    if (credential === undefined || factory === undefined) throw NOT_ADMITTED();
    const dispatch = context.dispatch;
    const http = this.trackedTransport(factory, credential, binding, context, dispatch);
    let attempt: JiraMutationAttempt;
    try {
      attempt = validJiraMutationAttempt(await execute(http), operation);
    } catch (error) {
      recordCodingJiraPod(this.log, context.correlationId, {
        action: "call",
        outcome: "failed",
        reason: "internal",
        tool,
        risk: "write",
        error,
      });
      attempt =
        error instanceof JiraAcknowledgedMutationError
          ? validJiraMutationAttempt(
              { ok: false, reason: "unavailable", receipt: error.receipt },
              operation,
            )
          : { ok: false, reason: "unavailable" };
    }
    this.recordMutationAttempt(context.correlationId, operation, tool, attempt);
    return jiraAttemptToolResult(mutationOutcome(attempt, dispatch), attempt);
  }

  /** Logging cannot turn an already confirmed mutation into a retryable tool failure. */
  private recordMutationAttempt(
    correlationId: string,
    operation: JiraMutationOperation,
    tool: NonNullable<CodingJiraPodLine["tool"]>,
    attempt: JiraMutationAttempt,
  ): void {
    try {
      recordJiraTemplateAttempt(correlationId, operation, attempt);
      if (
        attempt.descriptionConvertedHeadingCount !== undefined ||
        attempt.descriptionProjection !== undefined
      )
        recordCodingJiraPod(this.log, correlationId, {
          action: "serialize-description",
          outcome: attempt.ok ? "completed" : "failed",
          tool,
          risk: "write",
          ...(attempt.descriptionConvertedHeadingCount === undefined
            ? {}
            : { descriptionConvertedHeadingCount: attempt.descriptionConvertedHeadingCount }),
          ...(attempt.descriptionProjection === undefined
            ? {}
            : { descriptionProjection: attempt.descriptionProjection }),
        });
    } catch (error) {
      emitServerDiagnostic(
        undefined,
        serverDiagnosticFromError({
          correlationId,
          operation: "coding.jira-pod.audit",
          source: "coding.jira-pod",
          error,
          redact: () => DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
        }),
      );
    }
  }

  private trackedTransport(
    factory: NonNullable<CodingJiraPodDeps["atlassianConnectorCredentials"]>["httpBodyPortFactory"],
    credential: AtlassianCredentialMetadata,
    binding: CodingJiraPodBinding,
    context: JiraInvocationContext,
    dispatch: Dispatch,
  ): AtlassianHttpBodyPort {
    return factory(
      credential,
      context.correlationId,
      this.transportLifecycle(binding, context, dispatch),
    );
  }

  private transportLifecycle(
    binding: CodingJiraPodBinding,
    context: JiraInvocationContext,
    dispatch: Dispatch,
  ): import("../atlassian/credentialRoutes.js").AtlassianCredentialHttpOptions {
    return {
      beforeDispatch: (request): boolean => {
        if (!this.admit(binding, context)) return false;
        if (isWrite(request) && !dispatch.dispatched) {
          if (context.beforeDispatch?.() === false) return false;
          dispatch.dispatched = true;
        }
        return true;
      },
      onResponse: (request, status): boolean => {
        if (isWrite(request) && status >= 200 && status < 300) dispatch.acknowledged = true;
        return true;
      },
    };
  }

  private hostConnection(
    host: PodEntry["host"],
    signal: AbortSignal,
    binding: CodingJiraPodBinding,
    authority: CodingJiraRunAuthority,
    inputs: Map<string, PendingCodingJiraInput>,
  ): ExternalMcpConnection {
    return {
      signal,
      localProvider: "jira",
      localMetadataTools: ["jira.discover", "jira.describe"],
      dispatchGate: true,
      instructions: JIRA_TOOL_GUIDANCE,
      get tools(): ExternalMcpConnection["tools"] {
        return host.tools;
      },
      call: (name, args, context) =>
        isCodingJiraDiscovery(name)
          ? this.discover(host, binding, name, args, context, authority)
          : this.call(host, binding, name, args, context, authority, inputs),
      close: () => host.close(),
    };
  }

  private async discover(
    host: PodEntry["host"],
    binding: CodingJiraPodBinding,
    name: string,
    args: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
    authority: CodingJiraRunAuthority,
  ): Promise<CatalogJsonObject> {
    // Catalog metadata uses the existing read grant; it never mints a native operation receipt.
    const scoped = this.scopedContext(authority, context, "issue-tracker.read");
    const guarded = {
      ...scoped,
      beforeEffect: (): boolean => scoped.beforeEffect() && this.current(binding) !== undefined,
    };
    try {
      return callToolResult(await host.call(name, args, guarded), false);
    } catch (error) {
      if (scoped.scopeState.missing)
        throw new ManagedMcpError("connector-scope-missing", undefined, "none");
      const result = providerResult(error);
      if (result !== undefined) return callToolResult(result, true);
      throw error;
    }
  }

  /** One decision line per call: the closed tool, its risk and whether the Pod let it through. */
  private async call(
    host: PodEntry["host"],
    binding: CodingJiraPodBinding,
    name: string,
    args: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
    authority: CodingJiraRunAuthority,
    inputs: Map<string, PendingCodingJiraInput>,
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
    if (tool === undefined)
      return this.refuseCall(context.correlationId, line, started, "unavailable");
    const refusal = this.scopeRefusal(authority, context, requiredScope(tool));
    if (refusal === "scope-missing") context.retainLocalFailure?.("connector-scope-missing");
    if (refusal !== undefined)
      return this.refuseCall(context.correlationId, line, started, refusal);
    const scopedContext = this.scopedContext(authority, context, requiredScope(tool));
    return this.executeCall({
      host,
      binding,
      name,
      args,
      context: scopedContext,
      inputs,
      line,
      started,
    });
  }

  private async executeCall({
    host,
    binding,
    name,
    args,
    context,
    inputs,
    line,
    started,
  }: NativeCall): Promise<CatalogJsonObject> {
    try {
      const humanInput = await this.prepareCall(binding, name, args, context, inputs);
      const preparedContext =
        humanInput === undefined
          ? context
          : {
              ...context,
              humanInput,
              beforeEffect: (): boolean => humanInput.current(),
            };
      const data = await host.call(name, humanInput?.argumentsValue ?? args, preparedContext);
      recordCodingJiraPod(this.log, context.correlationId, {
        ...line,
        outcome: "completed",
        ...linkLineCounts(data),
        durationMs: Date.now() - started,
      });
      const retained = context.retainProviderResult?.({ data }) ?? { data };
      return callToolResult(retained.data, false);
    } catch (error) {
      return recordJiraCallFailure(this.log, error, line, started, context);
    } finally {
      inputs.get(context.invocationId)?.release();
      inputs.delete(context.invocationId);
    }
  }

  private prepareCall(
    binding: CodingJiraPodBinding,
    name: string,
    args: CatalogJsonObject,
    context: JiraInvocationContext,
    inputs: Map<string, PendingCodingJiraInput>,
  ): Promise<PendingCodingJiraInput | undefined> {
    const deps = this.#deps;
    if (deps === undefined) throw NOT_ADMITTED();
    return prepareCodingJiraHumanInput({
      deps,
      operation: name,
      args,
      context,
      inputs,
      currentAuthority: context.inputAuthority,
      currentCredential: () => this.current(binding),
    });
  }

  private scopeRefusal(
    authority: CodingJiraRunAuthority,
    context: ManagedMcpInvocationContext,
    scope: CodingWorkbenchConnectorScope,
  ): "scope-missing" | "unavailable" | undefined {
    if (
      authority.runId !== context.correlationId ||
      context.signal.aborted ||
      !context.beforeEffect()
    )
      return "unavailable";
    const scopes = authority.currentScopes("effect");
    if (scopes === undefined) return "unavailable";
    return scopes.includes(scope) ? undefined : "scope-missing";
  }

  private scopedContext(
    authority: CodingJiraRunAuthority,
    context: ManagedMcpInvocationContext,
    scope: CodingWorkbenchConnectorScope,
  ): JiraInvocationContext {
    const scopeState = { missing: false };
    return {
      ...context,
      dispatch: { dispatched: false, acknowledged: false },
      scopeState,
      inputAuthority: () => authority.currentInputAuthority?.(),
      beforeEffect: (): boolean => {
        const refusal = this.scopeRefusal(authority, context, scope);
        if (refusal === "scope-missing") scopeState.missing = true;
        return refusal === undefined;
      },
    };
  }

  private refuseCall(
    correlationId: string,
    line: CallLine,
    started: number,
    reason: "pod-changed" | "scope-missing" | "unavailable" = "pod-changed",
  ): never {
    recordCodingJiraPod(this.log, correlationId, {
      ...line,
      outcome: "refused",
      reason,
      durationMs: Date.now() - started,
    });
    throw reason === "scope-missing"
      ? new ManagedMcpError("connector-scope-missing", undefined, "none")
      : NOT_ADMITTED();
  }
}

/** One service per application graph; hosts open lazily per run, Pod and admitted scope snapshot. */
export function createCodingJiraPods(log: ServerLogSink | undefined): CodingJiraPods {
  return new CodingJiraPodService(log);
}
