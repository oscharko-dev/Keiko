import {
  isMarkdownSkillRefusalReason,
  type MarkdownSkillRefusalReason,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { BffFetchOptions } from "./http";

/** Why the server refused a save: a closed reason, plus the template line it concerns when known. */
export interface MarkdownSkillRefusal {
  readonly reason: MarkdownSkillRefusalReason;
  readonly line?: number;
}

const REFUSAL_FIELD = "markdownSkillRefusal";

/** The refusal a save error carries, or undefined for a conflict, a transport or any other failure. */
export function markdownSkillRefusalOf(error: unknown): MarkdownSkillRefusal | undefined {
  if (typeof error !== "object" || error === null || !(REFUSAL_FIELD in error)) return undefined;
  const refusal: unknown = error[REFUSAL_FIELD];
  if (typeof refusal !== "object" || refusal === null) return undefined;
  const { reason, line } = refusal as { reason?: unknown; line?: unknown };
  if (!isMarkdownSkillRefusalReason(reason)) return undefined;
  return typeof line === "number" && Number.isSafeInteger(line) && line > 0
    ? { reason, line }
    : { reason };
}

/**
 * Copies the closed refusal off the error envelope onto the thrown error. A body that is not the
 * envelope, or a reason this build does not know, leaves the generic failure.
 */
export const carryMarkdownSkillRefusal: NonNullable<BffFetchOptions<unknown>["enrichError"]> = (
  error,
  envelope,
) => {
  const reason: unknown = envelope?.error["reason"];
  if (!isMarkdownSkillRefusalReason(reason)) return;
  const line: unknown = envelope?.error["line"];
  Object.assign(error, {
    [REFUSAL_FIELD]: typeof line === "number" ? { reason, line } : { reason },
  });
};
