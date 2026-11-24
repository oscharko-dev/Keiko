import {
  acceptedChatToolAuthorityEnvelope,
  isAcceptedChatToolTurn,
  isRequestedChatToolModeCurrent,
  reserveResolvedChatToolAuthority,
} from "./chat-tool-authority.js";
import { CHAT_TOOL_DEFAULT_MODE } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  ChatToolAuthorityEnvelope,
  ConnectedFolderChatToolAuthoritySubject,
  KnowledgeChatToolAuthoritySubject,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { Chat } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { recordChatAuthorityResult } from "./editor/chatAuthorityActivity.js";
import { chatToolTurnBudget } from "./chat-tool-turn-budget.js";

// A local Chat source is read on this device: Knowledge Pods and a connected folder. Both carry one
// server-derived configuration digest, one read scope, no consent grant and no write approval, so
// their authority lifecycle is one implementation parameterized by the source.

export type LocalChatSourceSubject =
  KnowledgeChatToolAuthoritySubject | ConnectedFolderChatToolAuthoritySubject;
export type LocalChatSourceScope = "knowledge.read" | "folder.read";

export type LocalChatSourceAuthorityDeps = Pick<
  UiHandlerDeps,
  | "store"
  | "serverPrincipal"
  | "agentAuthorityRegistry"
  | "autonomousDeliveryDeploymentCeiling"
  | "chatToolTurnBudget"
>;

export type LocalChatSourceEnvelope<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
> = ChatToolAuthorityEnvelope & {
  readonly subject: Subject;
  readonly connectorScopes: readonly [Scope];
};

export interface LocalChatSourceAuthorityFailure {
  readonly ok: false;
  readonly reason: "invalid" | "expired" | "budget-exceeded" | "revoked";
}

export type CurrentLocalChatSourceAuthority<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
> =
  | { readonly ok: true; readonly envelope: LocalChatSourceEnvelope<Subject, Scope> }
  | LocalChatSourceAuthorityFailure;

export type MintedLocalChatSourceAuthority<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
> =
  | {
      readonly ok: true;
      readonly envelope: LocalChatSourceEnvelope<Subject, Scope>;
      readonly reference: EditorAgentGovernedAuthorityReference;
    }
  | LocalChatSourceAuthorityFailure;

export interface LocalChatSource<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
> {
  readonly kind: Subject["kind"];
  readonly scope: Scope;
  /**
   * Digest of the Chat's current server-owned selection of this source, or undefined when the Chat
   * has none. A changed selection changes the digest, so it can never reuse a retained authority.
   */
  readonly configurationDigest: (chat: Chat) => string | undefined;
  readonly subject: (facts: {
    readonly actorDigest: string;
    readonly chatId: string;
    readonly configurationDigest: string;
  }) => Subject;
}

export interface LocalChatSourceAuthority<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
> {
  readonly isEnvelope: (
    envelope: ChatToolAuthorityEnvelope,
  ) => envelope is LocalChatSourceEnvelope<Subject, Scope>;
  readonly prepare: (
    deps: LocalChatSourceAuthorityDeps,
    turn: AcceptedJiraChatTurn,
  ) => CurrentLocalChatSourceAuthority<Subject, Scope>;
  readonly mint: (
    deps: LocalChatSourceAuthorityDeps,
    turn: AcceptedJiraChatTurn,
  ) => MintedLocalChatSourceAuthority<Subject, Scope>;
  readonly resolve: (
    deps: LocalChatSourceAuthorityDeps,
    chatId: string,
    reference: EditorAgentGovernedAuthorityReference,
    nowIso: string,
    correlationId: string,
  ) => CurrentLocalChatSourceAuthority<Subject, Scope>;
  readonly reserve: (
    deps: LocalChatSourceAuthorityDeps,
    chatId: string,
    reference: EditorAgentGovernedAuthorityReference,
    usage: CodingWorkbenchRuntimeDelegationUsage,
    nowIso: string,
    correlationId: string,
  ) => CurrentLocalChatSourceAuthority<Subject, Scope>;
}

const INVALID = { ok: false, reason: "invalid" } as const;

function deploymentCeiling(
  deps: LocalChatSourceAuthorityDeps,
): NonNullable<LocalChatSourceAuthorityDeps["autonomousDeliveryDeploymentCeiling"]> {
  return deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
}

/** Selection is server-owned; a changed scope can never reuse a turn's retained authority. */
function currentSubject<Subject extends LocalChatSourceSubject, Scope extends LocalChatSourceScope>(
  source: LocalChatSource<Subject, Scope>,
  deps: LocalChatSourceAuthorityDeps,
  chatId: string,
): Subject | undefined {
  const chat = deps.store.findChatById(chatId);
  const actorDigest = jiraChatActorDigest(deps);
  if (chat === undefined || chat.status === "closed" || actorDigest === undefined) return undefined;
  const configurationDigest = source.configurationDigest(chat);
  return configurationDigest === undefined
    ? undefined
    : source.subject({ actorDigest, chatId, configurationDigest });
}

function isSourceEnvelope<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
>(
  source: LocalChatSource<Subject, Scope>,
  envelope: ChatToolAuthorityEnvelope,
): envelope is LocalChatSourceEnvelope<Subject, Scope> {
  return (
    envelope.subject.kind === source.kind &&
    envelope.connectorScopes.length === 1 &&
    envelope.connectorScopes[0] === source.scope
  );
}

function prepare<Subject extends LocalChatSourceSubject, Scope extends LocalChatSourceScope>(
  source: LocalChatSource<Subject, Scope>,
  deps: LocalChatSourceAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): CurrentLocalChatSourceAuthority<Subject, Scope> {
  const subject = currentSubject(source, deps, turn.chatId);
  if (
    subject === undefined ||
    deps.agentAuthorityRegistry === undefined ||
    !isAcceptedChatToolTurn(deps, turn)
  )
    return recordChatAuthorityResult(
      "register",
      INVALID,
      { chatId: turn.chatId },
      turn.correlationId,
    );
  const requestedMode = deps.store.findChatById(turn.chatId)?.toolMode ?? CHAT_TOOL_DEFAULT_MODE;
  const scopes: readonly [Scope] = [source.scope];
  return {
    ok: true,
    envelope: acceptedChatToolAuthorityEnvelope(
      turn,
      subject,
      requestedMode,
      deploymentCeiling(deps),
      chatToolTurnBudget(deps),
      scopes,
    ),
  };
}

function mint<Subject extends LocalChatSourceSubject, Scope extends LocalChatSourceScope>(
  source: LocalChatSource<Subject, Scope>,
  deps: LocalChatSourceAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): MintedLocalChatSourceAuthority<Subject, Scope> {
  const prepared = prepare(source, deps, turn);
  if (!prepared.ok) return prepared;
  const result = deps.agentAuthorityRegistry?.registerChat(
    prepared.envelope,
    prepared.envelope.deploymentCeiling,
    new Date(turn.nowMs).toISOString(),
    turn.correlationId,
  );
  return result?.ok === true
    ? { ...prepared, reference: result.authorityRef }
    : (result ?? INVALID);
}

function resolve<Subject extends LocalChatSourceSubject, Scope extends LocalChatSourceScope>(
  source: LocalChatSource<Subject, Scope>,
  deps: LocalChatSourceAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): CurrentLocalChatSourceAuthority<Subject, Scope> {
  const subject = currentSubject(source, deps, chatId);
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
    deploymentCeiling(deps),
    nowIso,
    correlationId,
  );
  if (!current.ok) return current;
  const { envelope } = current;
  if (
    !isSourceEnvelope(source, envelope) ||
    !isRequestedChatToolModeCurrent(envelope, deps.store.findChatById(chatId))
  )
    return recordChatAuthorityResult(
      "current-state",
      INVALID,
      { subject, readiness: "mode-changed" },
      correlationId,
    );
  const scopes: readonly [Scope] = [source.scope];
  return recordChatAuthorityResult(
    "current-state",
    { ok: true, envelope: { ...envelope, subject: envelope.subject, connectorScopes: scopes } },
    { subject, readiness: "ready" },
    correlationId,
  );
}

/** One authority lifecycle for a local Chat source; the source names its kind, scope and digest. */
export function createLocalChatSourceAuthority<
  Subject extends LocalChatSourceSubject,
  Scope extends LocalChatSourceScope,
>(source: LocalChatSource<Subject, Scope>): LocalChatSourceAuthority<Subject, Scope> {
  return {
    isEnvelope: (envelope): envelope is LocalChatSourceEnvelope<Subject, Scope> =>
      isSourceEnvelope(source, envelope),
    prepare: (deps, turn) => prepare(source, deps, turn),
    mint: (deps, turn) => mint(source, deps, turn),
    resolve: (deps, chatId, reference, nowIso, correlationId) =>
      resolve(source, deps, chatId, reference, nowIso, correlationId),
    reserve: (deps, chatId, reference, usage, nowIso, correlationId) =>
      reserveResolvedChatToolAuthority(
        deps,
        resolve(source, deps, chatId, reference, nowIso, correlationId),
        reference,
        usage,
        nowIso,
        correlationId,
        deploymentCeiling(deps),
      ) ?? INVALID,
  };
}
