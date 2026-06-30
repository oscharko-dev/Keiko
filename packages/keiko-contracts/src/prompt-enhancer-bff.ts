// Prompt Enhancer BFF wire contracts (Epic #1307, Issue #1314; governed by ADR-0044 §1 row "BFF
// /api/prompt-enhancer/* routes"). These shapes travel over the HTTP wire between the keiko-server
// BFF and the React UI / CLI surfaces, exactly like the entity wire types in `bff-wire.ts`.
//
// Scope discipline. #1314 exposes the Prompt Enhancer core (#1309 – #1313) through a governed API,
// CLI, and UI. This module therefore adds ONLY the request/response envelope and a pure request
// validator. The response composes content-light, provider-neutral artefacts produced by the pipeline
// (`PromptTaskAnalysis`, `EnhancedPrompt`, `PromptCandidateScorecard`, `PromptSafetyAssessment`) and
// adds a Model-Gateway routing descriptor (AC3). The optional model id is now an enhancement-model
// request: deterministic-only remains supported by omitting it.
//
// Trust boundary (ADR-0044 §5). Like every prompt-enhancer contract, these shapes carry no provider
// credential, hidden system prompt, or tool/secret/egress/patch authority grant. The wire request is
// the untrusted user draft plus bounded, validated metadata; the server mints the branded ids and runs
// the deterministic pipeline. Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*`
// import; same-package relative imports only.

import { stripUnsafeFormatChars } from "./text-safety.js";
import type { CostClass } from "./gateway.js";
import {
  type EnhancedPrompt,
  type MissingInformationStrategy,
  type PromptEnhancementProfileId,
  type PromptTaskAnalysis,
  MISSING_INFORMATION_STRATEGIES,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
} from "./prompt-enhancer.js";
import type {
  PromptCandidateRejection,
  PromptCandidateScorecard,
} from "./prompt-enhancer-critic.js";
import type { PromptSafetyAssessment } from "./prompt-enhancer-safety.js";
import {
  type PromptEnhancerValidation,
  PROMPT_REQUEST_TEXT_MAX_CHARS,
} from "./prompt-enhancer-validation.js";

// ─── Bounds ──────────────────────────────────────────────────────────────────────
// A BCP-47-ish locale tag is informational only; bound it to the same ceiling the domain validator
// uses. The candidate-count ceiling mirrors the profile-slate size (one candidate per profile); the
// server additionally clamps to the gateway's own `MAX_CANDIDATE_COUNT` so the wire never widens the
// optimization envelope.
export const PROMPT_ENHANCEMENT_LOCALE_MAX_CHARS = 35 as const;
export const PROMPT_ENHANCEMENT_MODEL_ID_MAX_CHARS = 200 as const;
export const PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT = 3 as const;
export const PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT = 7 as const;

// ─── Request ───────────────────────────────────────────────────────────────────────
// The browser/CLI-facing request. Deliberately free of branded ids and `schemaVersion`: the server
// mints the `PromptEnhancementRequestId` and `EnhancedPromptId` and stamps the schema version so a
// client can never forge an id or a path-traversal fragment.
export interface PromptEnhancementWireRequest {
  // The raw, untrusted user draft. Bounded and validated as safe text; never interpolated into a
  // trusted instruction channel by the pipeline.
  readonly text: string;
  // Optional caller hint; the analyzer still recommends a profile deterministically and the server
  // records both. Safety criticality can still escalate the selected profile (#1310).
  readonly profilePreference?: PromptEnhancementProfileId;
  // How missing information is represented (AC1 of the issue): surface clarification questions, or
  // proceed with explicit stated assumptions. Defaults to "clarify" server-side when omitted.
  readonly missingInformationStrategy?: MissingInformationStrategy;
  // True when the user explicitly connected workspace scope, files, or attachments to the request.
  readonly hasConnectedContext?: boolean;
  // Count of attached references, if any. Bounded metadata only; never the attachment content.
  readonly attachmentCount?: number;
  // Informational BCP-47-ish locale tag, validated as bounded safe text when present.
  readonly locale?: string;
  // Optional chat model the caller wants Keiko to use for model-assisted prompt refinement. When
  // omitted, enhancement is deterministic-only. The server resolves this through the Model Gateway
  // (AC3) and falls back to deterministic output when the model cannot be used safely.
  readonly modelId?: string;
  // Optional number of distinct candidate variants to generate and score. Clamped to
  // [1, PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT] and to the gateway bound server-side.
  readonly candidateCount?: number;
}

// ─── Model-Gateway routing descriptor (AC3) ─────────────────────────────────────────
// This descriptor records both capability resolution and whether the selected model actually refined
// the prompt. "not-requested" means deterministic-only; "available" means the gateway resolved a
// configured chat model; "unavailable" means no model could be used and enhancement completed via the
// deterministic fallback. `reason` and `fallbackReason` are fixed, content-free labels safe to display.
export type PromptEnhancementModelAvailability = "available" | "unavailable" | "not-requested";

export const PROMPT_ENHANCEMENT_MODEL_AVAILABILITIES: readonly PromptEnhancementModelAvailability[] =
  ["available", "unavailable", "not-requested"] as const;

export type PromptEnhancementModelRoutingReason =
  | "no-model-requested"
  | "model-available"
  | "no-gateway-config"
  | "model-not-configured"
  | "model-not-chat-capable"
  | "model-port-unavailable";

export type PromptEnhancementExecutionStatus = "deterministic" | "model-applied" | "model-fallback";

export type PromptEnhancementModelFallbackReason =
  | "model-port-unavailable"
  | "model-call-failed"
  | "model-empty-response"
  | "model-invalid-json"
  | "model-invalid-prompt"
  | "model-no-change"
  | "model-unsafe-prompt";

export interface PromptEnhancementModelRouting {
  readonly availability: PromptEnhancementModelAvailability;
  readonly reason: PromptEnhancementModelRoutingReason;
  // The model id the caller asked the server to check, echoed back when present (validated safe text).
  readonly requestedModelId?: string;
  // The model id the gateway resolved as the dispatch target, present only when available.
  readonly resolvedModelId?: string;
  // The resolved model's provider-neutral cost class, present only when available.
  readonly costClass?: CostClass;
  // Whether the returned prompt was deterministic-only, model-refined, or deterministic fallback after
  // a selected model failed validation/execution. Present on new responses; older manifests may omit it.
  readonly executionStatus?: PromptEnhancementExecutionStatus;
  // Content-free fallback reason when `executionStatus` is "model-fallback".
  readonly fallbackReason?: PromptEnhancementModelFallbackReason;
}

// ─── Candidate comparison ────────────────────────────────────────────────────────────
// The transparent, ranked scorecards for the generated candidates plus the auditable rejections. The
// winning candidate's full Enhanced Prompt is surfaced as the response `enhancedPrompt`; this section
// lets the surface render the scorecard comparison (AC2 "candidate scorecards").
export interface PromptEnhancementCandidateComparison {
  // The `candidateId` of the winning scorecard (== response `enhancedPrompt`'s candidate). Content-free.
  readonly winnerCandidateId: string;
  // Every scored candidate in deterministic rank order, winner first.
  readonly scorecards: readonly PromptCandidateScorecard[];
  // Candidates dropped before or during scoring, each with its content-free reason.
  readonly rejected: readonly PromptCandidateRejection[];
}

// ─── Grounding readiness ───────────────────────────────────────────────────────────
// Content-free readiness binding for the grounding plan. It never carries source excerpts or private
// context, only whether the server saw concrete connected-context metadata for a prompt whose plan
// requires grounding.
export type PromptEnhancementGroundingReadinessStatus = "not-required" | "ready" | "unavailable";

export type PromptEnhancementGroundingReadinessReason =
  | "no-grounding-required"
  | "connected-context-present"
  | "missing-concrete-scope";

export interface PromptEnhancementGroundingReadiness {
  readonly status: PromptEnhancementGroundingReadinessStatus;
  readonly reason: PromptEnhancementGroundingReadinessReason;
  readonly notice?: string;
}

// ─── Evidence reference ────────────────────────────────────────────────────────────
// A browser-safe pointer to the persisted Prompt Enhancement evidence manifest. The manifest itself is
// served through the PE-specific evidence route; this reference carries only ids, schema/version, and
// integrity metadata.
export type PromptEnhancementEvidenceReferenceStatus = "recorded" | "not-recorded";
export type PromptEnhancementEvidenceReferenceReason =
  | "evidence-recorded"
  | "evidence-store-not-configured";

export interface PromptEnhancementEvidenceReference {
  readonly status: PromptEnhancementEvidenceReferenceStatus;
  readonly reason: PromptEnhancementEvidenceReferenceReason;
  readonly runId?: string;
  readonly manifestUrl?: string;
  readonly manifestLocation?: string;
  readonly peEvidenceSchemaVersion?: number;
  readonly recordIntegritySha256?: string;
}

// ─── Response ─────────────────────────────────────────────────────────────────────────
// The full governed enhancement result. `renderedPrompt` is the deterministic text projection of
// `enhancedPrompt` for copy / export; the selected prompt still contains the user's draft in the
// untrusted input section so boundary callers must redact before exposing or persisting it.
// `inputFingerprintSha256` is a stable, content-derived audit anchor (a hash of the normalized draft),
// not the draft itself and not an anonymous identifier for low-entropy inputs. The result is data for
// review, never an execution trigger (AC5).
export interface PromptEnhancementWireResponse {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  // The branded EnhancedPromptId of the winning prompt, as a plain wire string.
  readonly promptId: string;
  // Content-free SHA-256 fingerprint of the normalized input draft; a stable audit anchor.
  readonly inputFingerprintSha256: string;
  // The deterministic, content-light task analysis (task class, domain, criticality, grounding need,
  // risk flags, recommended profile, and the detectors that fired).
  readonly analysis: PromptTaskAnalysis;
  // The winning structured Enhanced Prompt: role, goal, context, input, steps, constraints, grounding
  // rules + plan, output schema, quality criteria, uncertainty handling, and safety rules.
  readonly enhancedPrompt: EnhancedPrompt;
  // Deterministic single-string rendering of `enhancedPrompt` for copy / export.
  readonly renderedPrompt: string;
  // Ranked candidate scorecards + rejections for the candidate-comparison view.
  readonly candidates: PromptEnhancementCandidateComparison;
  // The deterministic safety assessment: decision, human-review flag, verification status, findings,
  // and least-privilege constraints the surface must display (AC2 "safety rules", AC5 reviewability).
  readonly safety: PromptSafetyAssessment;
  // The Model-Gateway routing descriptor for optional model-assisted enhancement (AC3).
  readonly modelRouting: PromptEnhancementModelRouting;
  // Content-free readiness state for required grounding against connected-context metadata.
  readonly groundingReadiness: PromptEnhancementGroundingReadiness;
  // Content-free pointer to persisted audit evidence when a BFF or CLI surface records it.
  readonly evidence: PromptEnhancementEvidenceReference;
}

// ─── Pure request validator ────────────────────────────────────────────────────────────
// Mirrors the discriminated-result discipline of `prompt-enhancer-validation.ts`: pure, never throws,
// one short machine-readable error per failed invariant, never echoes raw input.
const WIRE_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "text",
  "profilePreference",
  "missingInformationStrategy",
  "hasConnectedContext",
  "attachmentCount",
  "locale",
  "modelId",
  "candidateCount",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMember = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isBoundedSafeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && stripUnsafeFormatChars(value) === value;

// One field check. Pushes a content-free error message when its field is present and invalid. Kept
// individually small so the aggregate validator stays well under the cyclomatic-complexity bound.
type WireFieldValidator = (input: Record<string, unknown>, errors: string[]) => void;

const validateUnknownFields: WireFieldValidator = (input, errors) => {
  if (Object.keys(input).some((key) => !WIRE_REQUEST_KEYS.has(key))) {
    errors.push("request must not contain unknown fields");
  }
};

const validateTextField: WireFieldValidator = (input, errors) => {
  if (typeof input.text !== "string") {
    errors.push("request.text must be a string");
  } else if (input.text.trim().length === 0) {
    errors.push("request.text must not be empty or whitespace-only");
  } else if (input.text.length > PROMPT_REQUEST_TEXT_MAX_CHARS) {
    errors.push(`request.text must be at most ${String(PROMPT_REQUEST_TEXT_MAX_CHARS)} characters`);
  }
};

const validateProfileField: WireFieldValidator = (input, errors) => {
  if (
    input.profilePreference !== undefined &&
    !isMember(input.profilePreference, PROMPT_ENHANCEMENT_PROFILE_IDS)
  ) {
    errors.push("request.profilePreference must be a known profile id when set");
  }
};

const validateStrategyField: WireFieldValidator = (input, errors) => {
  if (
    input.missingInformationStrategy !== undefined &&
    !isMember(input.missingInformationStrategy, MISSING_INFORMATION_STRATEGIES)
  ) {
    errors.push("request.missingInformationStrategy must be a known strategy when set");
  }
};

const validateConnectedContextField: WireFieldValidator = (input, errors) => {
  if (input.hasConnectedContext !== undefined && typeof input.hasConnectedContext !== "boolean") {
    errors.push("request.hasConnectedContext must be a boolean when set");
  }
};

const validateAttachmentCountField: WireFieldValidator = (input, errors) => {
  if (input.attachmentCount !== undefined && !isNonNegativeInteger(input.attachmentCount)) {
    errors.push("request.attachmentCount must be a non-negative integer when set");
  }
};

const validateLocaleField: WireFieldValidator = (input, errors) => {
  if (
    input.locale !== undefined &&
    !isBoundedSafeText(input.locale, PROMPT_ENHANCEMENT_LOCALE_MAX_CHARS)
  ) {
    errors.push(
      `request.locale must be safe text of at most ${String(PROMPT_ENHANCEMENT_LOCALE_MAX_CHARS)} characters when set`,
    );
  }
};

const validateModelIdField: WireFieldValidator = (input, errors) => {
  if (
    input.modelId !== undefined &&
    (!isBoundedSafeText(input.modelId, PROMPT_ENHANCEMENT_MODEL_ID_MAX_CHARS) ||
      input.modelId.trim().length === 0)
  ) {
    errors.push(
      `request.modelId must be non-empty safe text of at most ${String(PROMPT_ENHANCEMENT_MODEL_ID_MAX_CHARS)} characters when set`,
    );
  }
};

const validateCandidateCountField: WireFieldValidator = (input, errors) => {
  const value = input.candidateCount;
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT)
  ) {
    errors.push(
      `request.candidateCount must be an integer in [1, ${String(PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT)}] when set`,
    );
  }
};

const WIRE_FIELD_VALIDATORS: readonly WireFieldValidator[] = [
  validateUnknownFields,
  validateTextField,
  validateProfileField,
  validateStrategyField,
  validateConnectedContextField,
  validateAttachmentCountField,
  validateLocaleField,
  validateModelIdField,
  validateCandidateCountField,
];

// Assemble the validated wire request, omitting absent optionals so exactOptionalPropertyTypes holds.
function buildWireRequestValue(input: Record<string, unknown>): PromptEnhancementWireRequest {
  return {
    text: input.text as string,
    ...(input.profilePreference === undefined
      ? {}
      : { profilePreference: input.profilePreference as PromptEnhancementProfileId }),
    ...(input.missingInformationStrategy === undefined
      ? {}
      : {
          missingInformationStrategy:
            input.missingInformationStrategy as MissingInformationStrategy,
        }),
    ...(input.hasConnectedContext === undefined
      ? {}
      : { hasConnectedContext: input.hasConnectedContext as boolean }),
    ...(input.attachmentCount === undefined
      ? {}
      : { attachmentCount: input.attachmentCount as number }),
    ...(input.locale === undefined ? {} : { locale: input.locale as string }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId as string }),
    ...(input.candidateCount === undefined
      ? {}
      : { candidateCount: input.candidateCount as number }),
  };
}

export function validatePromptEnhancementWireRequest(
  input: unknown,
): PromptEnhancerValidation<PromptEnhancementWireRequest> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors: string[] = [];
  for (const validate of WIRE_FIELD_VALIDATORS) {
    validate(input, errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: buildWireRequestValue(input) };
}
