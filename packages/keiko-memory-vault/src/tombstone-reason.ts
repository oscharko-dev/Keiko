import {
  MEMORY_FORGET_REASONS,
  MEMORY_FORGET_REASON_USER_REQUEST,
  type MemoryForgetReason,
} from "@oscharko-dev/keiko-contracts/memory";

const MEMORY_FORGET_REASON_SET = new Set<string>(MEMORY_FORGET_REASONS);

export function isMemoryTombstoneReasonCode(reason: string): reason is MemoryForgetReason {
  return MEMORY_FORGET_REASON_SET.has(reason);
}

export function sanitizeMemoryTombstoneReason(
  reason: string | undefined,
): MemoryForgetReason | undefined {
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return undefined;
  return isMemoryTombstoneReasonCode(trimmed)
    ? trimmed
    : MEMORY_FORGET_REASON_USER_REQUEST;
}
