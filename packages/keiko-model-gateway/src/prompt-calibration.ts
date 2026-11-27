import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { GatewayPromptTokenInput } from "./prompt-token-accounting.js";

/**
 * The share of a new prompt's locally estimated growth that is added on top of the provider's
 * reported usage. The local estimate stays a conservative upper bound for the NEW text; only the
 * already-measured prefix is replaced by what the provider really reported.
 */
export const PROMPT_CALIBRATION_DELTA_FACTOR = 1.1;
const MAX_RECORDS_PER_MODEL = 8;

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

  /** Records the provider's real prompt usage for a prompt that was admitted with `mark`. */
  record(mark: PromptCalibrationMark, providerTokens: number): void {
    if (!Number.isSafeInteger(providerTokens) || providerTokens <= 0) return;
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
