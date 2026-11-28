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
 * How far below the local estimate a provider's reported usage may be and still be the count of the
 * same prompt. Tokenizers differ legitimately: a live Gemma 4 31B behind LiteLLM reported 35,798
 * tokens where the local estimate was 58,954 (ratio 0.61, no caching involved), and other
 * tokenizers are denser still on code. A fixed floor near that would flip on a legitimate model, so
 * the floor has two parts:
 * - with no ratio learned for the model, a report under `MIN_PLAUSIBLE_USAGE_RATIO` (a quarter) of
 *   the local estimate is refused: that is below any tokenizer difference seen, and is what a
 *   cache-excluded or broken counter looks like (Ollama behind LiteLLM reports a few hundred tokens
 *   for a 30k prompt);
 * - once a model's ratio is learned (the highest plausible report so far, at most 1), a report under
 *   `LEARNED_RATIO_FLOOR_SHARE` (half) of it times the local estimate is refused, so a model whose
 *   honest ratio is 0.61 trips at 0.30 and one whose honest ratio is 0.30 only at 0.15.
 * A refused report is never recorded: later prompts keep the conservative local estimate, which is
 * the behaviour without calibration.
 */
export const MIN_PLAUSIBLE_USAGE_RATIO = 0.25;
export const LEARNED_RATIO_FLOOR_SHARE = 0.5;
const MAX_RECORDS_PER_MODEL = 8;

/** What became of a provider's reported usage offered to the ledger. */
export type PromptUsageRecording = "recorded" | "implausible" | "unusable";

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
  private readonly learnedRatio = new Map<string, number>();

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
   * below the plausibility floor (see `MIN_PLAUSIBLE_USAGE_RATIO`) is refused ("implausible") and
   * leaves the ledger as it was.
   */
  record(mark: PromptCalibrationMark, providerTokens: number): PromptUsageRecording {
    if (!Number.isSafeInteger(providerTokens) || providerTokens <= 0) return "unusable";
    const learned = this.learnedRatio.get(mark.modelId);
    const floor =
      learned === undefined ? MIN_PLAUSIBLE_USAGE_RATIO : LEARNED_RATIO_FLOOR_SHARE * learned;
    if (providerTokens < mark.localTokens * floor) return "implausible";
    if (mark.localTokens > 0) {
      const ratio = Math.min(1, providerTokens / mark.localTokens);
      this.learnedRatio.set(mark.modelId, Math.max(learned ?? 0, ratio));
    }
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
    this.learnedRatio.clear();
  }

  private matching(
    modelId: string,
    request: PromptCalibrationInput,
  ): PromptCalibrationRecord | undefined {
    const records = this.byModel.get(modelId) ?? [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (
        record !== undefined &&
        request.messages.length >= record.messageCount &&
        promptPrefixDigest(request, record.messageCount) === record.digest
      )
        return record;
    }
    return undefined;
  }
}
