import {
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ID_PATTERN,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { errorBody } from "../route-error.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";

const DRAFT_ID = new RegExp(JIRA_DRAFT_ID_PATTERN, "u");
const DRAFT_DIGEST = new RegExp(JIRA_DRAFT_DIGEST_PATTERN, "u");
const CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function refused(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  refusal: "invalid-input" | "draft-not-found" | "draft-changed",
  startedAt: number,
): RouteResult {
  recordJiraDraftActivity(deps.activityLog, correlationIdOrUnknown(ctx.correlationId), {
    phase: "refused",
    refusal,
    newDraft: false,
    pageItemCount: 0,
    itemCount: 0,
    pageCount: 0,
    byteCount: 0,
    unresolvedRefCount: 0,
    violationCount: 0,
    durationMs: Date.now() - startedAt,
  });
  return refusal === "invalid-input"
    ? {
        status: 400,
        body: errorBody("INVALID_REQUEST", "Invalid draft request.", ctx.correlationId),
      }
    : {
        status: 404,
        body: errorBody(
          "JIRA_DRAFT_UNAVAILABLE",
          "The Jira draft is not available. Ask for it again to review it.",
          ctx.correlationId,
        ),
      };
}

/**
 * The staged backlog draft an approval covers (#4178), for the human who reviews it. It is served
 * only to the Chat that staged it and only while the digest in the request is the digest of the
 * items held now, so what the approval card shows is exactly what the approval commits to.
 */
export function readJiraDraftRoute(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const startedAt = Date.now();
  const draftId = ctx.params.draftId ?? "";
  const chatId = ctx.url.searchParams.get("chatId") ?? "";
  const digest = ctx.url.searchParams.get("digest") ?? "";
  if (!DRAFT_ID.test(draftId) || !CHAT_ID.test(chatId) || !DRAFT_DIGEST.test(digest))
    return refused(ctx, deps, "invalid-input", startedAt);
  const draft = deps.jiraDraftStore?.peek(draftId, chatId);
  if (draft === undefined) return refused(ctx, deps, "draft-not-found", startedAt);
  if (draft.digest !== digest) return refused(ctx, deps, "draft-changed", startedAt);
  return {
    status: 200,
    body: {
      draftId: draft.id,
      draftDigest: draft.digest,
      itemCount: draft.items.length,
      items: draft.items,
    },
    headers: { "Cache-Control": "no-store" },
  };
}

export const JIRA_DRAFT_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/atlassian-connectors/jira-drafts/:draftId",
    handler: readJiraDraftRoute,
  },
];
