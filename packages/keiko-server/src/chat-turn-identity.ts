import type {
  Chat,
  ConversationDocumentContextWire,
  ConversationMemoryRequestWire,
  DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { ConversationAttachment } from "./conversation-validation.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";

const CANONICAL_CHAT_TURN_IDENTITY_DOMAIN = "keiko:canonical-chat-turn-semantics:v1";
const CANONICAL_CHAT_TURN_IDENTITY_VERSION = "canonical-chat-turn-v3";

export interface CanonicalChatTurnMemorySemantics {
  readonly enabled: boolean;
  readonly budgetTokens?: number | undefined;
  readonly mode?: ConversationMemoryRequestWire["mode"];
  readonly context: ConversationMemoryRuntimeContext;
}

interface CanonicalChatTurnCommonSemantics {
  readonly content: string;
  readonly modelId: string;
  readonly groundingScopeIdentity: string | null;
  readonly memory: CanonicalChatTurnMemorySemantics | null;
}

export type CanonicalChatTurnSemanticProjection =
  | (CanonicalChatTurnCommonSemantics & {
      readonly routeKind: "plain";
      readonly documentContext: readonly ConversationDocumentContextWire[];
      readonly attachments: readonly ConversationAttachment[];
      readonly discussionMode: DiscussionMode | null;
    })
  | (CanonicalChatTurnCommonSemantics & { readonly routeKind: "grounded" });

export function canonicalChatTurnMemorySemantics(
  request: Pick<ConversationMemoryRequestWire, "enabled" | "budgetTokens" | "mode"> | undefined,
  context: ConversationMemoryRuntimeContext | undefined,
): CanonicalChatTurnMemorySemantics | null {
  if (request === undefined) return null;
  if (context === undefined) {
    throw new Error("Canonical chat memory semantics require an authoritative context.");
  }
  return {
    enabled: request.enabled ?? true,
    ...(request.budgetTokens === undefined ? {} : { budgetTokens: request.budgetTokens }),
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    context,
  };
}

export function canonicalChatTurnGroundingScopeIdentity(chat: Chat): string {
  // Open/closed is an admission lifecycle state, not retrieval semantics. Normalizing it preserves
  // an exact completed replay after closure while still binding every connected knowledge source.
  return deriveChatGroundingScopeIdentity({ ...chat, status: "open" });
}

export function canonicalChatTurnIdentityContent(
  projection: CanonicalChatTurnSemanticProjection,
): string {
  const canonical = canonicalise([CANONICAL_CHAT_TURN_IDENTITY_DOMAIN, projection]);
  return JSON.stringify([CANONICAL_CHAT_TURN_IDENTITY_VERSION, sha256Hex(canonical)]);
}
