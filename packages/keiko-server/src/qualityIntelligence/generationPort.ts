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
import { QualityIntelligenceHardening } from "@oscharko-dev/keiko-quality-intelligence";
import type {
  QualityIntelligenceGenerationPort,
  QualityIntelligenceGenerationPortArgs,
  QualityIntelligenceGenerationPortResult,
} from "@oscharko-dev/keiko-workflows";
import type { UiHandlerDeps } from "../deps.js";

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

// Strip C0/C1 control characters (keep tab/LF/CR) via a code-point scan so the `no-control-regex`
// rule stays satisfied; then neutralise any literal evidence delimiter so untrusted text cannot
// close the <qi-evidence> block early.
function scrubEvidenceText(text: string): string {
  const normalised = text.normalize("NFKC");
  let out = "";
  for (const ch of normalised) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const isStrippable =
      (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      cp === 0x7f ||
      (cp >= 0x80 && cp <= 0x9f);
    if (!isStrippable) out += ch;
  }
  return out.replace(/<\/?qi-evidence/giu, "[evidence]");
}

function buildEvidenceBlocks(evidence: QualityIntelligenceGenerationPortArgs["evidence"]): string {
  return evidence
    .map((e) => {
      const kind = e.kind.replace(/[^a-z0-9-]/giu, "");
      return `<qi-evidence index="${String(e.index)}" kind="${kind}">\n${scrubEvidenceText(e.text)}\n</qi-evidence>`;
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
 * Build a generation port bound to one model id. Fails fast (before any model call) when the model
 * is not configured or its capability record does not satisfy the qi:test-design profile, so an
 * incompatible model never receives a payload (#279 AC).
 */
export function createQiGenerationPort(
  deps: UiHandlerDeps,
  modelId: string,
): QualityIntelligenceGenerationPort {
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
        "The selected model cannot generate structured test cases (needs a chat model with structured output).",
      );
    }
    throw error;
  }
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    throw new QiGenerationError("QI_MODEL_UNAVAILABLE", "The model gateway is not available.");
  }
  return {
    generate: async (
      args: QualityIntelligenceGenerationPortArgs,
    ): Promise<QualityIntelligenceGenerationPortResult> => {
      const messages = buildMessages(args);
      const signal = args.signal ?? new AbortController().signal;
      const request: GatewayRequest = { modelId, messages, stream: false };
      const response = await model.call(request, signal);
      return { rawText: response.content, modelCallCount: 1, modelId };
    },
  };
}
