// Deterministic fallback token estimator (Epic #189, Issue #195; WP4).
//
// LIMITATION: this is still an estimate, not a real Qwen3 tokenizer. There is no local
// SentencePiece/Qwen tokenizer dependency in this workspace, so the fallback is calibrated
// by script class instead of pretending that "4 chars = 1 token" is universal. It stays
// conservative for German compound words, CJK text, code identifiers, and symbol-heavy
// inputs so chunk and batch budgets fail small rather than silently overflowing a 32K
// embedding context. Callers can inject a real tokenizer through `LocalKnowledgeTokenizer`.

import {
  CONSERVATIVE_TOKENIZER_ID,
  QWEN3_SENTENCEPIECE_TOKENIZER_ID,
  type LocalKnowledgeTokenizer,
} from "./types.js";

const ASCII_WORD_CHARS_PER_TOKEN = 4;
const LONG_WORD_CHARS_PER_TOKEN = 3;
const NON_ASCII_LATIN_CHARS_PER_TOKEN = 2.4;
const DIGITS_PER_TOKEN = 2.5;
const SYMBOLS_PER_TOKEN = 1.5;
const WHITESPACE_PER_TOKEN = 24;
const CHUNK_BUDGET_CHARS_PER_TOKEN = 4;
const DEFAULT_QWEN3_TOKENIZER_MODULE_ENV = "KEIKO_QWEN3_TOKENIZER_MODULE";
const TOKENIZER_MODE_ENV = "KEIKO_LOCAL_KNOWLEDGE_TOKENIZER";
const TOKENIZER_REQUIRED_ENV = "KEIKO_QWEN3_TOKENIZER_REQUIRED";

const CJK_OR_KANA_OR_HANGUL_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_LETTER_PATTERN = /[A-Za-z]/u;
const DIGIT_PATTERN = /\p{N}/u;
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u;
const LETTER_PATTERN = /\p{L}/u;
const WHITESPACE_PATTERN = /\s/u;
const ASCII_WORD_PATTERN = /[A-Za-z]+/gu;

function countCodePoints(text: string, pattern: RegExp): number {
  let count = 0;
  for (const char of text) {
    if (pattern.test(char)) count += 1;
  }
  return count;
}

function longAsciiWordPenalty(text: string): number {
  let penalty = 0;
  for (const match of text.matchAll(ASCII_WORD_PATTERN)) {
    const word = match[0];
    if (word.length <= 12) continue;
    penalty +=
      Math.ceil(word.length / LONG_WORD_CHARS_PER_TOKEN) -
      Math.ceil(word.length / ASCII_WORD_CHARS_PER_TOKEN);
  }
  return Math.max(0, penalty);
}

// NOTE (GEN-DUP-SEMANTIC-002): intentionally NOT the canonical byte-based estimateTokens in
// @oscharko-dev/keiko-contracts. This is the embedding-context fallback for a real Qwen3/SentencePiece
// tokenizer (injectable via LocalKnowledgeTokenizer), script-class calibrated to fail small against a
// 32K embedding budget, so it must stay its own conservative unit rather than the prompt-token currency.
export function defaultTokenEstimator(text: string): number {
  if (text.length === 0) return 0;
  const cjk = countCodePoints(text, CJK_OR_KANA_OR_HANGUL_PATTERN);
  const asciiLetters = countCodePoints(text, ASCII_LETTER_PATTERN);
  const digits = countCodePoints(text, DIGIT_PATTERN);
  const latinLetters = countCodePoints(text, LATIN_LETTER_PATTERN);
  const letters = countCodePoints(text, LETTER_PATTERN);
  const whitespace = countCodePoints(text, WHITESPACE_PATTERN);
  const nonAsciiLatin = Math.max(0, latinLetters - asciiLetters);
  const nonLatinLetters = Math.max(0, letters - latinLetters - cjk);
  const symbols = Math.max(0, Array.from(text).length - letters - digits - whitespace);

  const estimate =
    cjk +
    Math.ceil(asciiLetters / ASCII_WORD_CHARS_PER_TOKEN) +
    longAsciiWordPenalty(text) +
    Math.ceil(nonAsciiLatin / NON_ASCII_LATIN_CHARS_PER_TOKEN) +
    Math.ceil(nonLatinLetters / NON_ASCII_LATIN_CHARS_PER_TOKEN) +
    Math.ceil(digits / DIGITS_PER_TOKEN) +
    Math.ceil(symbols / SYMBOLS_PER_TOKEN) +
    Math.ceil(whitespace / WHITESPACE_PER_TOKEN);
  return Math.max(1, estimate);
}

export const conservativeTokenEstimatorTokenizer: LocalKnowledgeTokenizer = {
  identity: CONSERVATIVE_TOKENIZER_ID,
  kind: "estimator",
  countTokens: defaultTokenEstimator,
};

// Upper-bound helper used by the chunker to pick an initial character window before it
// verifies the actual slice with `TokenEstimator`. This is not treated as authoritative.
export function charsForTokenBudget(tokenBudget: number): number {
  if (tokenBudget <= 0) return 0;
  return tokenBudget * CHUNK_BUDGET_CHARS_PER_TOKEN;
}

export type Qwen3TokenizerModule = unknown;

export interface Qwen3TokenizerFactoryOptions {
  readonly modelPath?: string;
}

export interface OptionalTokenizerLoadDiagnostic {
  readonly requested: "qwen3-sentencepiece";
  readonly status: "loaded" | "fallback";
  readonly reason?: string;
  readonly missingRuntimeDependency?: string;
}

export interface OptionalTokenizerLoadResult {
  readonly tokenizer: LocalKnowledgeTokenizer;
  readonly diagnostic: OptionalTokenizerLoadDiagnostic;
}

export class TokenizerLoadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TokenizerLoadError";
  }
}

function tokenIdsFromEncoded(encoded: unknown): readonly unknown[] | undefined {
  if (Array.isArray(encoded)) return encoded as readonly unknown[];
  if (encoded instanceof Uint32Array || encoded instanceof Int32Array) return Array.from(encoded);
  if (typeof encoded !== "object" || encoded === null) return undefined;
  const candidate = encoded as { readonly ids?: unknown; readonly inputIds?: unknown };
  if (Array.isArray(candidate.ids)) return candidate.ids as readonly unknown[];
  if (Array.isArray(candidate.inputIds)) return candidate.inputIds as readonly unknown[];
  return undefined;
}

function moduleIdentity(moduleLike: unknown): string {
  if (typeof moduleLike !== "object" || moduleLike === null)
    return QWEN3_SENTENCEPIECE_TOKENIZER_ID;
  const candidate = moduleLike as { readonly tokenizerIdentity?: unknown };
  return typeof candidate.tokenizerIdentity === "string" && candidate.tokenizerIdentity.length > 0
    ? candidate.tokenizerIdentity
    : QWEN3_SENTENCEPIECE_TOKENIZER_ID;
}

type EncoderFunction = (this: unknown, text: string) => unknown;
type TokenizerFactory = (options: Qwen3TokenizerFactoryOptions) => unknown;

function isEncoderFunction(value: unknown): value is EncoderFunction {
  return typeof value === "function";
}

function isTokenizerFactory(value: unknown): value is TokenizerFactory {
  return typeof value === "function";
}

function encoderFromCandidate(candidate: unknown): ((text: string) => unknown) | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const maybe = candidate as {
    readonly encode?: unknown;
    readonly tokenize?: unknown;
    readonly processor?: unknown;
  };
  if (isEncoderFunction(maybe.encode)) {
    const encode = maybe.encode;
    return (text: string) => encode.call(candidate, text);
  }
  if (isEncoderFunction(maybe.tokenize)) {
    const tokenize = maybe.tokenize;
    return (text: string) => tokenize.call(candidate, text);
  }
  return encoderFromCandidate(maybe.processor);
}

async function tokenizerCandidateFromModule(
  moduleLike: Qwen3TokenizerModule,
  options: Qwen3TokenizerFactoryOptions,
): Promise<unknown> {
  if (typeof moduleLike === "object" && moduleLike !== null) {
    const candidate = moduleLike as {
      readonly createTokenizer?: unknown;
      readonly default?: unknown;
    };
    if (isTokenizerFactory(candidate.createTokenizer)) {
      return await candidate.createTokenizer(options);
    }
    if (candidate.default !== undefined) {
      const defaultExport = candidate.default;
      if (typeof defaultExport === "object" && defaultExport !== null) {
        const defaultFactory = defaultExport as { readonly createTokenizer?: unknown };
        if (isTokenizerFactory(defaultFactory.createTokenizer)) {
          return await defaultFactory.createTokenizer(options);
        }
      }
      return defaultExport;
    }
  }
  return moduleLike;
}

export async function createQwen3SentencePieceTokenizerFromModule(
  moduleLike: Qwen3TokenizerModule,
  options: Qwen3TokenizerFactoryOptions = {},
): Promise<LocalKnowledgeTokenizer> {
  const candidate = await tokenizerCandidateFromModule(moduleLike, options);
  const encode = encoderFromCandidate(candidate) ?? encoderFromCandidate(moduleLike);
  if (encode === undefined) {
    throw new TokenizerLoadError(
      "Qwen3 tokenizer module must expose encode(text), tokenize(text), or createTokenizer().",
    );
  }
  return {
    identity: moduleIdentity(candidate),
    kind: "tokenizer",
    countTokens: (text: string): number => {
      const ids = tokenIdsFromEncoded(encode(text));
      if (ids === undefined) {
        throw new TokenizerLoadError("Qwen3 tokenizer encode result did not contain token ids.");
      }
      return ids.length;
    },
  };
}

type ImportModule = (specifier: string) => Promise<unknown>;

function defaultImportModule(specifier: string): Promise<unknown> {
  return import(specifier) as Promise<unknown>;
}

function fallbackDiagnostic(reason: string): OptionalTokenizerLoadResult {
  return {
    tokenizer: conservativeTokenEstimatorTokenizer,
    diagnostic: {
      requested: "qwen3-sentencepiece",
      status: "fallback",
      reason,
      missingRuntimeDependency:
        "Provide a server-side Qwen3/SentencePiece tokenizer module and set KEIKO_QWEN3_TOKENIZER_MODULE.",
    },
  };
}

function envEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[TOKENIZER_MODE_ENV] === "qwen3-sentencepiece";
}

function envRequired(env: NodeJS.ProcessEnv): boolean {
  return env[TOKENIZER_REQUIRED_ENV] === "1" || env[TOKENIZER_REQUIRED_ENV] === "true";
}

function missingSpecifierResult(required: boolean): OptionalTokenizerLoadResult {
  const message = `${DEFAULT_QWEN3_TOKENIZER_MODULE_ENV} is required for qwen3-sentencepiece tokenization.`;
  if (required) throw new TokenizerLoadError(message);
  return fallbackDiagnostic("missing-module-specifier");
}

function loadFailureResult(required: boolean, cause: unknown): OptionalTokenizerLoadResult {
  const message = cause instanceof Error ? cause.message : "unknown tokenizer load error";
  if (required) throw new TokenizerLoadError(message);
  return fallbackDiagnostic(`load-failed:${message}`);
}

function factoryOptionsFromEnv(env: NodeJS.ProcessEnv): Qwen3TokenizerFactoryOptions {
  const modelPath = env.KEIKO_QWEN3_TOKENIZER_MODEL;
  return modelPath === undefined ? {} : { modelPath };
}

export async function loadOptionalQwen3SentencePieceTokenizer(
  env: NodeJS.ProcessEnv = process.env,
  importModule: ImportModule = defaultImportModule,
): Promise<OptionalTokenizerLoadResult> {
  if (!envEnabled(env)) return fallbackDiagnostic("not-configured");
  const specifier = env[DEFAULT_QWEN3_TOKENIZER_MODULE_ENV];
  const required = envRequired(env);
  if (specifier === undefined || specifier.trim().length === 0) {
    return missingSpecifierResult(required);
  }
  try {
    const moduleLike = await importModule(specifier);
    const tokenizer = await createQwen3SentencePieceTokenizerFromModule(
      moduleLike,
      factoryOptionsFromEnv(env),
    );
    return {
      tokenizer,
      diagnostic: { requested: "qwen3-sentencepiece", status: "loaded" },
    };
  } catch (cause) {
    return loadFailureResult(required, cause);
  }
}
