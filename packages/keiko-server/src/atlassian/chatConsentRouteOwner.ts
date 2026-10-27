import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteResult } from "../routes.js";
import { readJsonObject } from "../files.js";
import { errorBody } from "../route-error.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import type { AtlassianActionApprovalRegistry } from "./actionApprovals.js";

type ConsentPhase = "read-grant" | "write-approval";
export interface ChatConsentRouteOwner<Entry, Decision> {
  readonly phase: ConsentPhase;
  readonly project: (entry: Entry, correlationId: string) => unknown;
  readonly retained: (
    registry: AtlassianActionApprovalRegistry,
    id: string,
    correlationId: string,
  ) => Entry | undefined;
  readonly isCurrent: (
    deps: UiHandlerDeps,
    entry: Entry,
    nowIso: string,
    correlationId: string,
  ) => boolean;
  readonly validate: (
    value: unknown,
  ) => { readonly ok: true; readonly value: Decision } | { readonly ok: false };
}
interface CurrentConsent<Entry> {
  readonly entry: Entry;
  readonly registry: AtlassianActionApprovalRegistry;
}
const FAILURES = {
  "read-grant": {
    code: "CHAT_READ_CONSENT_UNAVAILABLE",
    message: "The Chat read consent is not available for this request.",
  },
  "write-approval": {
    code: "CHAT_WRITE_APPROVAL_UNAVAILABLE",
    message: "The Chat write approval is not available for this request.",
  },
} as const;

export function chatConsentFailure(
  ctx: RouteContext,
  phase: ConsentPhase,
  status: 400 | 404 | 409 | 413,
): RouteResult {
  recordChatAuthorityResult(
    phase,
    { ok: false, reason: "invalid" },
    phase === "read-grant"
      ? { grantId: ctx.params.approvalId }
      : { approvalId: ctx.params.approvalId },
    ctx.correlationId,
  );
  const code =
    status === 400
      ? "VALIDATION_FAILED"
      : status === 413
        ? "PAYLOAD_TOO_LARGE"
        : FAILURES[phase].code;
  return { status, body: errorBody(code, FAILURES[phase].message, ctx.correlationId) };
}

export function currentChatConsent<Entry, Decision>(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  owner: ChatConsentRouteOwner<Entry, Decision>,
  nowIso: string,
): CurrentConsent<Entry> | undefined {
  const id = ctx.params.approvalId;
  const registry = deps.atlassianActionApprovalRegistry;
  if (registry === undefined || !isSafeAtlassianIdentifier(id)) return undefined;
  const correlation = correlationIdOrUnknown(ctx.correlationId);
  const entry = owner.retained(registry, id, correlation);
  if (entry === undefined || !owner.isCurrent(deps, entry, nowIso, correlation)) return undefined;
  return { entry, registry };
}

export function getChatConsent<Entry, Decision>(
  owner: ChatConsentRouteOwner<Entry, Decision>,
): (ctx: RouteContext, deps: UiHandlerDeps) => RouteResult {
  return (ctx, deps): RouteResult => {
    const current = currentChatConsent(ctx, deps, owner, new Date().toISOString());
    if (current === undefined) return chatConsentFailure(ctx, owner.phase, 404);
    return {
      status: 200,
      body: { approval: owner.project(current.entry, correlationIdOrUnknown(ctx.correlationId)) },
    };
  };
}

/** The common body boundary always resolves custody/authority after awaiting all input bytes. */
export async function readCurrentChatDecision<Entry, Decision>(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  owner: ChatConsentRouteOwner<Entry, Decision>,
): Promise<
  | {
      readonly ok: true;
      readonly entry: Entry;
      readonly registry: AtlassianActionApprovalRegistry;
      readonly value: Decision;
      readonly nowIso: string;
    }
  | { readonly ok: false; readonly response: RouteResult }
> {
  const body = await readJsonObject(ctx.req, 4096);
  if (body.status === 413)
    return { ok: false, response: chatConsentFailure(ctx, owner.phase, 413) };
  const parsed = owner.validate(body);
  if (!parsed.ok) return { ok: false, response: chatConsentFailure(ctx, owner.phase, 400) };
  const nowIso = new Date().toISOString();
  const current = currentChatConsent(ctx, deps, owner, nowIso);
  if (current === undefined)
    return { ok: false, response: chatConsentFailure(ctx, owner.phase, 404) };
  return { ok: true, ...current, value: parsed.value, nowIso };
}
