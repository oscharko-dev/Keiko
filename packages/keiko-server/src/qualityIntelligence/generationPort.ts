// Quality Intelligence generation port (Epic #270, Issue #279).
//
// Backs the abstract `QualityIntelligenceGenerationPort` (consumed by the model-routed workflow run
// entry) with the REAL Keiko Model Gateway via `deps.modelPortFactory` — the same seam the
// Conversation Center / grounded-QA path uses. Applies the #279 capability gate before any request
// is built (unsupported models fail before a network call), assembles trusted system + instruction
// segments separately from `<qi-evidence>`-delimited untrusted source text, and scrubs evidence so
// it cannot break the delimiter or smuggle control characters (Issue #284). No provider SDK import.

import {
  QualityIntelligence as MgQI,
  findCapability,
  findConfiguredCapability,
  QualityIntelligenceSafeErrorException,
  type ChatMessage,
  type GatewayRequest,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import {
  QualityIntelligenceHardening,
  QualityIntelligenceGeneration,
} from "@oscharko-dev/keiko-quality-intelligence";
import type {
  QualityIntelligenceGenerationPort,
  QualityIntelligenceGenerationPortArgs,
  QualityIntelligenceGenerationPortResult,
} from "@oscharko-dev/keiko-workflows";
import type { UiHandlerDeps } from "../deps.js";

const BASELINE_GENERATION_OUTPUT = JSON.stringify({ testCases: [] });

export class QiGenerationError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "QiGenerationError";
  }
}

function capabilityFor(deps: UiHandlerDeps, modelId: string): ModelCapability | undefined {
  return deps.config === undefined
    ? findCapability(modelId)
    : findConfiguredCapability(deps.config, modelId);
}

// Invisible / directional format controls that NFKC does NOT remove: zero-width characters
// (ZWSP/ZWNJ/ZWJ and the BOM/ZWNBSP) and bidirectional controls (LRM/RLM, the LRE…RLO embedding/
// override block, and the isolate block). They carry no legitimate meaning in untrusted source
// evidence but can smuggle homoglyph/bidi deception into the model prompt — and into any candidate
// rendered or exported from it. Stripping them is content-preserving for real text (#278 Audit
// Addendum: normalise untrusted content before model prompt construction, rendering, or export).
function isInvisibleFormatControl(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP, ZWNJ, ZWJ, LRM, RLM
    (cp >= 0x202a && cp <= 0x202e) || // LRE, RLE, PDF, LRO, RLO
    (cp >= 0x2066 && cp <= 0x2069) || // LRI, RLI, FSI, PDI
    cp === 0xfeff // BOM / ZWNBSP
  );
}

// A code point that must be stripped from evidence text: C0 controls (except tab/LF/CR), DEL, C1
// controls, or an invisible zero-width/bidi format control. Tab/LF/CR survive as legitimate text
// whitespace so multi-line evidence keeps its structure.
function isStrippableEvidenceCodePoint(cp: number): boolean {
  return (
    (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    cp === 0x7f ||
    (cp >= 0x80 && cp <= 0x9f) ||
    isInvisibleFormatControl(cp)
  );
}

// Strip control / invisible format characters via a code-point scan so the `no-control-regex` rule
// stays satisfied; then neutralise any literal evidence delimiter so untrusted text cannot close the
// <qi-evidence> block early.
function scrubEvidenceText(text: string): string {
  const normalised = text.normalize("NFKC");
  let out = "";
  for (const ch of normalised) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (!isStrippableEvidenceCodePoint(cp)) out += ch;
  }
  return out.replace(/<\/?qi-evidence/giu, "[evidence]");
}

// Second line of defence behind the structural fence (Issue #284 AC1: "Untrusted content cannot
// override system or workflow instructions"). After scrubbing, run the natural-language
// prompt-injection scanner on each evidence block: a detected imperative ("ignore previous
// instructions", a `system:` role line, a jailbreak token, …) is NOT silently passed through — the
// block is tagged with the matched pattern names so the model sees the evidence is suspect (it is
// already DATA, never instructions, per the system prompt). Non-blocking by design: a requirement
// that legitimately quotes such a phrase must still produce a run, so detection annotates the block
// rather than failing the run. The pattern names are corpus slugs (`[a-z-]`), inert in an attribute.
function buildEvidenceBlocks(evidence: QualityIntelligenceGenerationPortArgs["evidence"]): string {
  return evidence
    .map((e) => {
      const kind = e.kind.replace(/[^a-z0-9-]/giu, "");
      const scrubbed = scrubEvidenceText(e.text);
      const scan = QualityIntelligenceHardening.scanForPromptInjections(scrubbed);
      const flagged = scan.safe ? "" : ` flagged="prompt-injection:${scan.injections.join(",")}"`;
      return `<qi-evidence index="${String(e.index)}" kind="${kind}"${flagged}>\n${scrubbed}\n</qi-evidence>`;
    })
    .join("\n");
}

function buildMessages(args: QualityIntelligenceGenerationPortArgs): readonly ChatMessage[] {
  const blocks = buildEvidenceBlocks(args.evidence);
  const userContent = `${args.instruction}\n\n${blocks}`;
  const size = QualityIntelligenceHardening.assertPromptSize(userContent);
  if (!size.ok) {
    throw new QiGenerationError(
      "QI_PROMPT_TOO_LARGE",
      "The assembled prompt exceeds the model token budget; reduce the source size.",
    );
  }
  return Object.freeze([
    Object.freeze<ChatMessage>({ role: "system", content: args.systemPrompt }),
    Object.freeze<ChatMessage>({ role: "user", content: userContent }),
  ]);
}

/**
 * Build a generation port bound either to one model id or to the deterministic no-model baseline.
 * Model targets fail fast (before any model call) when the model is not configured or its
 * capability record does not satisfy the qi:test-design profile, so an incompatible model never
 * receives a payload (#279 AC).
 */
interface ResolvedGenerationModel {
  readonly model: NonNullable<ReturnType<UiHandlerDeps["modelPortFactory"]>>;
  readonly modelId: string;
  readonly useResponseFormat: boolean;
  readonly useSeed: boolean;
  readonly requestedSeed: number | undefined;
}

export type QiGenerationTarget =
  | string
  | { readonly kind: "baseline" }
  | {
      readonly kind: "model";
      readonly modelId: string;
      readonly requestedSeed?: number | undefined;
    };

/** Apply the qi:test-design capability gate and resolve the model port (Epic #761 / #279). */
function resolveGenerationModel(
  deps: UiHandlerDeps,
  target: Extract<QiGenerationTarget, { readonly kind: "model" }>,
): ResolvedGenerationModel {
  const { modelId } = target;
  const capability = capabilityFor(deps, modelId);
  if (capability === undefined) {
    throw new QiGenerationError("QI_MODEL_NOT_CONFIGURED", "The selected model is not configured.");
  }
  const profile = MgQI.getQualityIntelligenceTaskProfile("qi:test-design");
  try {
    MgQI.assertProfileCompatibleWithModel(profile, capability);
  } catch (error) {
    if (error instanceof QualityIntelligenceSafeErrorException) {
      throw new QiGenerationError(
        "QI_MODEL_INCOMPATIBLE",
        "The selected model cannot generate test cases because it is not a compatible chat model.",
      );
    }
    throw error;
  }
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    throw new QiGenerationError("QI_MODEL_UNAVAILABLE", "The model gateway is not available.");
  }
  return {
    model,
    modelId,
    useResponseFormat: capability.supportsResponseFormat === true,
    useSeed: capability.supportsSeeding === true && target.requestedSeed !== undefined,
    requestedSeed: target.requestedSeed,
  };
}

function normalizeTarget(target: QiGenerationTarget): Exclude<QiGenerationTarget, string> {
  if (typeof target === "string") {
    return { kind: "model", modelId: target };
  }
  return target;
}

function createBaselineGenerationPort(): QualityIntelligenceGenerationPort {
  return {
    generate: (): Promise<QualityIntelligenceGenerationPortResult> =>
      Promise.resolve({
        rawText: BASELINE_GENERATION_OUTPUT,
        modelCallCount: 0,
      }),
  };
}

function buildGenerationRequest(
  modelId: string,
  messages: readonly ChatMessage[],
  useResponseFormat: boolean,
  useSeed: boolean,
  requestedSeed: number | undefined,
): GatewayRequest {
  return {
    modelId,
    messages,
    stream: false,
    ...(useSeed && requestedSeed !== undefined ? { seed: requestedSeed } : {}),
    ...(useResponseFormat
      ? {
          responseFormat: {
            type: "json_schema",
            schema: { ...QualityIntelligenceGeneration.QI_TEST_DESIGN_RESPONSE_SCHEMA },
          },
        }
      : {}),
  };
}

function buildModelParameters(
  useResponseFormat: boolean,
  useSeed: boolean,
  requestedSeed: number | undefined,
): Record<string, unknown> | undefined {
  const modelParameters: Record<string, unknown> = {};
  if (useResponseFormat) modelParameters.responseFormat = "json_schema";
  if (useSeed && requestedSeed !== undefined) modelParameters.seed = requestedSeed;
  return Object.keys(modelParameters).length > 0 ? modelParameters : undefined;
}

function createModelGenerationPort(
  resolved: ResolvedGenerationModel,
): QualityIntelligenceGenerationPort {
  const { model, modelId, useResponseFormat, useSeed, requestedSeed } = resolved;
  return {
    generate: async (
      args: QualityIntelligenceGenerationPortArgs,
    ): Promise<QualityIntelligenceGenerationPortResult> => {
      const messages = buildMessages(args);
      const signal = args.signal ?? new AbortController().signal;
      const request = buildGenerationRequest(
        modelId,
        messages,
        useResponseFormat,
        useSeed,
        requestedSeed,
      );
      const response = await model.call(request, signal);
      const modelParameters = buildModelParameters(useResponseFormat, useSeed, requestedSeed);
      return {
        rawText: response.content,
        modelCallCount: 1,
        modelId,
        seedUsed: useSeed && requestedSeed !== undefined ? requestedSeed : null,
        ...(modelParameters !== undefined ? { modelParameters } : {}),
      };
    },
  };
}

export function createQiGenerationPort(
  deps: UiHandlerDeps,
  target: QiGenerationTarget,
): QualityIntelligenceGenerationPort {
  const normalized = normalizeTarget(target);
  if (normalized.kind === "baseline") {
    return createBaselineGenerationPort();
  }
  return createModelGenerationPort(resolveGenerationModel(deps, normalized));
}
