import {
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  type ChatDraftUpdate,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { readJsonRequestBodyOutcome } from "./bounded-request-body.js";
import { logChatDraftOperation } from "./chat-draft-log.js";
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
  expected?: DraftAuthority,
): DraftAuthority {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (
    authority === undefined ||
    (expected !== undefined &&
      (authority.sessionId !== expected.sessionId ||
        authority.rotationCount !== expected.rotationCount))
  )
    throw notFound("Chat draft");
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
  action: "read" | "save",
  operation: (authority: DraftAuthority) => RouteResult | Promise<RouteResult>,
): Promise<RouteResult> {
  logChatDraftOperation(ctx.correlationId, action, "started", 0);
  let result: RouteResult;
  try {
    result = await operation(assertAuthority(ctx, deps));
  } catch (error) {
    if (!(error instanceof UiStoreError)) {
      logChatDraftOperation(ctx.correlationId, action, "failed", 500);
      throw error;
    }
    result = {
      status: error.status,
      body: errorBody(error.code, error.message, ctx.correlationId),
    };
  }
  logChatDraftOperation(ctx.correlationId, action, operationPhase(result.status), result.status);
  return { ...result, headers: { "Cache-Control": "no-store" } };
}

export function handleReadChatDraft(ctx: RouteContext, deps: DraftDeps): Promise<RouteResult> {
  return withDraftAccess(ctx, deps, "read", () => ({
    status: 200,
    body: deps.store.readChatDraft(ctx.params.id ?? ""),
  }));
}

export function handleSaveChatDraft(ctx: RouteContext, deps: DraftDeps): Promise<RouteResult> {
  return withDraftAccess(ctx, deps, "save", async (authority) => {
    const body = await readJsonRequestBodyOutcome(ctx.req, MAX_DRAFT_BODY_BYTES, ctx.correlationId);
    assertAuthority(ctx, deps, authority);
    if (body.kind === "rejected") return body.response;
    return {
      status: 200,
      body: deps.store.updateChatDraft(ctx.params.id ?? "", draftInput(body.value)),
    };
  });
}
