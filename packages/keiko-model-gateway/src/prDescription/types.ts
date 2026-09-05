import type { GitChangeSnapshot } from "@oscharko-dev/keiko-contracts";
import type {
  PrDescriptionArtifact,
  PrDescriptionLanguage,
  PrDescriptionReason,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import type { Gateway } from "../gateway.js";
import type { ModelGatewayLogSink } from "../observability.js";
import type { GatewayConfig, UsageMetadata } from "../types.js";

export interface PrDescriptionEvidence {
  readonly evidenceId: string;
  /** Transient, access-controlled file/hunk text from the snapshot owner's raw lane. */
  readonly text: string;
}

export interface PrDescriptionResolvedSnapshot {
  readonly snapshot: GitChangeSnapshot;
  readonly evidence: readonly PrDescriptionEvidence[];
}

/** Server-selected limits; callers may tighten, never widen the fixed ceiling. */
export interface PrDescriptionLimits {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxChunkBytes: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface PrDescriptionBranding {
  /** An operator-approved public immutable copy of the canonical logo, never model input. */
  readonly immutableLogoUrl?: string;
  /** Established by the existing server configuration/asset check, never inferred from a URL. */
  readonly availability?: "public" | "private" | "unavailable" | "unrenderable";
}

export interface PrDescriptionRequest {
  readonly snapshotReference: string;
  readonly language: PrDescriptionLanguage;
  /** Existing authority owner admits the operation; this core neither mints nor widens authority. */
  readonly authority: { readonly authorityDigest: string; readonly correlationId: string };
  /** User refinement intent is untrusted text in the evidence message, never trusted instructions. */
  readonly refinement?: string;
  readonly signal?: AbortSignal;
}

export interface PrDescriptionDeps {
  readonly resolveSnapshot: (
    reference: string,
    signal: AbortSignal,
  ) => Promise<PrDescriptionResolvedSnapshot | undefined>;
  /** Revalidates the caller's exact authority immediately around every provider call. */
  readonly revalidateAuthority: (
    authority: PrDescriptionRequest["authority"],
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  readonly gateway: Pick<Gateway, "chat">;
  readonly config: GatewayConfig;
  readonly log: ModelGatewayLogSink;
  /** Existing server stack-frame port; returns only dist-anchored, body-free evidence. */
  readonly errorEvidence?: (error: unknown) => {
    readonly frames: readonly string[];
    readonly causeChain: readonly string[];
  };
  readonly limits?: Partial<PrDescriptionLimits>;
  readonly branding?: PrDescriptionBranding;
  readonly now?: () => number;
}

export type PrDescriptionGenerationResult =
  | {
      readonly status: "generated";
      readonly artifact: PrDescriptionArtifact;
      /** Actual aggregate of accepted provider calls; absent only when no call was made. */
      readonly usage?: PrDescriptionGenerationUsage | undefined;
    }
  | { readonly status: "unavailable"; readonly reason: PrDescriptionReason };

export interface PrDescriptionGenerationUsage {
  readonly modelId: string;
  readonly requestId: string;
  readonly requestCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly costClass: UsageMetadata["costClass"];
}

export const PR_DESCRIPTION_LIMIT_CEILINGS: PrDescriptionLimits = Object.freeze({
  maxCalls: 8,
  maxTokens: 32_768,
  maxInputBytes: 131_072,
  maxOutputBytes: 65_536,
  maxChunkBytes: 24_576,
  maxOutputTokens: 2_048,
  timeoutMs: 30_000,
});

export function resolvePrDescriptionLimits(
  overrides: Partial<PrDescriptionLimits> = {},
): PrDescriptionLimits {
  const result = { ...PR_DESCRIPTION_LIMIT_CEILINGS };
  for (const key of Object.keys(result) as (keyof PrDescriptionLimits)[]) {
    const supplied = overrides[key];
    if (supplied === undefined) continue;
    result[key] =
      Number.isSafeInteger(supplied) && supplied >= 0 ? Math.min(result[key], supplied) : 0;
  }
  return result;
}
