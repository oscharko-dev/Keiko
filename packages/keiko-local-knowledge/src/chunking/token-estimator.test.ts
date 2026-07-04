import { describe, expect, it } from "vitest";

import {
  CONSERVATIVE_TOKENIZER_ID,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  QWEN3_SENTENCEPIECE_TOKENIZER_ID,
  CHUNKING_STRATEGY_VERSION,
} from "./types.js";
import {
  charsForTokenBudget,
  conservativeTokenEstimatorTokenizer,
  createQwen3SentencePieceTokenizerFromModule,
  defaultTokenEstimator,
  loadOptionalQwen3SentencePieceTokenizer,
} from "./token-estimator.js";

describe("defaultTokenEstimator", () => {
  it("uses the WP4 chunking defaults and boundary strategy version", () => {
    expect(CHUNKING_STRATEGY_VERSION).toBe("boundary-v3");
    expect(DEFAULT_MAX_TOKENS).toBe(512);
    expect(DEFAULT_OVERLAP_TOKENS).toBe(50);
  });

  it("labels the conservative fallback as an estimator, not as Qwen3", () => {
    expect(conservativeTokenEstimatorTokenizer.identity).toBe(CONSERVATIVE_TOKENIZER_ID);
    expect(conservativeTokenEstimatorTokenizer.identity).not.toBe(QWEN3_SENTENCEPIECE_TOKENIZER_ID);
    expect(conservativeTokenEstimatorTokenizer.kind).toBe("estimator");
    expect(conservativeTokenEstimatorTokenizer.countTokens("alpha beta")).toBe(
      defaultTokenEstimator("alpha beta"),
    );
  });

  it("is more conservative than a 4-char heuristic for CJK and token-dense identifiers", () => {
    const cjk = "客户数据同步策略".repeat(40);
    const code = "BillingService.processPayment_v2(TS_999, customer_id, retry_count);".repeat(20);

    expect(defaultTokenEstimator(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 4));
    expect(defaultTokenEstimator(code)).toBeGreaterThan(Math.ceil(code.length / 4));
  });

  it("keeps small English prose in the same order of magnitude", () => {
    const prose = "The quick brown fox jumps over the lazy dog.";
    expect(defaultTokenEstimator(prose)).toBeGreaterThan(0);
    expect(defaultTokenEstimator(prose)).toBeLessThan(20);
  });

  it("keeps charsForTokenBudget as an initial cap, not the authoritative token count", () => {
    const budgetChars = charsForTokenBudget(512);
    expect(budgetChars).toBe(2048);
    expect(defaultTokenEstimator("漢".repeat(budgetChars))).toBeGreaterThan(512);
  });
});

describe("Qwen3/SentencePiece tokenizer adapter", () => {
  it("counts tokens through a provided Qwen3-compatible encode implementation", async () => {
    const tokenizer = await createQwen3SentencePieceTokenizerFromModule({
      tokenizerIdentity: QWEN3_SENTENCEPIECE_TOKENIZER_ID,
      encode: (text: string) =>
        text
          .split(/\s+/u)
          .filter(Boolean)
          .map((_part, i) => i),
    });

    expect(tokenizer.identity).toBe(QWEN3_SENTENCEPIECE_TOKENIZER_ID);
    expect(tokenizer.kind).toBe("tokenizer");
    expect(tokenizer.countTokens("alpha beta gamma")).toBe(3);
  });

  it("loads the optional Qwen3 tokenizer when the runtime module is configured", async () => {
    const result = await loadOptionalQwen3SentencePieceTokenizer(
      {
        KEIKO_LOCAL_KNOWLEDGE_TOKENIZER: "qwen3-sentencepiece",
        KEIKO_QWEN3_TOKENIZER_MODULE: "test-qwen-tokenizer",
      },
      () =>
        Promise.resolve({
          tokenizerIdentity: QWEN3_SENTENCEPIECE_TOKENIZER_ID,
          encode: (text: string): string[] => Array.from(text),
        }),
    );

    expect(result.diagnostic.status).toBe("loaded");
    expect(result.tokenizer.identity).toBe(QWEN3_SENTENCEPIECE_TOKENIZER_ID);
    expect(result.tokenizer.countTokens("abc")).toBe(3);
  });

  it("falls back explicitly when no tokenizer runtime is configured", async () => {
    const result = await loadOptionalQwen3SentencePieceTokenizer({});

    expect(result.diagnostic.status).toBe("fallback");
    expect(result.diagnostic.reason).toBe("not-configured");
    expect(result.diagnostic.missingRuntimeDependency).toContain("KEIKO_QWEN3_TOKENIZER_MODULE");
    expect(result.tokenizer.identity).toBe(CONSERVATIVE_TOKENIZER_ID);
    expect(result.tokenizer.identity).not.toBe(QWEN3_SENTENCEPIECE_TOKENIZER_ID);
    expect(result.tokenizer.kind).toBe("estimator");
  });
});
