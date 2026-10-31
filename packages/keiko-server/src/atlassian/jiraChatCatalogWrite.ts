import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ToolAuthorityAvailability } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  JiraChatAdmissionOptions,
  JiraChatCatalogAction,
  JiraChatCatalogContext,
} from "./jiraChatCatalogConsumer.js";
import type {
  ChatWriteApprovalClaim,
  ChatWriteApprovalEntry,
  JiraChatWriteActionIdentity,
} from "./chatWriteApprovalState.js";
import { sameWriteAction } from "./chatWriteApprovalState.js";
import { decideAtlassianEnvelopeAction } from "./actionPolicy.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import {
  isCurrentJiraChatWriteApproval,
  requestJiraChatWriteApproval,
} from "./jiraChatWriteApproval.js";

const DENIED = { ok: false, reason: "authority-invalid" } as const;
const REVIEW = { ok: false, reason: "approval-required" } as const;
const ALLOWED = { ok: true } as const;

export function jiraChatWriteAction(
  action: JiraChatCatalogAction,
): JiraChatWriteActionIdentity | undefined {
  const operation = JIRA_MUTATION_OPERATIONS.find((value) => value === action.tool);
  return operation === undefined
    ? undefined
    : {
        invocationId: action.actionId,
        operation,
        actionDigest: sha256Hex(
          canonicalise({ operation, argumentsDigest: action.argumentsDigest }),
        ),
      };
}

interface CurrentWrite {
  readonly context: JiraChatCatalogContext;
  readonly identity: JiraChatWriteActionIdentity;
  readonly current: Extract<ReturnType<typeof resolveCurrentJiraChatAuthority>, { ok: true }>;
  readonly registry: NonNullable<
    JiraChatAdmissionOptions["deps"]["atlassianActionApprovalRegistry"]
  >;
  readonly policy: ReturnType<typeof decideAtlassianEnvelopeAction>;
  readonly entry: ChatWriteApprovalEntry | undefined;
  readonly nowIso: string;
}
function currentWrite(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): CurrentWrite | undefined {
  const context = options.context();
  const identity = jiraChatWriteAction(action);
  const nowIso = new Date(options.now()).toISOString();
  const current = resolveCurrentJiraChatAuthority(
    options.deps,
    context.chatId,
    context.authorityReference,
    nowIso,
    context.correlationId,
  );
  const registry = options.deps.atlassianActionApprovalRegistry;
  if (!current.ok || identity === undefined || registry === undefined || context.signal.aborted)
    return undefined;
  const policy = decideAtlassianEnvelopeAction(
    JIRA_MANAGED_ACTION_TYPES[identity.operation],
    current.envelope,
  );
  const entry = registry.findChatWriteApproval(
    current.envelope.subject,
    context.authorityReference,
    identity.invocationId,
    context.correlationId,
  );
  return { context, identity, current, registry, policy, entry, nowIso };
}

function currentEntry(
  options: JiraChatAdmissionOptions,
  facts: CurrentWrite,
): ChatWriteApprovalEntry | undefined {
  const entry = facts.entry;
  return entry !== undefined &&
    sameWriteAction(entry.approval, facts.identity) &&
    isCurrentJiraChatWriteApproval(options.deps, entry, facts.nowIso, facts.context.correlationId)
    ? entry
    : undefined;
}

export function jiraChatWritePermission(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
  claim?: ChatWriteApprovalClaim,
): ToolAuthorityAvailability {
  const facts = currentWrite(options, action);
  if (facts === undefined) return DENIED;
  if (facts.policy.kind === "allowed") return ALLOWED;
  if (facts.policy.kind !== "review-required") return DENIED;
  if (facts.entry === undefined) return REVIEW;
  const entry = currentEntry(options, facts);
  if (entry === undefined) return DENIED;
  if (entry.approval.state === "pending") return REVIEW;
  if (entry.approval.state === "approved") return ALLOWED;
  return claim !== undefined &&
    facts.registry.isChatWriteClaimCurrent(
      claim,
      facts.current.envelope.subject,
      facts.context.authorityReference,
      facts.identity,
      facts.context.correlationId,
    )
    ? ALLOWED
    : DENIED;
}

export async function requestCatalogWriteApproval(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): Promise<void> {
  const context = options.context();
  const identity = jiraChatWriteAction(action);
  if (identity === undefined || options.reviewableWrite?.(action) !== true) return;
  const result = requestJiraChatWriteApproval(
    options.deps,
    context.chatId,
    context.authorityReference,
    identity,
    new Date(options.now()).toISOString(),
    context.correlationId,
    identity.operation === "jira.draft" ? options.draftItemRefs?.(action) : undefined,
  );
  if (result.kind === "review-required")
    await options.requestWriteConsent?.(result.approval, context.signal);
}

export function claimJiraChatWrite(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): { readonly ok: true; readonly claim?: ChatWriteApprovalClaim } | { readonly ok: false } {
  const facts = currentWrite(options, action);
  if (facts === undefined) return { ok: false };
  if (facts.policy.kind === "allowed") return { ok: true };
  const entry = currentEntry(options, facts);
  if (facts.policy.kind !== "review-required" || entry === undefined) return { ok: false };
  return facts.registry.claimChatWriteApproval(
    entry.approval.approvalId,
    facts.current.envelope.subject,
    facts.context.authorityReference,
    facts.identity,
    facts.context.correlationId,
  );
}
