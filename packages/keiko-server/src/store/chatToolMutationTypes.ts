import type {
  JiraMutationOperation,
  JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export interface ChatToolMutationIntent {
  readonly invocationId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  readonly turnRef: string;
  readonly actorId: string;
  readonly podId: string;
  readonly bindingGeneration: number;
  readonly credentialGeneration: number;
  readonly authorityDigest: string;
  readonly actionDigest: string;
  readonly operation: JiraMutationOperation;
  readonly correlationId: string;
}
export interface ChatToolMutationRecord extends Omit<ChatToolMutationIntent, "userMessageId"> {
  readonly userMessageId: string | null;
  readonly phase: "prepared" | "dispatched" | "acknowledged" | "settled";
  readonly outcome: JiraMutationOutcome | null;
  readonly httpStatus: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type ChatToolMutationPreparation =
  | { readonly kind: "prepared" | "replayed"; readonly record: ChatToolMutationRecord }
  | { readonly kind: "blocked"; readonly reason: "unknown-effect" | "in-flight" | "capacity" };
/** Persistence only. The composing consumer still owns authority, approvals and HTTP dispatch. */
export interface ChatToolMutationStore {
  readonly find: (invocationId: string) => ChatToolMutationRecord | undefined;
  readonly prepare: (intent: ChatToolMutationIntent) => ChatToolMutationPreparation;
  readonly beginDispatch: (invocationId: string, guard: () => boolean) => boolean;
  readonly acknowledge: (invocationId: string, httpStatus: number) => ChatToolMutationRecord;
  readonly settle: (invocationId: string, outcome: JiraMutationOutcome) => ChatToolMutationRecord;
}
