// Product OCR adapter for self-hosted/local Tesseract CLI.
//
// This adapter intentionally adds no native Node dependency and does not import process/egress
// primitives. Operators must opt in via env; the server runtime injects the local `tesseract`
// command runner. It handles images/rasterized page bytes; image-only PDF page OCR still requires
// a rasterizer upstream of this adapter.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

import { nullOcrAdapter } from "./null-ocr-adapter.js";
import type { OcrAdapter, OcrPageResult } from "./types.js";

export const LOCAL_KNOWLEDGE_OCR_ENGINE_ENV = "KEIKO_LOCAL_KNOWLEDGE_OCR_ENGINE";
export const LOCAL_KNOWLEDGE_OCR_TESSERACT_BIN_ENV =
  "KEIKO_LOCAL_KNOWLEDGE_OCR_TESSERACT_BIN";
export const LOCAL_KNOWLEDGE_OCR_LANG_ENV = "KEIKO_LOCAL_KNOWLEDGE_OCR_LANG";
export const LOCAL_KNOWLEDGE_OCR_TIMEOUT_MS_ENV = "KEIKO_LOCAL_KNOWLEDGE_OCR_TIMEOUT_MS";
export const LOCAL_KNOWLEDGE_OCR_MAX_BYTES_ENV = "KEIKO_LOCAL_KNOWLEDGE_OCR_MAX_BYTES";

const DEFAULT_TESSERACT_COMMAND = "tesseract";
const DEFAULT_TESSERACT_LANG = "eng";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024;

export interface TesseractCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: Uint8Array;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type TesseractCommandResult =
  | { readonly ok: true; readonly stdout: Uint8Array }
  | { readonly ok: false; readonly reason: "timeout" | "unsupported-input" | "engine-error" };

export type TesseractCommandRunner = (
  request: TesseractCommandRequest,
) => Promise<TesseractCommandResult>;

export interface TesseractOcrAdapterOptions {
  readonly command?: string;
  readonly language?: string;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly extraArgs?: readonly string[];
  readonly runner?: TesseractCommandRunner;
}

export type OcrRuntimeEngine = "none" | "tesseract" | "unsupported";

export interface OcrRuntimeResolution {
  readonly adapter: OcrAdapter;
  readonly engine: OcrRuntimeEngine;
  readonly configured: boolean;
}

function positiveInteger(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.floor(raw));
}

function envText(env: EnvSource, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function envInteger(env: EnvSource, key: string, fallback: number): number {
  const raw = envText(env, key);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return positiveInteger(value, fallback);
}

function ocrDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return ["0", "false", "off", "none", "disabled"].includes(raw.toLowerCase());
}

function tesseractArgs(language: string | undefined, extraArgs: readonly string[]): readonly string[] {
  const args = ["stdin", "stdout"];
  if (language !== undefined && language.length > 0) args.push("-l", language);
  args.push(...extraArgs);
  return args;
}

function tesseractText(stdout: Uint8Array): string {
  return Buffer.from(stdout).toString("utf8").replaceAll("\f", "").trim();
}

function missingTesseractCommandRunner(): Promise<TesseractCommandResult> {
  return Promise.resolve({ ok: false, reason: "engine-error" });
}

function commandResultToOcr(result: TesseractCommandResult): OcrPageResult {
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, text: tesseractText(result.stdout), confidence: 0 };
}

async function runTesseract(
  runner: TesseractCommandRunner,
  request: TesseractCommandRequest,
): Promise<TesseractCommandResult> {
  try {
    return await runner(request);
  } catch {
    return { ok: false, reason: "engine-error" };
  }
}

export function createTesseractOcrAdapter(options: TesseractOcrAdapterOptions = {}): OcrAdapter {
  const command = options.command ?? DEFAULT_TESSERACT_COMMAND;
  const language = options.language ?? DEFAULT_TESSERACT_LANG;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxInputBytes = positiveInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES);
  const runner = options.runner ?? missingTesseractCommandRunner;
  const args = tesseractArgs(language, options.extraArgs ?? []);
  return Object.freeze({
    kind: "ocr" as const,
    ocrPage: async (input: {
      readonly bytes: Uint8Array;
      readonly pageNumber: number;
      readonly signal?: AbortSignal;
    }): Promise<OcrPageResult> => {
      if (input.bytes.byteLength === 0) return { ok: false, reason: "unsupported-input" };
      if (input.bytes.byteLength > maxInputBytes) return { ok: false, reason: "unsupported-input" };
      const result = await runTesseract(runner, {
        command,
        args,
        stdin: input.bytes,
        timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return commandResultToOcr(result);
    },
  });
}

function misconfiguredOcrAdapter(): OcrAdapter {
  return Object.freeze({
    kind: "ocr" as const,
    ocrPage: (): Promise<OcrPageResult> =>
      Promise.resolve({ ok: false, reason: "engine-error" }),
  });
}

export function resolveOcrRuntimeFromEnv(
  env: EnvSource,
  options: Pick<TesseractOcrAdapterOptions, "runner"> = {},
): OcrRuntimeResolution {
  const engine = envText(env, LOCAL_KNOWLEDGE_OCR_ENGINE_ENV);
  if (ocrDisabled(engine)) return { adapter: nullOcrAdapter, engine: "none", configured: false };
  if (engine?.toLowerCase() !== "tesseract") {
    return { adapter: misconfiguredOcrAdapter(), engine: "unsupported", configured: true };
  }
  const command = envText(env, LOCAL_KNOWLEDGE_OCR_TESSERACT_BIN_ENV);
  const language = envText(env, LOCAL_KNOWLEDGE_OCR_LANG_ENV);
  return {
    adapter: createTesseractOcrAdapter({
      timeoutMs: envInteger(env, LOCAL_KNOWLEDGE_OCR_TIMEOUT_MS_ENV, DEFAULT_TIMEOUT_MS),
      maxInputBytes: envInteger(env, LOCAL_KNOWLEDGE_OCR_MAX_BYTES_ENV, DEFAULT_MAX_INPUT_BYTES),
      ...(command === undefined ? {} : { command }),
      ...(language === undefined ? {} : { language }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    }),
    engine: "tesseract",
    configured: true,
  };
}

export function createOcrAdapterFromEnv(
  env: EnvSource,
  options: Pick<TesseractOcrAdapterOptions, "runner"> = {},
): OcrAdapter {
  return resolveOcrRuntimeFromEnv(env, options).adapter;
}
