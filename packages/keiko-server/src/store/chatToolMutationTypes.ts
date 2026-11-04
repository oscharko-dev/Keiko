import type {
  AtlassianConnectorWriteFailureReason,
  JiraFieldValidationFailure,
  JiraMutationOperation,
  JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
/** Actual private producer identities; no tool arguments or results are persisted. */
export interface CodingToolMutationConsumer {
  readonly kind: "coding";
  readonly runId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly argumentsDigest: string;
  /** Existing budget admission identity; never part of the canonical mutation identity. */
  readonly mcpActionDigest?: string | undefined;
}
interface ChatToolMutationIdentity {
  readonly consumer?: CodingToolMutationConsumer;
  readonly invocationId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  readonly turnRef: string;
  readonly actorId: string;
  readonly authorityDigest: string;
  readonly actionDigest: string;
  readonly correlationId: string;
  /**
   * Set on the items of one approved backlog draft (#4178): the digest of the approved draft
   * action. The items are bounded by their batch, not by the per-turn bound on single writes.
   */
  readonly batchDigest?: string;
}
export interface JiraChatToolMutationIntent extends ChatToolMutationIdentity {
  readonly sourceKind?: "jira";
  readonly podId: string;
  readonly bindingGeneration: number;
  readonly credentialGeneration: number;
  readonly operation: JiraMutationOperation;
}
export interface McpChatToolMutationIntent extends ChatToolMutationIdentity {
  readonly sourceKind: "configured-mcp";
  readonly podId: null;
  readonly bindingGeneration: null;
  readonly credentialGeneration: null;
  readonly configurationDigest: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly operation: string;
}
export type ChatToolMutationIntent = JiraChatToolMutationIntent | McpChatToolMutationIntent;
interface MutationObservation {
  readonly userMessageId: string | null;
  readonly phase: "prepared" | "dispatched" | "acknowledged" | "settled";
  readonly outcome: JiraMutationOutcome | null;
  readonly httpStatus: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type ChatToolMutationRecord = MutationObservation &
  (
    | Omit<JiraChatToolMutationIntent, "userMessageId">
    | (Omit<McpChatToolMutationIntent, "userMessageId"> & {
        readonly protocolOutcome: "success" | "error" | null;
      })
  );
export type ChatToolMutationPreparation =
  | { readonly kind: "prepared" | "replayed"; readonly record: ChatToolMutationRecord }
  | { readonly kind: "blocked"; readonly reason: "unknown-effect" | "in-flight" | "capacity" };
/**
 * Body-free counts of the issue links one write asked for (#4176): requested, present afterwards,
 * and not present. They describe the settled write on the Activity Log and are never persisted.
 */
export interface ChatToolMutationLinkCounts {
  readonly requested: number;
  readonly created: number;
  readonly failed: number;
}
/**
 * What a caller proves when it settles a dispatched write as `rejected` (#4176): Jira answered with
 * a client error and its own parsable error document. Without it a response never proves that no
 * effect occurred.
 */
export interface ChatToolMutationSettleEvidence {
  readonly jiraErrorDocument: true;
}
/**
 * Keiko's own closed reason for a write it refused before dispatch, so the settled line explains a
 * local refusal without its arguments. Activity Log only; never persisted.
 */
export interface ChatToolMutationLocalRefusal {
  readonly reason: AtlassianConnectorWriteFailureReason;
  readonly validation?: JiraFieldValidationFailure | undefined;
}
/** Persistence only. The composing consumer still owns authority, approvals and HTTP dispatch. */
export interface ChatToolMutationStore {
  readonly find: (invocationId: string) => ChatToolMutationRecord | undefined;
  readonly prepare: (intent: ChatToolMutationIntent) => ChatToolMutationPreparation;
  readonly beginDispatch: (invocationId: string, guard: () => boolean) => boolean;
  readonly acknowledge: (invocationId: string, httpStatus: number) => ChatToolMutationRecord;
  readonly acknowledgeMcp: (invocationId: string, success: boolean) => ChatToolMutationRecord;
  readonly settle: (
    invocationId: string,
    outcome: JiraMutationOutcome,
    links?: ChatToolMutationLinkCounts,
    evidence?: ChatToolMutationSettleEvidence,
    refusal?: ChatToolMutationLocalRefusal,
  ) => ChatToolMutationRecord;
  /** Finds one admitted call; an ambiguous dispatch is refused, never guessed. */
  readonly preparedNative?: (input: {
    readonly runId: string;
    readonly turnRef: string;
    readonly sessionId: string;
    readonly serverName: string;
    readonly toolName: string;
    readonly argumentsDigest: string;
  }) => ChatToolMutationRecord | undefined;
  readonly unsettledNative?: (runId: string) => readonly ChatToolMutationRecord[];
}
