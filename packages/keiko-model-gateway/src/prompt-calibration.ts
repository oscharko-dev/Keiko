import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { GatewayPromptTokenInput } from "./prompt-token-accounting.js";
import type { ModelProviderConfig } from "./types.js";

/**
 * The share of a new prompt's locally estimated growth that is added on top of the provider's
 * reported usage. The local estimate stays a conservative upper bound for the NEW text; only the
 * already-measured prefix is replaced by what the provider really reported.
 */
export const PROMPT_CALIBRATION_DELTA_FACTOR = 1.1;
/**
 * How far from the local estimate a provider's reported usage may be and still be the count of the
 * same prompt. Tokenizers differ legitimately: a live Gemma 4 31B behind LiteLLM reported 35,798
 * tokens where the local estimate was 58,954 (ratio 0.61, no caching involved), and other
 * tokenizers are denser still on code. A fixed floor near that would flip on a legitimate model, so
 * the floor has two parts:
 * - with no ratio learned for the model, a report under `MIN_PLAUSIBLE_USAGE_RATIO` (a quarter) of
 *   the local estimate is refused: that is below any tokenizer difference seen, and is what a
 *   cache-excluded or broken counter looks like (Ollama behind LiteLLM reports a few hundred tokens
 *   for a 30k prompt);
 * - once ratios are learned, the floor is `LEARNED_RATIO_FLOOR_SHARE` (half) of the MEDIAN of the
 *   last `LEARNED_RATIO_WINDOW` accepted ratios, never above `MAX_LEARNED_FLOOR` (0.3). A median
 *   cannot be moved by one odd report (template or tool-schema overhead on a short prompt can make
 *   a single ratio near 1), and the cap bounds what even a poisoned history can cost: an honest
 *   0.40 report is accepted after any history, while a model whose honest ratio is 0.30 still trips
 *   only at 0.15. Re-learning from repeated refused reports is deliberately not done: a persistent
 *   cache-excluded backend would then teach the ledger its own under-reports.
 * The ceiling is the same defect the other way: a report above `MAX_PLAUSIBLE_USAGE_RATIO` (twice)
 * the local estimate would make every later prompt look larger than it is and refuse prompts that
 * fit, so it is refused as well. A refused report is never recorded: later prompts keep the
 * conservative local estimate, which is the behaviour without calibration.
 */
export const MIN_PLAUSIBLE_USAGE_RATIO = 0.25;
export const MAX_PLAUSIBLE_USAGE_RATIO = 2;
export const LEARNED_RATIO_FLOOR_SHARE = 0.5;
export const MAX_LEARNED_FLOOR = 0.3;
const LEARNED_RATIO_WINDOW = 8;
const MAX_RECORDS_PER_MODEL = 8;

/** What became of a provider's reported usage offered to the ledger. */
export type PromptUsageRecording = "recorded" | "implausibly-low" | "implausibly-high" | "unusable";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

interface PromptCalibrationRecord {
  readonly messageCount: number;
  readonly digest: string;
  readonly localTokens: number;
  readonly providerTokens: number;
}

/** What one admitted prompt leaves behind until the provider reports its real usage. */
export interface PromptCalibrationMark {
  readonly modelId: string;
  readonly messageCount: number;
  readonly digest: string;
  readonly localTokens: number;
}

/**
 * The key a calibration is valid for: the alias, the provider endpoint and the digest of the
 * deployment observed behind the alias. An alias the gateway points at another deployment or
 * endpoint therefore starts without the previous one's measured ratio. Digested, never logged.
 */
export function promptCalibrationKey(
  provider: Pick<ModelProviderConfig, "modelId" | "baseUrl" | "deploymentIdentitySha256">,
): string {
  return sha256Hex(
    canonicalise({
      modelId: provider.modelId,
      baseUrl: provider.baseUrl,
      deployment: provider.deploymentIdentitySha256 ?? null,
    }),
  );
}

export type PromptCalibrationInput = Pick<GatewayPromptTokenInput, "messages" | "tools">;

/** Digest of the first `count` messages and the tool catalog; the identity of a prompt prefix. */
export function promptPrefixDigest(request: PromptCalibrationInput, count: number): string {
  return sha256Hex(
    canonicalise({ messages: request.messages.slice(0, count), tools: request.tools }),
  );
}

export function promptCalibrationMark(
  modelId: string,
  request: PromptCalibrationInput,
  localTokens: number,
): PromptCalibrationMark {
  const messageCount = request.messages.length;
  return { modelId, messageCount, digest: promptPrefixDigest(request, messageCount), localTokens };
}

/**
 * Provider-reported prompt usage of earlier requests, keyed by the content they sent. A new request
 * that provably extends a recorded one (same tools, identical message prefix) is estimated as the
 * provider's real count for that prefix plus the estimated growth, instead of the local tokenizer's
 * estimate of the whole prompt, which can be far off for repetitive or unusual text. Anything that
 * does not match falls back to the conservative local estimate; the ledger never lowers a measured
 * provider count and holds no prompt text, only digests and counts.
 */
export class PromptCalibrationLedger {
  private readonly byModel = new Map<string, PromptCalibrationRecord[]>();
  private readonly ratios = new Map<string, number[]>();

  /** The calibrated token estimate of `request`, or undefined when no recorded prefix matches. */
  calibrate(
    modelId: string,
    request: PromptCalibrationInput,
    localTokens: number,
  ): number | undefined {
    const record = this.matching(modelId, request);
    if (record === undefined) return undefined;
    const growth = Math.max(0, localTokens - record.localTokens);
    const ratio = record.localTokens > 0 ? record.providerTokens / record.localTokens : 1;
    const factor = Math.max(PROMPT_CALIBRATION_DELTA_FACTOR, ratio);
    return record.providerTokens + Math.ceil(growth * factor);
  }

  /**
   * Records the provider's real prompt usage for a prompt that was admitted with `mark`. A report
   * outside the plausibility band (see `MIN_PLAUSIBLE_USAGE_RATIO`) is refused and leaves the
   * ledger as it was.
   */
  record(mark: PromptCalibrationMark, providerTokens: number): PromptUsageRecording {
    if (!Number.isSafeInteger(providerTokens) || providerTokens <= 0) return "unusable";
    const ratios = this.ratios.get(mark.modelId) ?? [];
    const floor =
      ratios.length === 0
        ? MIN_PLAUSIBLE_USAGE_RATIO
        : Math.min(MAX_LEARNED_FLOOR, LEARNED_RATIO_FLOOR_SHARE * median(ratios));
    if (providerTokens < mark.localTokens * floor) return "implausibly-low";
    if (providerTokens > mark.localTokens * MAX_PLAUSIBLE_USAGE_RATIO) return "implausibly-high";
    if (mark.localTokens > 0)
      this.ratios.set(
        mark.modelId,
        [...ratios, providerTokens / mark.localTokens].slice(-LEARNED_RATIO_WINDOW),
      );
    const records = this.byModel.get(mark.modelId) ?? [];
    const kept = records.filter(
      (entry) => entry.messageCount !== mark.messageCount || entry.digest !== mark.digest,
    );
    kept.push({
      messageCount: mark.messageCount,
      digest: mark.digest,
      localTokens: mark.localTokens,
      providerTokens,
    });
    this.byModel.set(mark.modelId, kept.slice(-MAX_RECORDS_PER_MODEL));
    return "recorded";
  }

  /** Forgets every record; for test isolation of a process-wide instance. */
  reset(): void {
    this.byModel.clear();
    this.ratios.clear();
  }

  private matching(
    modelId: string,
    request: PromptCalibrationInput,
  ): PromptCalibrationRecord | undefined {
    // The longest matching prefix is the most specific measurement; recency only breaks a tie, so
    // the order in which requests complete never changes what the same prompt is estimated at.
    let best: PromptCalibrationRecord | undefined;
    for (const record of this.byModel.get(modelId) ?? []) {
      if (
        request.messages.length >= record.messageCount &&
        (best === undefined || record.messageCount >= best.messageCount) &&
        promptPrefixDigest(request, record.messageCount) === record.digest
      )
        best = record;
    }
    return best;
  }
}
