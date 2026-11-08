import {
  createJiraReadRequest,
  executeAdmittedJiraRequest,
  executeAtlassianWriteRequest,
  copyJiraSessionBinding,
  jiraSessionBindingForInput,
  jiraPrivateSessionReference,
  JiraAcknowledgedMutationError,
  jiraPropertyUserText,
  type JiraHumanInputSelection,
  type JiraPrivateCookie,
  type JiraPrivateIdentityPorts,
  type JiraPrivateSessionBinding,
  type JiraPrivateSessionScope,
  type JiraPrivateSessionAccess,
  type AtlassianWriteHttpOutcome,
  type AtlassianWriteHttpRequest,
  type JiraAvatarPorts,
} from "@oscharko-dev/keiko-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  JiraHumanInputPurpose,
  JiraHumanInputView,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  createGatewayAtlassianHttpBodyPort,
  type CreateAtlassianHttpPortOptions,
} from "./httpPort.js";
import { humanInputRoute, ownedHumanInput } from "./httpHumanInput.js";
import { privateAvatarSession } from "./httpPrivateAvatar.js";
import { reportJiraHumanInputCleanupFailure } from "./credentialActivity.js";

export interface JiraPrivatePortOptions {
  readonly selection?: JiraHumanInputSelection;
  readonly sessionScope: JiraPrivateSessionScope;
  readonly onConsumed?: (view: JiraHumanInputView) => void;
  readonly legacyTemporaryRelease?: "10.3" | "10.4";
  /** Entire held turn/run, never an individual tool's HTTP deadline. */
  readonly lifetimeSignal?: AbortSignal;
  readonly onCleanupFailure?: (error: unknown) => void;
}
export interface JiraPrivatePortFactoryResult {
  readonly finish: () => Promise<void>;
  readonly identity: JiraPrivateIdentityPorts;
  readonly withAvatarSession: NonNullable<JiraAvatarPorts["withSession"]>;
  readonly legacyTemporaryRelease?: "10.3" | "10.4";
}
const UNAVAILABLE: AtlassianWriteHttpOutcome = { ok: false, reason: "unavailable" };
const CHANGED: AtlassianWriteHttpOutcome = { ok: false, reason: "conflict" };
interface Actor {
  readonly key: string;
  readonly name: string;
}
interface JiraPrivateLifetime {
  readonly signal: AbortSignal;
  readonly register: (finalize: () => Promise<void>) => void;
  readonly finish: () => Promise<void>;
}
type AvatarSessionOperation = NonNullable<JiraAvatarPorts["withSession"]>;
type AvatarAttempt = Awaited<ReturnType<AvatarSessionOperation>>;
async function completePrivateFinalizer(
  finalize: () => Promise<void>,
  correlationId: string,
): Promise<void> {
  try {
    await finalize();
  } catch (error) {
    reportJiraHumanInputCleanupFailure(undefined, { operationCorrelationId: correlationId }, error);
  }
}
function drainPrivateFinalizers(
  finalizers: Set<() => Promise<void>>,
  correlationId: string,
  onDrained: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    function next(): void {
      if (finalizers.size === 0) {
        onDrained();
        resolve();
        return;
      }
      const pending = [...finalizers];
      finalizers.clear();
      // Finish each existing concurrent wave before starting the next, without retaining a chain.
      void Promise.all(pending.map((finalize) => completePrivateFinalizer(finalize, correlationId)))
        .then(next)
        .catch(reject);
    }
    next();
  });
}
/** Private finalizers belong to the existing held Chat turn or Coding run. */
export function createJiraPrivateLifetime(
  signal: AbortSignal,
  correlationId: string,
): JiraPrivateLifetime {
  const finalizers = new Set<() => Promise<void>>();
  let settled: Promise<void> | undefined;
  let drained = false;
  function finish(): Promise<void> {
    if (settled !== undefined) return settled;
    signal.removeEventListener("abort", aborted);
    // Publish the promise before any finalizer can re-enter finish/register synchronously.
    settled = Promise.resolve().then(() =>
      drainPrivateFinalizers(finalizers, correlationId, () => {
        drained = true;
      }),
    );
    return settled;
  }
  function aborted(): void {
    void finish();
  }
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  return {
    signal,
    register: (finalize: () => Promise<void>): void => {
      if (!drained) finalizers.add(finalize);
      else {
        const previous = settled;
        settled = Promise.resolve()
          .then(() => previous)
          .then(() => completePrivateFinalizer(finalize, correlationId));
      }
    },
    finish,
  };
}
/** One existing factory's private state; no session or input material is returned to callers. */
class JiraPrivateHttpOwner {
  private readonly base: string;
  private readonly read: ReturnType<typeof createJiraReadRequest>;
  private readonly sessions: CreateAtlassianHttpPortOptions["credentials"]["sessions"];
  private readonly lifetime: AbortSignal;
  private readonly active = new Set<Promise<unknown>>();
  private owned:
    { readonly binding: JiraPrivateSessionBinding; readonly revision: string } | undefined;
  private finishing: Promise<void> | undefined;
  private attemptedInput = false;
  private readonly aborted = (): void => {
    void this.finish();
  };

  constructor(
    patOptions: CreateAtlassianHttpPortOptions,
    private readonly privateOptions: CreateAtlassianHttpPortOptions,
    private readonly context: ManagedMcpInvocationContext,
    private readonly options: JiraPrivatePortOptions,
  ) {
    this.base = privateOptions.baseUrl.replace(/\/$/u, "");
    this.read = createJiraReadRequest(
      {
        deployment: "data-center",
        baseUrl: this.base,
        http: createGatewayAtlassianHttpBodyPort(patOptions),
      },
      context,
    );
    this.sessions = privateOptions.credentials.sessions;
    this.lifetime = options.lifetimeSignal ?? context.signal;
    this.lifetime.addEventListener("abort", this.aborted, { once: true });
    if (this.lifetime.aborted) this.aborted();
  }

  private async completeCleanup(execute: () => Promise<void>): Promise<void> {
    try {
      await execute();
    } catch (error) {
      reportJiraHumanInputCleanupFailure(
        undefined,
        { operationCorrelationId: this.context.correlationId },
        error,
      );
      try {
        this.options.onCleanupFailure?.(error);
      } catch (observerError) {
        reportJiraHumanInputCleanupFailure(
          undefined,
          { operationCorrelationId: this.context.correlationId },
          observerError,
        );
      }
    }
  }
  private async logout(cookie: () => string): Promise<void> {
    // Cleanup is one fixed cookie-only request, without action admission or mutation observers.
    // Keep the existing target/egress/byte/time bounds; this cannot dispatch another operation.
    const {
      beforeDispatch: _admission,
      onResponse: _observer,
      onHumanInputConsumed: _consumed,
      onJiraLoginCookie: _candidate,
      ...transport
    } = this.privateOptions;
    const http = createGatewayAtlassianHttpBodyPort({
      ...transport,
      singleAttempt: true,
      privateAuthentication: { kind: "session", scope: "logout", cookie },
    });
    const result = await executeAtlassianWriteRequest(
      { http },
      { method: "DELETE", url: `${this.base}/rest/auth/1/session`, expect: "none" },
    );
    if (!result.ok) throw new Error("Private Jira session cleanup failed");
  }
  private finish(): Promise<void> {
    if (this.finishing !== undefined) return this.finishing;
    this.lifetime.removeEventListener("abort", this.aborted);
    this.finishing = this.finishOwned();
    return this.finishing;
  }
  private async finishOwned(): Promise<void> {
    // Native Promise.allSettled consumes this private Set synchronously before yielding.
    await Promise.allSettled(this.active);
    const retained = this.owned;
    this.owned = undefined;
    const sessions = this.sessions;
    if (retained === undefined || sessions === undefined) return;
    await this.completeCleanup(() =>
      sessions.finish(retained.binding, retained.revision, (cookie) => this.logout(cookie)),
    );
  }
  private withSession<T>(
    scope: JiraPrivateSessionBinding,
    execute: (session: JiraPrivateSessionAccess) => Promise<T>,
  ): Promise<T> {
    const sessions = this.sessions;
    if (sessions === undefined || this.finishing !== undefined)
      return Promise.reject(new Error("Private Jira session has ended"));
    // Register the pending promise before custody or a callback can synchronously abort.
    const operation = Promise.resolve().then(() =>
      sessions.withLease(scope, async (session) => {
        const remember = (): void => {
          const current = session.current();
          if (current !== undefined) this.owned = { binding: scope, revision: current.revision };
        };
        remember();
        return execute({
          ...session,
          establish: (cookie): ReturnType<JiraPrivateSessionAccess["establish"]> => {
            const retained = session.establish(cookie);
            this.owned = { binding: scope, revision: retained.revision };
            return retained;
          },
        });
      }),
    );
    this.active.add(operation);
    return operation.finally(() => {
      this.active.delete(operation);
    });
  }
  private async actor(expected?: string): Promise<Actor | undefined> {
    const response = await this.read("myself", "GET", undefined, "json");
    const value = response.ok && response.status === 200 ? response.body : undefined;
    return value !== undefined &&
      jiraPropertyUserText(value.key) &&
      jiraPropertyUserText(value.name) &&
      (expected === undefined || value.key === expected)
      ? { key: value.key, name: value.name }
      : undefined;
  }
  private binding(selected: Actor): JiraPrivateSessionBinding | undefined {
    const value = copyJiraSessionBinding({
      ...this.options.sessionScope,
      actorUserKey: selected.key,
      actorUsername: selected.name,
    });
    return value?.authRef === this.privateOptions.authRef ? value : undefined;
  }
  private send(
    request: AtlassianWriteHttpRequest,
    extra: Partial<CreateAtlassianHttpPortOptions> = {},
  ): Promise<AtlassianWriteHttpOutcome> {
    const http = createGatewayAtlassianHttpBodyPort({ ...this.privateOptions, ...extra });
    return executeAdmittedJiraRequest({ http }, this.context, this.context.signal, request);
  }
  private async proof(cookie: () => string, selected: Actor): Promise<boolean> {
    const extra: Partial<CreateAtlassianHttpPortOptions> = {
      privateAuthentication: { kind: "session", scope: "actor", cookie },
      singleAttempt: true,
    };
    const native = await this.send(
      { method: "GET", url: `${this.base}/rest/api/2/myself`, expect: "json" },
      extra,
    );
    if (
      !native.ok ||
      native.status !== 200 ||
      native.body?.key !== selected.key ||
      native.body.name !== selected.name
    )
      return false;
    const observed = await this.send(
      { method: "GET", url: `${this.base}/rest/auth/1/session`, expect: "json" },
      extra,
    );
    return observed.ok && observed.status === 200 && observed.body?.name === selected.name;
  }
  private async preserveAcknowledgement(
    known: JiraMutationReceipt,
    execute: (
      observe: NonNullable<CreateAtlassianHttpPortOptions["onResponse"]>,
    ) => Promise<AtlassianWriteHttpOutcome>,
  ): Promise<AtlassianWriteHttpOutcome> {
    const observation = { acknowledged: false };
    try {
      return await execute((native, status) => {
        if (status >= 200 && status < 300) observation.acknowledged = true;
        return (
          this.privateOptions.onResponse === undefined ||
          this.privateOptions.onResponse(native, status)
        );
      });
    } catch (error) {
      if (observation.acknowledged) throw new JiraAcknowledgedMutationError(error, known);
      throw error;
    }
  }
  private inputSelection(purpose: JiraHumanInputPurpose): JiraHumanInputSelection | undefined {
    if (this.finishing !== undefined || this.attemptedInput) return undefined;
    const selection = this.options.selection;
    return selection?.binding.operation === `jira.${purpose}` &&
      selection.binding.authRef === this.privateOptions.authRef
      ? selection
      : undefined;
  }
  private selectionMatchesScope(
    selection: JiraHumanInputSelection,
    scope: JiraPrivateSessionBinding,
  ): boolean {
    return !(
      jiraPrivateSessionReference(scope) !==
        jiraPrivateSessionReference(jiraSessionBindingForInput(selection.binding)) ||
      selection.binding.expiresAt > scope.expiresAt ||
      selection.binding.authority.runId !== scope.authority.runId ||
      selection.binding.authority.envelopeDigest !== scope.authority.envelopeDigest
    );
  }
  private async perform(
    purpose: JiraHumanInputPurpose,
    fields: CatalogJsonObject,
  ): Promise<AtlassianWriteHttpOutcome> {
    const selection = this.inputSelection(purpose);
    if (selection === undefined) return UNAVAILABLE;
    const selected = await this.actor(selection.binding.actorUserKey);
    if (selected?.name !== selection.binding.actorUsername) return CHANGED;
    const scope = this.binding(selected);
    if (scope === undefined || !this.selectionMatchesScope(selection, scope)) return CHANGED;
    this.attemptedInput = true;
    const input = ownedHumanInput({ selection, fields });
    const route = humanInputRoute(purpose, input.fields);
    const request: AtlassianWriteHttpRequest = {
      method: route.method,
      url: `${this.base}${route.path}`,
      jiraHumanInput: input,
      expect: purpose.startsWith("validate-") ? "json" : "none",
    };
    const consumed =
      this.options.onConsumed === undefined
        ? {}
        : { onHumanInputConsumed: this.options.onConsumed };
    // Native validators are reads. Only actual account/unlock effects receive mutation ACKs.
    if (purpose.startsWith("validate-")) return this.send(request, consumed);
    if (purpose !== "login")
      return this.preserveAcknowledgement({ actorUserKey: selected.key }, (onResponse) =>
        this.send(request, { ...consumed, onResponse }),
      );
    return this.performLogin(selected, scope, request, consumed);
  }
  private performLogin(
    selected: Actor,
    scope: JiraPrivateSessionBinding,
    request: AtlassianWriteHttpRequest,
    consumed: Partial<CreateAtlassianHttpPortOptions>,
  ): Promise<AtlassianWriteHttpOutcome> {
    if (this.sessions === undefined) return Promise.resolve(UNAVAILABLE);
    return this.preserveAcknowledgement(
      { actorUserKey: selected.key, userKey: selected.key, username: selected.name },
      (onResponse) =>
        this.withSession(scope, (session) =>
          this.loginWithinSession(session, selected, request, { ...consumed, onResponse }),
        ),
    );
  }
  private async loginWithinSession(
    session: JiraPrivateSessionAccess,
    selected: Actor,
    request: AtlassianWriteHttpRequest,
    extra: Partial<CreateAtlassianHttpPortOptions>,
  ): Promise<AtlassianWriteHttpOutcome> {
    if (session.current() !== undefined)
      await this.completeCleanup(() => this.logout(session.cookieHeader));
    session.invalidate();
    let candidate: JiraPrivateCookie | undefined;
    let established = false;
    try {
      const response = await this.send(request, {
        privateAuthentication: { kind: "anonymous" },
        ...extra,
        onJiraLoginCookie: (value) => {
          candidate = value;
        },
      });
      if (!response.ok) return response;
      const cookie = candidate;
      if (
        cookie === undefined ||
        !(await this.proof(() => `${cookie.name}=${cookie.value}`, selected))
      )
        return { ok: false, reason: "unavailable", httpStatus: response.status };
      session.establish(cookie);
      established = true;
      return {
        ok: true,
        status: response.status,
        body: { sessionEstablished: true, userKey: selected.key, username: selected.name },
      };
    } finally {
      const cookie = candidate;
      if (!established && cookie !== undefined)
        await this.completeCleanup(() => this.logout(() => `${cookie.name}=${cookie.value}`));
    }
  }
  private async sessionAction(
    action: "logout" | "release-websudo",
    expectedActorKey: string,
  ): Promise<AtlassianWriteHttpOutcome> {
    if (this.sessions === undefined || this.finishing !== undefined) return UNAVAILABLE;
    const selected = await this.actor(expectedActorKey);
    if (selected === undefined) return CHANGED;
    const scope = this.binding(selected);
    if (scope === undefined) return CHANGED;
    return this.preserveAcknowledgement(
      { actorUserKey: selected.key, userKey: selected.key, username: selected.name },
      (onResponse) =>
        this.withSession(scope, async (session) => {
          if (
            session.current() === undefined ||
            !(await this.proof(session.cookieHeader, selected))
          ) {
            session.invalidate();
            return UNAVAILABLE;
          }
          try {
            return await this.send(
              {
                method: "DELETE",
                url: `${this.base}/rest/auth/1/${action === "logout" ? "session" : "websudo"}`,
                expect: "none",
              },
              {
                onResponse,
                privateAuthentication: {
                  kind: "session",
                  scope: action === "logout" ? "logout" : "websudo",
                  cookie: session.cookieHeader,
                },
              },
            );
          } finally {
            session.invalidate();
          }
        }),
    );
  }
  private async withAvatarSession(
    expectedActorKey: string,
    execute: Parameters<AvatarSessionOperation>[1],
  ): Promise<AvatarAttempt> {
    if (this.sessions === undefined || this.finishing !== undefined)
      return { ok: false, reason: "unavailable" };
    const selected = await this.actor(expectedActorKey);
    if (selected === undefined) return { ok: false, reason: "conflict" };
    const scope = this.binding(selected);
    if (scope === undefined) return { ok: false, reason: "conflict" };
    return this.withSession(scope, async (session): Promise<AvatarAttempt> => {
      if (session.current() === undefined || !(await this.proof(session.cookieHeader, selected))) {
        session.invalidate();
        return { ok: false, reason: "unavailable" };
      }
      return execute(
        privateAvatarSession(
          this.privateOptions,
          this.context,
          session,
          this.options.legacyTemporaryRelease,
        ),
      );
    });
  }
  ports(): JiraPrivatePortFactoryResult {
    return {
      finish: () => this.finish(),
      ...(this.options.legacyTemporaryRelease === undefined
        ? {}
        : { legacyTemporaryRelease: this.options.legacyTemporaryRelease }),
      identity: {
        perform: (purpose, fields) => this.perform(purpose, fields),
        session: (action, expectedActorKey) => this.sessionAction(action, expectedActorKey),
        unlock: (expectedActorKey) =>
          this.options.selection?.binding.actorUserKey === expectedActorKey
            ? this.perform("unlock-user-anonymization", {})
            : Promise.resolve(CHANGED),
      },
      withAvatarSession: (expectedActorKey, execute) =>
        this.withAvatarSession(expectedActorKey, execute),
    };
  }
}

/** Metadata and actual existing credential factories only; no private value leaves this owner. */
export function createJiraPrivatePorts(
  patOptions: CreateAtlassianHttpPortOptions,
  privateOptions: CreateAtlassianHttpPortOptions,
  context: ManagedMcpInvocationContext,
  options: JiraPrivatePortOptions,
): JiraPrivatePortFactoryResult {
  return new JiraPrivateHttpOwner(patOptions, privateOptions, context, options).ports();
}
