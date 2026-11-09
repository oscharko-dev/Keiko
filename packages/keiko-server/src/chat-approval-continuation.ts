import type { UiHandlerDeps } from "./deps.js";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatMessage } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./route-error.js";
import { readJsonObject } from "./files.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { isCurrentJiraChatWriteApproval } from "./atlassian/jiraChatWriteApproval.js";
import { sameWriteAction } from "./atlassian/chatWriteApprovalState.js";
import {
  continuations,
  entriesFor,
  recordContinuation,
  validateChatApprovalContinuation,
  type Continuation,
} from "./chat-approval-continuation-state.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { createRequestCancellation, type RequestCancellation } from "./request-cancellation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";

function currentPendingExpiry(
  deps: UiHandlerDeps,
  entry: Continuation,
  approval: ChatToolWriteApprovalView | undefined,
): number | undefined {
  if (
    !isPendingJiraApproval(approval) ||
    entry.observedApprovalIds?.has(approval.approvalId) !== true
  )
    return undefined;
  const retained = deps.atlassianActionApprovalRegistry?.getChatWriteApproval(
    approval.approvalId,
    entry.correlationId,
  );
  if (
    retained?.approval.state !== "pending" ||
    !sameWriteAction(retained.approval, approval) ||
    retained.approval.chatId !== entry.message.chatId
  )
    return undefined;
  return isCurrentJiraChatWriteApproval(
    deps,
    retained,
    new Date().toISOString(),
    entry.correlationId,
  )
    ? Math.min(approval.expiresAt, retained.approval.expiresAt)
    : undefined;
}
function isPendingJiraApproval(
  approval: ChatToolWriteApprovalView | undefined,
): approval is Extract<ChatToolWriteApprovalView, { kind: "jira-chat-write" }> {
  return (
    approval?.kind === "jira-chat-write" &&
    approval.state === "pending" &&
    approval.expiresAt > Date.now()
  );
}
function pendingExpiry(deps: UiHandlerDeps, entry: Continuation): number | undefined {
  if (!entry.live() || entry.controller.signal.aborted) return undefined;
  const message = deps.store.findMessageById(entry.message.id);
  if (message?.turnState !== "pending") return undefined;
  for (const exchange of message.toolTranscript?.exchanges ?? []) {
    const expiresAt = currentPendingExpiry(deps, entry, exchange.approval);
    if (expiresAt !== undefined) return expiresAt;
  }
  return undefined;
}

export interface ChatApprovalContinuation {
  readonly admit: (message: ChatMessage) => void;
  readonly retainOnClose: () => boolean;
  readonly dispose: () => void;
}

/** An opt-in changes delivery ownership only. It grants no action and never renews authority. */
class ApprovalContinuation implements ChatApprovalContinuation {
  private entry: Continuation | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionTimer: ReturnType<typeof setInterval> | undefined;
  public constructor(
    private readonly ctx: RouteContext,
    private readonly deps: UiHandlerDeps,
    private readonly controller: AbortController,
  ) {}
  private readonly releaseTimers = (): void => {
    clearTimeout(this.expiryTimer);
    clearInterval(this.sessionTimer);
  };
  public admit(message: ChatMessage): void {
    if (
      this.ctx.req.headers["x-keiko-chat-pending-lease"] !== "bounded" ||
      message.canonicalTurnRef === undefined
    )
      return;
    const session = resolveAppSessionReadAuthority(this.deps, this.ctx.req);
    const channel = this.deps.codingAppSessionChannel;
    if (session === undefined || channel?.isSessionLive === undefined) return;
    this.entry = {
      message,
      controller: this.controller,
      sessionId: session.sessionId,
      live: (): boolean => channel.isSessionLive?.(session.sessionId) === true,
      correlationId: this.ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    };
    entriesFor(this.deps.store).set(message.canonicalTurnRef, this.entry);
    recordContinuation(this.entry, "registered");
  }
  public retainOnClose(): boolean {
    if (this.entry === undefined) return false;
    try {
      const expiresAt = pendingExpiry(this.deps, this.entry);
      if (expiresAt === undefined) return false;
      recordContinuation(this.entry, "detached");
      const retained = this.entry;
      retained.expiresAt = expiresAt;
      // A held worker never keeps the process alive: shutdown must not wait for a review.
      this.expiryTimer = setTimeout(
        () => {
          this.controller.abort("approval continuation expired");
          recordContinuation(retained, "expired");
        },
        Math.max(0, expiresAt - Date.now()),
      );
      this.expiryTimer.unref();
      this.sessionTimer = setInterval(() => {
        validateChatApprovalContinuation(this.deps.store, retained.message);
      }, 1000);
      this.sessionTimer.unref();
      this.controller.signal.addEventListener("abort", this.releaseTimers, { once: true });
      return true;
    } catch (error) {
      emitServerDiagnostic(
        undefined,
        serverDiagnosticFromError({
          correlationId: this.ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
          operation: "chat.approval-continuation.state",
          source: "chat-approval-continuation",
          error,
          redact: () => "server-operation-failed",
        }),
      );
      return false;
    }
  }
  public dispose(): void {
    this.releaseTimers();
    this.controller.signal.removeEventListener("abort", this.releaseTimers);
    const entry = this.entry;
    if (entry?.message.canonicalTurnRef === undefined) return;
    const entries = continuations.get(this.deps.store);
    if (entries?.get(entry.message.canonicalTurnRef) === entry)
      entries.delete(entry.message.canonicalTurnRef);
    recordContinuation(entry, "released");
  }
}
export function createChatApprovalRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  reason: string,
): RequestCancellation & { readonly admit: (message: ChatMessage) => void } {
  const owner: { current?: ChatApprovalContinuation } = {};
  const cancellation = createRequestCancellation(ctx, reason, {
    retainOnClose: (): boolean => owner.current?.retainOnClose() === true,
  });
  const continuation = createChatApprovalContinuation(ctx, deps, cancellation.controller);
  owner.current = continuation;
  return {
    controller: cancellation.controller,
    signal: cancellation.signal,
    admit: (message): void => {
      continuation.admit(message);
    },
    dispose: (): void => {
      continuation.dispose();
      cancellation.dispose();
    },
  };
}

export function createChatApprovalContinuation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  controller: AbortController,
): ChatApprovalContinuation {
  return new ApprovalContinuation(ctx, deps, controller);
}

function cancellationIdentity(
  input: unknown,
): { readonly chatId: string; readonly canonicalTurnRef: string } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).length !== 2 ||
    typeof body.chatId !== "string" ||
    typeof body.canonicalTurnRef !== "string" ||
    !/^[a-f0-9]{64}$/u.test(body.canonicalTurnRef)
  )
    return undefined;
  return { chatId: body.chatId, canonicalTurnRef: body.canonicalTurnRef };
}
/**
 * Stop targets one existing admitted worker; stale identities cannot cancel another turn. Every
 * authenticated caller receives the same closed answer shape with HTTP 200: `cancelled` is true
 * only when this caller's own session owned the worker and it was still running. An unknown chat,
 * an absent or settled turn and another session's turn are indistinguishable, so Stop is no
 * existence oracle. A missing or invalid session keeps the existence-concealing 404.
 */
export async function handleCancelDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, 1024);
  const identity = cancellationIdentity(body);
  if (identity === undefined)
    return {
      status: body.status === 413 ? 413 : 400,
      body: errorBody("BAD_REQUEST", "Invalid Chat cancellation identity."),
    };
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined)
    return { status: 404, body: errorBody("NOT_FOUND", "Chat turn not found.") };
  return { status: 200, body: { cancelled: cancelOwnedEntry(deps, session.sessionId, identity) } };
}
function cancelOwnedEntry(
  deps: UiHandlerDeps,
  sessionId: string,
  identity: { readonly chatId: string; readonly canonicalTurnRef: string },
): boolean {
  const entry = continuations.get(deps.store)?.get(identity.canonicalTurnRef);
  if (entry?.message.chatId !== identity.chatId || entry.sessionId !== sessionId) return false;
  return cancelEntry(deps, entry);
}
function cancelEntry(deps: UiHandlerDeps, entry: Continuation): boolean {
  const active =
    deps.store.findMessageById(entry.message.id)?.turnState === "pending" &&
    !entry.controller.signal.aborted;
  if (active) {
    entry.controller.abort("human stopped Chat turn");
    recordContinuation(entry, "cancelled");
  }
  return active;
}
