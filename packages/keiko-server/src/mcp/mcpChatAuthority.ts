import { randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/harness";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { MCP_CHAT_READ_DISCLOSURE_VERSION } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import type {
  ChatToolAuthorityEnvelope,
  ChatToolReadGrantView,
  McpChatToolAuthoritySubject,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { jiraChatActorDigest } from "../atlassian/jiraPodAccess.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import {
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
} from "../atlassian/actionApprovals.js";
import {
  projectChatReadGrant,
  sameReadGrantSubject,
  type ChatReadGrantEntry,
} from "../atlassian/chatReadGrantState.js";
import type { AcceptedJiraChatTurn } from "../atlassian/jiraChatAuthority.js";

export type McpChatAuthorityDeps = Pick<
  UiHandlerDeps,
  | "store"
  | "serverPrincipal"
  | "mcpSettings"
  | "agentAuthorityRegistry"
  | "autonomousDeliveryDeploymentCeiling"
  | "atlassianActionApprovalRegistry"
>;
export type McpChatAuthorityEnvelope = ChatToolAuthorityEnvelope & {
  readonly subject: McpChatToolAuthoritySubject;
};
interface Failure {
  readonly ok: false;
  readonly reason: "invalid" | "expired" | "budget-exceeded" | "revoked";
}
export type CurrentMcpChatAuthority =
  { readonly ok: true; readonly envelope: McpChatAuthorityEnvelope } | Failure;
const INVALID = { ok: false, reason: "invalid" } as const;

function currentSubject(
  deps: McpChatAuthorityDeps,
  chatId: string,
  correlationId: string,
): McpChatToolAuthoritySubject | undefined {
  const chat = deps.store.findChatById(chatId);
  const actorDigest = jiraChatActorDigest(deps);
  const settings = deps.mcpSettings?.read(correlationId);
  if (
    chat === undefined ||
    chat.status === "closed" ||
    actorDigest === undefined ||
    settings?.servers.some(
      (server) =>
        server.enabled &&
        (server.discovery === "automatic" || Object.keys(server.tools).length > 0),
    ) !== true
  )
    return undefined;
  return { kind: "configured-mcp", actorDigest, chatId, configurationDigest: settings.revision };
}

function validTurnLifetime(turn: AcceptedJiraChatTurn): boolean {
  const deadline = turn.startedAtMs + DEFAULT_LIMITS.maxWallTimeMs;
  return (
    Number.isSafeInteger(turn.startedAtMs) &&
    Number.isSafeInteger(turn.nowMs) &&
    Number.isFinite(new Date(deadline).getTime()) &&
    turn.startedAtMs >= 0 &&
    turn.nowMs >= turn.startedAtMs &&
    turn.nowMs < deadline
  );
}
function acceptedTurn(deps: McpChatAuthorityDeps, turn: AcceptedJiraChatTurn): boolean {
  const message = deps.store.findMessageById(turn.userMessageId);
  return (
    validTurnLifetime(turn) &&
    message?.role === "user" &&
    message.chatId === turn.chatId &&
    message.timestamp === turn.startedAtMs &&
    (message.turnState === undefined || message.turnState === "pending") &&
    deps.store.listMessages(turn.chatId, 1).at(-1)?.id === message.id
  );
}

function envelopeFor(
  deps: McpChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
  subject: McpChatToolAuthoritySubject,
): McpChatAuthorityEnvelope {
  const requestedMode = deps.store.findChatById(turn.chatId)?.toolMode ?? "governed-assist";
  const deploymentCeiling = deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
  const runId = `chat-${sha256Hex(canonicalise({ chatId: turn.chatId, userMessageId: turn.userMessageId }))}`;
  return {
    schemaVersion: "1",
    kind: "chat-tool-authority",
    runId,
    subject,
    requestedMode,
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
    actionClasses: ["connector-access", "network-egress"],
    connectorScopes: ["mcp.tools"],
    budget: {
      maxRuntimeMs: DEFAULT_LIMITS.maxWallTimeMs,
      maxToolCalls: DEFAULT_LIMITS.maxToolCalls,
      maxPromptTokens: 100_000,
      maxPatchBytes: 0,
    },
    expiresAt: new Date(turn.startedAtMs + DEFAULT_LIMITS.maxWallTimeMs).toISOString(),
    approvalProofDigest: sha256Hex(
      canonicalise({
        runId,
        subject,
        requestedMode,
        deploymentCeiling,
        userMessageId: turn.userMessageId,
        acceptedAtMs: turn.startedAtMs,
      }),
    ),
  };
}

/** Validate without registration so all source authorities can share one atomic admission. */
export function prepareAcceptedMcpChatAuthority(
  deps: McpChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): { readonly ok: true; readonly envelope: McpChatAuthorityEnvelope } | Failure {
  const subject = currentSubject(deps, turn.chatId, turn.correlationId);
  if (
    subject === undefined ||
    deps.agentAuthorityRegistry === undefined ||
    !acceptedTurn(deps, turn)
  )
    return recordChatAuthorityResult(
      "register",
      INVALID,
      { chatId: turn.chatId },
      turn.correlationId,
    );
  return { ok: true, envelope: envelopeFor(deps, turn, subject) };
}

/** Same accepted-message registry and cumulative budget as Jira; no fabricated Pod or Coding session. */
export function mintAcceptedMcpChatAuthority(
  deps: McpChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
):
  | {
      readonly ok: true;
      readonly envelope: McpChatAuthorityEnvelope;
      readonly reference: EditorAgentGovernedAuthorityReference;
    }
  | Failure {
  const prepared = prepareAcceptedMcpChatAuthority(deps, turn);
  if (!prepared.ok) return prepared;
  const { envelope } = prepared;
  const result = deps.agentAuthorityRegistry?.registerChat(
    envelope,
    envelope.deploymentCeiling,
    new Date(turn.nowMs).toISOString(),
    turn.correlationId,
  );
  return result?.ok === true
    ? { ok: true, envelope, reference: result.authorityRef }
    : (result ?? INVALID);
}

export function resolveCurrentMcpChatAuthority(
  deps: McpChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): CurrentMcpChatAuthority {
  const subject = currentSubject(deps, chatId, correlationId);
  if (subject === undefined || deps.agentAuthorityRegistry === undefined)
    return recordChatAuthorityResult(
      "current-state",
      INVALID,
      { chatId, authorityDigest: reference.envelopeDigest },
      correlationId,
    );
  const current = deps.agentAuthorityRegistry.resolveChat(
    reference,
    subject,
    deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
    nowIso,
    correlationId,
  );
  if (!current.ok || current.envelope.subject.kind !== "configured-mcp")
    return recordChatAuthorityResult(
      "current-state",
      !current.ok ? current : INVALID,
      { chatId, authorityDigest: reference.envelopeDigest },
      correlationId,
    );
  if (
    current.envelope.requestedMode !==
    (deps.store.findChatById(chatId)?.toolMode ?? "governed-assist")
  )
    return recordChatAuthorityResult(
      "current-state",
      INVALID,
      { subject, readiness: "mode-changed" },
      correlationId,
    );
  return recordChatAuthorityResult(
    "current-state",
    { ok: true, envelope: { ...current.envelope, subject: current.envelope.subject } },
    { subject, readiness: "ready" },
    correlationId,
  );
}

export function reserveCurrentMcpChatAuthority(
  deps: McpChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  usage: CodingWorkbenchRuntimeDelegationUsage,
  nowIso: string,
  correlationId: string,
): CurrentMcpChatAuthority {
  const current = resolveCurrentMcpChatAuthority(deps, chatId, reference, nowIso, correlationId);
  if (!current.ok) return current;
  const reserved = deps.agentAuthorityRegistry?.reserveForChat(
    reference,
    current.envelope.subject,
    current.envelope.deploymentCeiling,
    usage,
    nowIso,
    correlationId,
  );
  return reserved?.ok === true ? current : (reserved ?? INVALID);
}

/** A granted disclosure can outlive its originating turn, but never its actor/configuration or TTL. */
export function isCurrentMcpChatReadGrant(
  deps: McpChatAuthorityDeps,
  entry: ChatReadGrantEntry,
  nowIso: string,
  correlationId: string,
): boolean {
  if (entry.grant.subject.kind !== "configured-mcp") return false;
  const subject = currentSubject(deps, entry.grant.subject.chatId, correlationId);
  const now = Date.parse(nowIso);
  if (
    subject === undefined ||
    !sameReadGrantSubject(entry.grant, subject) ||
    !(entry.grant.requestedAt <= now && entry.grant.expiresAt > now)
  )
    return false;
  if (entry.grant.state === "granted") return true;
  const current = resolveCurrentMcpChatAuthority(
    deps,
    subject.chatId,
    entry.authority,
    nowIso,
    correlationId,
  );
  return current.ok && entry.grant.expiresAt <= Date.parse(current.envelope.expiresAt);
}
export type McpChatReadGrantAdmission =
  | { readonly kind: "granted" | "review-required"; readonly grant: ChatToolReadGrantView }
  | {
      readonly kind: "denied";
      readonly reason: "authority-denied" | "unavailable" | "rejected" | "capacity-exhausted";
    };

function reuseReadGrant(
  deps: McpChatAuthorityDeps,
  subject: McpChatToolAuthoritySubject,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): McpChatReadGrantAdmission | undefined {
  const registry = deps.atlassianActionApprovalRegistry;
  if (registry === undefined) return { kind: "denied", reason: "unavailable" };
  for (let attempt = 0; attempt < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; attempt++) {
    const previous = registry.findChatReadGrantForRequest(subject, authority, correlationId);
    if (previous === undefined) return undefined;
    if (previous.grant.state !== "pending" && previous.grant.state !== "granted")
      return { kind: "denied", reason: "rejected" };
    if (isCurrentMcpChatReadGrant(deps, previous, nowIso, correlationId))
      return {
        kind: previous.grant.state === "granted" ? "granted" : "review-required",
        grant: projectChatReadGrant(previous.grant),
      };
    registry.revokeChatReadGrant(previous.grant.grantId, correlationId);
  }
  return { kind: "denied", reason: "capacity-exhausted" };
}

export function requestMcpChatReadGrant(
  deps: McpChatAuthorityDeps,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): McpChatReadGrantAdmission {
  const current = resolveCurrentMcpChatAuthority(deps, chatId, authority, nowIso, correlationId);
  const registry = deps.atlassianActionApprovalRegistry;
  if (!current.ok || registry === undefined) return { kind: "denied", reason: "authority-denied" };
  const reused = reuseReadGrant(deps, current.envelope.subject, authority, nowIso, correlationId);
  if (reused !== undefined) return reused;
  const now = Date.parse(nowIso);
  const grant = {
    schemaVersion: "1",
    kind: "mcp-chat-read-grant",
    grantId: randomUUID(),
    subject: current.envelope.subject,
    disclosureVersion: MCP_CHAT_READ_DISCLOSURE_VERSION,
    requestedAt: now,
    expiresAt: Math.min(
      Date.parse(current.envelope.expiresAt),
      now + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
    ),
    state: "pending",
    consentProofDigest: null,
  } as const;
  const created = registry.createChatReadGrant({ grant, authority }, correlationId);
  if (!created.ok)
    return {
      kind: "denied",
      reason: created.reason === "capacity-exhausted" ? created.reason : "unavailable",
    };
  return { kind: "review-required", grant: projectChatReadGrant(grant) };
}
