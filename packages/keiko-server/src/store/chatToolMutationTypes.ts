import type {
  JiraMutationOperation,
  JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
interface ChatToolMutationIdentity {
  readonly invocationId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  readonly turnRef: string;
  readonly actorId: string;
  readonly authorityDigest: string;
  readonly actionDigest: string;
  readonly correlationId: string;
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
/** Persistence only. The composing consumer still owns authority, approvals and HTTP dispatch. */
export interface ChatToolMutationStore {
  readonly find: (invocationId: string) => ChatToolMutationRecord | undefined;
  readonly prepare: (intent: ChatToolMutationIntent) => ChatToolMutationPreparation;
  readonly beginDispatch: (invocationId: string, guard: () => boolean) => boolean;
  readonly acknowledge: (invocationId: string, httpStatus: number) => ChatToolMutationRecord;
  readonly acknowledgeMcp: (invocationId: string, success: boolean) => ChatToolMutationRecord;
  readonly settle: (invocationId: string, outcome: JiraMutationOutcome) => ChatToolMutationRecord;
}
