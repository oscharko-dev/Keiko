import {
  JiraHumanInputCustodyError,
  type JiraHumanInputBinding,
  type JiraHumanInputCustody,
  type AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { Chat, ChatMessage, ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_HUMAN_INPUT_MAX_BYTES,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import type { UiHandlerDeps } from "../deps.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import { recordJiraHumanInput } from "./credentialActivity.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

const NO_STORE = { "Cache-Control": "no-store" } as const;
type Action = "inspect" | "submit" | "cancel";
interface OwnedInput {
  readonly custody: JiraHumanInputCustody;
  readonly binding: JiraHumanInputBinding;
  readonly requestId: string;
  readonly codingPublish?: (view: JiraHumanInputView) => void;
}
function failureMessage(status: number): string {
  if (status === 404) return "The private Jira input request is not available.";
  if (status === 400) return "Provide exactly the requested fields for the current input revision.";
  return "The Jira input request changed or expired. Refresh its state before continuing.";
}
function failure(ctx: RouteContext, status: number): RouteResult {
  return {
    status,
    headers: NO_STORE,
    body: errorBody("JIRA_HUMAN_INPUT_UNAVAILABLE", failureMessage(status), ctx.correlationId),
  };
}
function requestId(ctx: RouteContext): string | undefined {
  const value = ctx.params.requestId;
  // Opaque ASCII IDs need no decoder; escaped aliases and malformed escapes are unavailable.
  return typeof value === "string" && /^jhi_[a-f0-9]{64}$/u.test(value) ? value : undefined;
}
interface RetainedChatInput {
  readonly context: Extract<JiraHumanInputBinding["context"], { kind: "chat" }>;
  readonly message: ChatMessage;
  readonly exchange: ChatToolExchange;
  readonly chat: Chat | undefined;
  readonly metadata: Extract<AtlassianCredentialMetadata, { deployment: "data-center" }>;
}
function ownedMessage(message: ChatMessage | undefined, chatId: string): message is ChatMessage {
  return message?.chatId === chatId && message.role === "user";
}
function ownedExchange(
  exchange: ChatToolExchange | undefined,
  owned: OwnedInput,
): exchange is ChatToolExchange {
  return (
    exchange?.call.name === owned.binding.operation.replace(/[.-]/gu, "_") &&
    sha256Hex(canonicalise(exchange.call.arguments)) === owned.binding.argumentsDigest &&
    exchange.humanInput?.requestId === owned.requestId
  );
}
/** A vault reference grants no Chat access. Reconstruct ownership from the retained real call. */
function retainedChatInput(deps: UiHandlerDeps, owned: OwnedInput): RetainedChatInput | undefined {
  const { binding } = owned;
  if (binding.context.kind !== "chat") return undefined;
  const context = binding.context;
  const message = deps.store.findMessageById(context.messageId);
  const exchange = message?.toolTranscript?.exchanges.find(
    (entry) => entry.call.id === context.callId,
  );
  const chat = deps.store.findChatById(context.chatId);
  const metadata = deps.atlassianConnectorCredentials?.custody.getMetadata(binding.authRef);
  if (
    !ownedMessage(message, context.chatId) ||
    !ownedExchange(exchange, owned) ||
    metadata?.deployment !== "data-center"
  )
    return undefined;
  return { context, message, exchange, chat, metadata };
}
function currentChatPod(retained: RetainedChatInput, binding: JiraHumanInputBinding): boolean {
  const { chat, metadata } = retained;
  return (
    chat?.status !== "closed" &&
    chat?.jiraPodBinding?.podId === metadata.livePod?.podId &&
    chat?.jiraPodBinding?.authenticationGeneration === binding.authenticationGeneration
  );
}
function chatContextCurrent(
  deps: UiHandlerDeps,
  owned: OwnedInput,
  action: Action,
  correlationId: string,
): boolean {
  const retained = retainedChatInput(deps, owned);
  if (retained === undefined) return false;
  if (action === "inspect") return true;
  const authority = resolveCurrentJiraChatAuthority(
    deps,
    retained.context.chatId,
    owned.binding.authority,
    new Date().toISOString(),
    correlationId,
  );
  return (
    authority.ok &&
    retained.message.turnState === "pending" &&
    retained.exchange.result === undefined &&
    currentChatPod(retained, owned.binding)
  );
}
function custodyInput(ctx: RouteContext, deps: UiHandlerDeps): OwnedInput | undefined {
  const id = requestId(ctx);
  const principal = jiraChatActorDigest(deps);
  const custody = deps.atlassianConnectorCredentials?.custody.humanInputs;
  if (id === undefined || principal === undefined || custody === undefined) return undefined;
  const binding = custody.bindingFor(id, principal);
  if (binding === undefined) return undefined;
  return { custody, binding, requestId: id };
}
function ownedInput(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  action: Action,
): OwnedInput | undefined {
  const owned = custodyInput(ctx, deps);
  if (owned === undefined) return undefined;
  if (owned.binding.context.kind === "coding") {
    const current = deps.codingJiraInputContext?.(owned.binding, owned.requestId);
    return current === undefined ? undefined : { ...owned, codingPublish: current.publish };
  }
  return chatContextCurrent(deps, owned, action, ctx.correlationId ?? UNKNOWN_CORRELATION_ID)
    ? owned
    : undefined;
}
function publish(
  deps: UiHandlerDeps,
  ctx: RouteContext,
  owned: OwnedInput,
  view: JiraHumanInputView,
): void {
  if (owned.binding.context.kind === "coding") {
    owned.codingPublish?.(view);
    return;
  }
  const { messageId, callId } = owned.binding.context;
  const message = deps.store.findMessageById(messageId);
  const exchange = message?.toolTranscript?.exchanges.find((entry) => entry.call.id === callId);
  if (message?.turnState === "pending" && exchange?.result === undefined)
    deps.store.updateChatToolTranscript(
      messageId,
      { kind: "human-input", callId, view },
      ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    );
}
function response(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  owned: OwnedInput,
  view: JiraHumanInputView | undefined,
): RouteResult {
  if (view === undefined) return failure(ctx, 404);
  publish(deps, ctx, owned, view);
  return { status: 200, headers: NO_STORE, body: view };
}
function cancelInput(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const id = requestId(ctx);
  const principal = jiraChatActorDigest(deps);
  if (id === undefined || principal === undefined) return failure(ctx, 404);
  // Delete-only custody does not need a still-live call or revoked execution authority.
  const view = deps.atlassianConnectorCredentials?.custody.humanInputs?.cancelOwned(id, principal);
  return view === undefined ? failure(ctx, 404) : { status: 200, headers: NO_STORE, body: view };
}
async function submitInput(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  owned: OwnedInput,
): Promise<RouteResult> {
  if (owned.binding.review === undefined) return failure(ctx, 409);
  // This bounded reader logs counts/classifications only. No input value enters a diagnostic.
  const body = await readJsonRequestBodyOutcome(
    ctx.req,
    JIRA_HUMAN_INPUT_MAX_BYTES + 1024,
    ctx.correlationId,
  );
  if (body.kind === "rejected") return { ...body.response, headers: NO_STORE };
  if (
    Object.keys(body.value).sort(compareStrings).join() !== "expectedRevision,values" ||
    typeof body.value.expectedRevision !== "string"
  )
    return failure(ctx, 400);
  // Body arrival may outlive the call or a Pod switch. Revalidate before the durable CAS.
  if (ownedInput(ctx, deps, "submit")?.requestId !== owned.requestId) return failure(ctx, 409);
  const view = owned.custody.submit(
    owned.requestId,
    owned.binding,
    body.value.expectedRevision,
    body.value.values,
  );
  recordJiraHumanInput(
    deps.atlassianConnectorCredentials,
    ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    "provided",
    owned.binding.operationCorrelationId,
  );
  return response(ctx, deps, owned, view);
}
async function run(ctx: RouteContext, deps: UiHandlerDeps, action: Action): Promise<RouteResult> {
  try {
    if (action === "cancel") return cancelInput(ctx, deps);
    const owned = ownedInput(ctx, deps, action);
    if (owned === undefined) return failure(ctx, 404);
    if (action === "inspect")
      return response(ctx, deps, owned, owned.custody.inspect(owned.requestId, owned.binding));
    return await submitInput(ctx, deps, owned);
  } catch (error) {
    if (!(error instanceof JiraHumanInputCustodyError)) throw error;
    return failure(ctx, error.code === "invalid-input" ? 400 : 409);
  }
}
export function handleGetJiraHumanInput(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return run(ctx, deps, "inspect");
}
export function handleSubmitJiraHumanInput(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return run(ctx, deps, "submit");
}
export function handleCancelJiraHumanInput(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return run(ctx, deps, "cancel");
}
