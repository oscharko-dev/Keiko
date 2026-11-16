import {
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  type ChatDraft,
  type ChatDraftUpdate,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { readJsonRequestBodyOutcome } from "./bounded-request-body.js";
import { logChatDraftOperation, type PrivateDraftSurface } from "./chat-draft-log.js";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody } from "./route-error.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { invalidRequest, notFound, UiStoreError } from "./store/errors.js";

type DraftDeps = Pick<UiHandlerDeps, "store" | "codingAppSessionChannel">;
type DraftAuthority = NonNullable<ReturnType<typeof resolveAppSessionReadAuthority>>;
// JSON can represent every one-byte control character as six bytes (\u0000).
const MAX_DRAFT_BODY_BYTES = MAX_DESKTOP_CHAT_INPUT_BYTES * 6 + 1024;

function draftInput(body: Record<string, unknown>): ChatDraftUpdate {
  if (typeof body.text !== "string" || typeof body.expectedRevision !== "number")
    throw invalidRequest("Provide draft text and its current revision.");
  return { text: body.text, expectedRevision: body.expectedRevision };
}

function assertAuthority(
  ctx: RouteContext,
  deps: DraftDeps,
  surface: PrivateDraftSurface,
  expected?: DraftAuthority,
): DraftAuthority {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (
    authority === undefined ||
    (expected !== undefined &&
      (authority.sessionId !== expected.sessionId ||
        authority.rotationCount !== expected.rotationCount))
  )
    throw notFound(surface === "chat" ? "Chat draft" : "Coding Workbench draft");
  return authority;
}

function operationPhase(status: number): "failed" | "rejected" | "completed" {
  if (status >= 500) return "failed";
  if (status >= 400) return "rejected";
  return "completed";
}

async function withDraftAccess(
  ctx: RouteContext,
  deps: DraftDeps,
  draft: { readonly action: "read" | "save"; readonly surface: PrivateDraftSurface },
  operation: (authority: DraftAuthority) => RouteResult | Promise<RouteResult>,
): Promise<RouteResult> {
  const { action, surface } = draft;
  logChatDraftOperation(ctx.correlationId, action, "started", 0, surface);
  let result: RouteResult;
  try {
    result = await operation(assertAuthority(ctx, deps, surface));
  } catch (error) {
    if (!(error instanceof UiStoreError)) {
      logChatDraftOperation(ctx.correlationId, action, "failed", 500, surface);
      throw error;
    }
    result = {
      status: error.status,
      body: errorBody(error.code, error.message, ctx.correlationId),
    };
  }
  logChatDraftOperation(
    ctx.correlationId,
    action,
    operationPhase(result.status),
    result.status,
    surface,
  );
  return { ...result, headers: { "Cache-Control": "no-store" } };
}

interface DraftStore {
  readonly read: (store: DraftDeps["store"], key: string) => ChatDraft;
  readonly update: (store: DraftDeps["store"], key: string, update: ChatDraftUpdate) => ChatDraft;
}

const DRAFT_STORES: Readonly<Record<PrivateDraftSurface, DraftStore>> = {
  chat: {
    read: (store, key) => store.readChatDraft(key),
    update: (store, key, update) => store.updateChatDraft(key, update),
  },
  "coding-workbench": {
    read: (store, key) => store.readCodingWorkbenchDraft(key),
    update: (store, key, update) => store.updateCodingWorkbenchDraft(key, update),
  },
};

function readDraft(
  ctx: RouteContext,
  deps: DraftDeps,
  surface: PrivateDraftSurface,
): Promise<RouteResult> {
  return withDraftAccess(ctx, deps, { action: "read", surface }, () => ({
    status: 200,
    body: DRAFT_STORES[surface].read(deps.store, ctx.params.id ?? ""),
  }));
}

function saveDraft(
  ctx: RouteContext,
  deps: DraftDeps,
  surface: PrivateDraftSurface,
): Promise<RouteResult> {
  return withDraftAccess(ctx, deps, { action: "save", surface }, async (authority) => {
    const body = await readJsonRequestBodyOutcome(ctx.req, MAX_DRAFT_BODY_BYTES, ctx.correlationId);
    assertAuthority(ctx, deps, surface, authority);
    if (body.kind === "rejected") return body.response;
    return {
      status: 200,
      body: DRAFT_STORES[surface].update(deps.store, ctx.params.id ?? "", draftInput(body.value)),
    };
  });
}

export function handleReadChatDraft(ctx: RouteContext, deps: DraftDeps): Promise<RouteResult> {
  return readDraft(ctx, deps, "chat");
}

export function handleSaveChatDraft(ctx: RouteContext, deps: DraftDeps): Promise<RouteResult> {
  return saveDraft(ctx, deps, "chat");
}

export function handleReadCodingWorkbenchDraft(
  ctx: RouteContext,
  deps: DraftDeps,
): Promise<RouteResult> {
  return readDraft(ctx, deps, "coding-workbench");
}

export function handleSaveCodingWorkbenchDraft(
  ctx: RouteContext,
  deps: DraftDeps,
): Promise<RouteResult> {
  return saveDraft(ctx, deps, "coding-workbench");
}
