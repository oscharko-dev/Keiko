import {
  createJiraReadRequest, executeAdmittedJiraRequest, copyJiraSessionBinding, jiraSessionBindingForInput, jiraPrivateSessionReference, JiraAcknowledgedMutationError,
  jiraPropertyUserText, type JiraHumanInputSelection, type JiraPrivateCookie, type JiraPrivateIdentityPorts,
  type JiraPrivateSessionBinding, type JiraPrivateSessionScope, type JiraPrivateSessionAccess,
  type AtlassianWriteHttpOutcome, type AtlassianWriteHttpRequest, type JiraAvatarPorts,
} from "@oscharko-dev/keiko-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraHumanInputPurpose, JiraHumanInputView, JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createGatewayAtlassianHttpBodyPort, type CreateAtlassianHttpPortOptions } from "./httpPort.js";
import { humanInputRoute, ownedHumanInput } from "./httpHumanInput.js";
import { privateAvatarSession } from "./httpPrivateAvatar.js";

export interface JiraPrivatePortOptions {
  readonly selection?: JiraHumanInputSelection;
  readonly sessionScope: JiraPrivateSessionScope;
  readonly onConsumed?: (view: JiraHumanInputView) => void;
  readonly legacyTemporaryRelease?: "10.3" | "10.4";
}
export interface JiraPrivatePortFactoryResult {
  readonly identity: JiraPrivateIdentityPorts;
  readonly withAvatarSession: NonNullable<JiraAvatarPorts["withSession"]>;
  readonly legacyTemporaryRelease?: "10.3" | "10.4";
}
const UNAVAILABLE: AtlassianWriteHttpOutcome = { ok: false, reason: "unavailable" };
const CHANGED: AtlassianWriteHttpOutcome = { ok: false, reason: "conflict" };
interface Actor { readonly key: string; readonly name: string }
/** Metadata and actual existing credential factories only; no private value leaves this closure. */
export function createJiraPrivatePorts(
  patOptions: CreateAtlassianHttpPortOptions,
  privateOptions: CreateAtlassianHttpPortOptions,
  context: ManagedMcpInvocationContext,
  options: JiraPrivatePortOptions,
): JiraPrivatePortFactoryResult {
  const base = privateOptions.baseUrl.replace(/\/$/u, "");
  const read = createJiraReadRequest({ deployment: "data-center", baseUrl: base, http: createGatewayAtlassianHttpBodyPort(patOptions) }, context);
  const sessions = privateOptions.credentials.sessions;
  async function actor(expected?: string): Promise<Actor | undefined> {
    const response = await read("myself", "GET", undefined, "json");
    const value = response.ok && response.status === 200 ? response.body : undefined;
    return value !== undefined && jiraPropertyUserText(value.key) && jiraPropertyUserText(value.name) && (expected === undefined || value.key === expected)
      ? { key: value.key, name: value.name } : undefined;
  }
  function binding(selected: Actor): JiraPrivateSessionBinding | undefined {
    const value = copyJiraSessionBinding({ ...options.sessionScope, actorUserKey: selected.key, actorUsername: selected.name });
    return value?.authRef === privateOptions.authRef ? value : undefined;
  }
  function send(request: AtlassianWriteHttpRequest, extra: Partial<CreateAtlassianHttpPortOptions> = {}): Promise<AtlassianWriteHttpOutcome> {
    const http = createGatewayAtlassianHttpBodyPort({ ...privateOptions, ...extra });
    return executeAdmittedJiraRequest({ http }, context, context.signal, request);
  }
  async function proof(cookie: () => string, selected: Actor): Promise<boolean> {
    const extra = { privateAuthentication: { kind: "session" as const, scope: "actor" as const, cookie }, singleAttempt: true as const };
    const native = await send({ method: "GET", url: `${base}/rest/api/2/myself`, expect: "json" }, extra);
    if (!native.ok || native.status !== 200 || native.body?.key !== selected.key || native.body.name !== selected.name) return false;
    const observed = await send({ method: "GET", url: `${base}/rest/auth/1/session`, expect: "json" }, extra);
    return observed.ok && observed.status === 200 && observed.body?.name === selected.name;
  }
  async function preserveAcknowledgement(known: JiraMutationReceipt,
    execute: (observe: NonNullable<CreateAtlassianHttpPortOptions["onResponse"]>) => Promise<AtlassianWriteHttpOutcome>): Promise<AtlassianWriteHttpOutcome> {
    let acknowledged = false;
    try {
      return await execute((native, status) => {
        if (status >= 200 && status < 300) acknowledged = true;
        return privateOptions.onResponse === undefined || privateOptions.onResponse(native, status);
      });
    } catch (error) {
      if (acknowledged) throw new JiraAcknowledgedMutationError(error, known);
      throw error;
    }
  }
  async function perform(purpose: JiraHumanInputPurpose, fields: CatalogJsonObject): Promise<AtlassianWriteHttpOutcome> {
    const selection = options.selection;
    if (selection === undefined || selection.binding.operation !== `jira.${purpose}` || selection.binding.authRef !== privateOptions.authRef) return UNAVAILABLE;
    const selected = await actor(selection.binding.actorUserKey);
    if (selected === undefined || selected.name !== selection.binding.actorUsername) return CHANGED;
    const scope = binding(selected);
    if (scope === undefined || jiraPrivateSessionReference(scope) !== jiraPrivateSessionReference(jiraSessionBindingForInput(selection.binding)) ||
        selection.binding.expiresAt > scope.expiresAt || selection.binding.authority.runId !== scope.authority.runId ||
        selection.binding.authority.envelopeDigest !== scope.authority.envelopeDigest) return CHANGED;
    const input = ownedHumanInput({ selection, fields }); const route = humanInputRoute(purpose, input.fields);
    const request: AtlassianWriteHttpRequest = { method: route.method, url: `${base}${route.path}`, jiraHumanInput: input,
      expect: purpose.startsWith("validate-") ? "json" : "none" };
    const consumed = options.onConsumed === undefined ? {} : { onHumanInputConsumed: options.onConsumed };
    // Native validators are reads. Only actual account/unlock effects receive mutation ACKs.
    if (purpose.startsWith("validate-")) return send(request, consumed);
    if (purpose !== "login") return preserveAcknowledgement({ actorUserKey: selected.key },
      (onResponse) => send(request, { ...consumed, onResponse }));
    if (sessions === undefined) return UNAVAILABLE;
    return preserveAcknowledgement({ actorUserKey: selected.key, userKey: selected.key, username: selected.name }, (onResponse) =>
      sessions.withLease(jiraSessionBindingForInput(selection.binding), async (session): Promise<AtlassianWriteHttpOutcome> => {
        session.invalidate();
        let candidate: JiraPrivateCookie | undefined;
        const response = await send(request, { privateAuthentication: { kind: "anonymous" }, ...consumed,
          onResponse, onJiraLoginCookie: (value) => { candidate = value; } });
        if (!response.ok) return response;
        const cookie = candidate;
        if (cookie === undefined || !(await proof(() => `${cookie.name}=${cookie.value}`, selected)))
          return { ok: false, reason: "unavailable", httpStatus: response.status };
        session.establish(cookie);
        return { ok: true, status: response.status, body: { sessionEstablished: true, userKey: selected.key, username: selected.name } };
      }));
  }
  async function sessionAction(action: "logout" | "release-websudo", expectedActorKey: string): Promise<AtlassianWriteHttpOutcome> {
    if (sessions === undefined) return UNAVAILABLE;
    const selected = await actor(expectedActorKey); if (selected === undefined) return CHANGED;
    const scope = binding(selected); if (scope === undefined) return CHANGED;
    return preserveAcknowledgement({ actorUserKey: selected.key, userKey: selected.key, username: selected.name }, (onResponse) => sessions.withLease(scope, async (session) => {
      if (session.current() === undefined || !(await proof(session.cookieHeader, selected))) { session.invalidate(); return UNAVAILABLE; }
      try {
        return await send({ method: "DELETE", url: `${base}/rest/auth/1/${action === "logout" ? "session" : "websudo"}`, expect: "none" },
          { onResponse, privateAuthentication: { kind: "session", scope: action === "logout" ? "logout" : "websudo", cookie: session.cookieHeader } });
      } finally { session.invalidate(); }
    }));
  }
  return {
    ...(options.legacyTemporaryRelease === undefined ? {} : { legacyTemporaryRelease: options.legacyTemporaryRelease }),
    identity: { perform, session: sessionAction, unlock: (expectedActorKey) => options.selection?.binding.actorUserKey === expectedActorKey
      ? perform("unlock-user-anonymization", {}) : Promise.resolve(CHANGED) },
    withAvatarSession: async (expectedActorKey, execute) => {
      if (sessions === undefined) return { ok: false, reason: "unavailable" };
      const selected = await actor(expectedActorKey); if (selected === undefined) return { ok: false, reason: "conflict" };
      const scope = binding(selected); if (scope === undefined) return { ok: false, reason: "conflict" };
      return sessions.withLease(scope, async (session: JiraPrivateSessionAccess) => {
        if (session.current() === undefined || !(await proof(session.cookieHeader, selected))) { session.invalidate(); return { ok: false, reason: "unavailable" }; }
        return execute(privateAvatarSession(privateOptions, context, session, options.legacyTemporaryRelease));
      });
    },
  };
}
