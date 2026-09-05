import type { GitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitCiProviderFacts } from "./git-ci-facts.js";
import type { GitProviderReadRunner } from "./git-provider-observation.js";

export interface GitCiFailureContextInput {
  readonly facts: GitCiProviderFacts;
  readonly run: GitProviderReadRunner;
  readonly stillAuthorized: () => boolean;
  readonly signal?: AbortSignal;
  /** Optional existing credential-aware redactor; the shared baseline redactor always also runs. */
  readonly redactText?: (text: string) => string;
}
export type {
  BoundedGitCiFailureContext,
  GitCiFailureContextEntry,
  GitCiFailureContextResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitCiFailureContextEntry } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
export interface GitCiFailureSource {
  readonly kind: "check-run" | "workflow-run";
  readonly id: number;
  readonly attempt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface GitCiFailureCollection {
  readonly entries: GitCiFailureContextEntry[];
  truncated: boolean;
}
export const GIT_CI_FAILURE_MAX_BYTES = 16_384;
export const GIT_CI_FAILURE_MAX_INPUT_BYTES = 262_144;
export const GIT_CI_FAILURE_MAX_ENTRIES = 32;
export const GIT_CI_FAILURE_MAX_SOURCES = 4;
export function ciFailureObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function ciFailurePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function ciFailureCompleted(value: Record<string, unknown>): boolean {
  return (
    value.status === "completed" &&
    typeof value.conclusion === "string" &&
    new Set(["failure", "timed_out", "action_required", "startup_failure", "error"]).has(
      value.conclusion,
    )
  );
}
export class GitCiFailureContextError extends Error {
  public constructor(public readonly failure: GitDeliveryObservationFailure) {
    super("CI failure context unavailable");
    this.name = "GitCiFailureContextError";
  }
}
