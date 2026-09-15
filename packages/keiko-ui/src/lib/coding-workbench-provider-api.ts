"use client";

/**
 * Coding Workbench provider profile API — the three BFF calls the workbench uses to
 * decide which model provider to run against (sidecar gateway profile, ChatGPT Codex
 * subscription profile, Codex subscription auth setup preparation).
 *
 * These functions used to live in `./api.ts`, but that module is first-load-reachable from
 * the desktop shell (imported from AppShell). Their contract validators (from
 * `coding-workbench-codex-auth`) transitively value-import from `coding-workbench` and
 * `coding-workbench-evidence`, which are large modules (~12 KiB gzip together). Landing that
 * whole surface in the initial static-export chunks fought the `check:editor-bundle-size`
 * gate (issue #2639, PR #2602 raised the ceiling +4 KiB as a documented deferral).
 *
 * Moving the fetchers here keeps them inside the CodingWorkbench dynamic subtree — the only
 * production caller is `coding-workbench-runtime-hooks.ts`, which is loaded via the
 * `next/dynamic({ ssr: false })` boundary in `widgets/index.tsx`. The validators + contract
 * types now travel with that lazy chunk instead of the desktop shell's first-load bundle.
 */

import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchSidecarGatewayResult,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayReadinessReport } from "@oscharko-dev/keiko-contracts/bff-wire";
import { listCodingWorkbenchReadinessCandidates } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { isGatewayVerificationState } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import {
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-codex-auth";
import {
  GATEWAY_CONFIG_UPDATED_EVENT,
  notifyGatewayModelReadinessUpdated,
} from "@/app/components/desktop/widgets/shared/gatewaySetupBus";
import { ApiError, resetModelRequestCache } from "./api";
import { bffFetchJson } from "./http";

// Match the `withReadDeadline` behaviour in api.ts: a GET/HEAD read that stalls past this
// window is a failure, not a slow success (GEN-RES-FETCH-001). State-changing calls keep no
// default deadline — long-running mutations are legitimate.
const DEFAULT_READ_TIMEOUT_MS = 15_000;

interface CodingWorkbenchProviderValidation {
  readonly ok: true;
  readonly reasons?: never;
}

interface CodingWorkbenchProviderValidationFailure {
  readonly ok: false;
  readonly reasons: readonly string[];
}

type ProviderResponseValidator = (
  value: unknown,
) => CodingWorkbenchProviderValidation | CodingWorkbenchProviderValidationFailure;

// The BFF's sidecar-gateway route reports an unavailable profile with a machine-readable reason
// that the UI narrows through this allow-list. Keep the list beside the validator that reads it.
const CODING_WORKBENCH_SIDECAR_UNAVAILABLE_REASONS = new Set([
  "missing-config",
  "missing-provider",
  "missing-credentials",
  "non-chat",
  "no-tool-calling",
  "non-workflow-eligible",
  "non-coding-capable",
  "deployment-policy-disabled",
  "subscription-source",
  // #3390 closeout: an otherwise-configured, probed profile whose derived `maxPromptTokens` is
  // below the coding runtime's minimum (epic #3384 readiness gap).
  "model-context-window-insufficient",
  // PR #3452 (F73): the coding model's forced tool-call proof has aged out or is missing.
  "tool-calling-unverified",
]);
const AUTOMATIC_READINESS_REASONS = new Set(["no-tool-calling", "tool-calling-unverified"]);
const MODEL_COST_CLASSES = new Set(["low", "medium", "high"]);
const AUTOMATIC_READINESS_RETRY_COOLDOWN_MS = 30_000;
const automaticReadinessRequests = new Map<string, Promise<boolean>>();
const automaticReadinessRetryAt = new Map<string, number>();
let automaticReadinessGeneration = 0;
let automaticReadinessConfigListenerInstalled = false;

interface ModelListResponse {
  readonly models: readonly ModelCapability[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateSidecarRunMetadata(value: unknown, reasons: string[]): boolean {
  if (!isObjectRecord(value)) {
    reasons.push("runMetadata must be an object");
    return false;
  }
  for (const key of [
    "maxPromptTokens",
    "maxOutputTokens",
    "maxInputMessages",
    "maxRequestBytes",
  ] as const) {
    if (!isPositiveSafeInteger(value[key])) reasons.push(`runMetadata.${key} must be positive`);
  }
  return reasons.length === 0;
}

function validateSidecarGatewayProfileResponse(
  value: unknown,
): CodingWorkbenchProviderValidation | CodingWorkbenchProviderValidationFailure {
  const reasons: string[] = [];
  if (!isObjectRecord(value)) return { ok: false, reasons: ["response must be an object"] };
  if (value.status === "unavailable") {
    if (
      typeof value.reason !== "string" ||
      !CODING_WORKBENCH_SIDECAR_UNAVAILABLE_REASONS.has(value.reason)
    ) {
      reasons.push("reason is invalid");
    }
    return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
  }
  if (value.status !== "available") {
    return { ok: false, reasons: ["status is invalid"] };
  }
  if (typeof value.profileId !== "string" || value.profileId.length === 0) {
    reasons.push("profileId must be a non-empty string");
  }
  if (typeof value.modelAlias !== "string" || value.modelAlias.length === 0) {
    reasons.push("modelAlias must be a non-empty string");
  }
  if (typeof value.localEndpointPath !== "string" || value.localEndpointPath.length === 0) {
    reasons.push("localEndpointPath must be a non-empty string");
  }
  if (typeof value.supportsStreaming !== "boolean") {
    reasons.push("supportsStreaming must be boolean");
  }
  if (typeof value.supportsToolCalling !== "boolean") {
    reasons.push("supportsToolCalling must be boolean");
  }
  // F-01: fail closed on the probe outcome. An absent or unrecognized value is rejected rather than
  // defaulted, because the only safe default a validator could pick is "unverified" — and silently
  // substituting it would hide a BFF that stopped reporting verification at all.
  if (!isGatewayVerificationState(value.verification)) {
    reasons.push("verification must be a gateway verification state");
  }
  validateSidecarRunMetadata(value.runMetadata, reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function validateCodexSubscriptionProfileResponse(
  value: unknown,
): CodingWorkbenchProviderValidation | CodingWorkbenchProviderValidationFailure {
  const result = validateCodingWorkbenchCodexSubscriptionProfile(value);
  return result.ok ? { ok: true } : { ok: false, reasons: result.errors };
}

function validateCodexAuthSetupPlanResponse(
  value: unknown,
): CodingWorkbenchProviderValidation | CodingWorkbenchProviderValidationFailure {
  const result = validateCodingWorkbenchCodexAuthSetupPlan(value);
  return result.ok ? { ok: true } : { ok: false, reasons: result.errors };
}

function validateModelListResponse(
  value: unknown,
): CodingWorkbenchProviderValidation | CodingWorkbenchProviderValidationFailure {
  if (!isObjectRecord(value) || !Array.isArray(value.models)) {
    return { ok: false, reasons: ["models must be an array"] };
  }
  const malformed = value.models.some(
    (model) =>
      !isObjectRecord(model) ||
      typeof model.id !== "string" ||
      typeof model.kind !== "string" ||
      typeof model.workflowEligible !== "boolean" ||
      !Array.isArray(model.preferredUseCases) ||
      !model.preferredUseCases.every((useCase) => typeof useCase === "string") ||
      !MODEL_COST_CLASSES.has(String(model.costClass)),
  );
  return malformed
    ? { ok: false, reasons: ["models contains an invalid capability"] }
    : { ok: true };
}

function contractValidator<T>(
  validator: ProviderResponseValidator,
): (path: string, value: unknown) => T {
  return (path: string, value: unknown): T => {
    const validation = validator(value);
    if (validation.ok) return value as T;
    const reason = validation.reasons[0] ?? "unknown validation failure";
    throw new ApiError(
      "CONTRACT_VALIDATION_FAILED",
      `BFF response for ${path} failed contract validation: ${reason}`,
      502,
    );
  };
}

function readDeadlineSignal(): AbortSignal {
  return AbortSignal.timeout(DEFAULT_READ_TIMEOUT_MS);
}

async function readSidecarGatewayProfile(): Promise<CodingWorkbenchSidecarGatewayResult> {
  return bffFetchJson(
    "/api/coding-sidecar/gateway/profile",
    { cache: "no-store", signal: readDeadlineSignal() },
    {
      validator: contractValidator<CodingWorkbenchSidecarGatewayResult>(
        validateSidecarGatewayProfileResponse,
      ),
    },
  );
}

function resetAutomaticReadinessGeneration(): void {
  automaticReadinessGeneration += 1;
  automaticReadinessRetryAt.clear();
}

function ensureAutomaticReadinessConfigListener(): void {
  if (automaticReadinessConfigListenerInstalled || typeof window === "undefined") return;
  window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, resetAutomaticReadinessGeneration);
  automaticReadinessConfigListenerInstalled = true;
}

function readinessConfigurationKey(candidates: readonly ModelCapability[]): string {
  return JSON.stringify(
    candidates.map((candidate) => ({
      id: candidate.id,
      costClass: candidate.costClass,
      toolCalling: candidate.toolCalling,
      toolCallingVerification: candidate.toolCallingVerification,
    })),
  );
}

function reportVerifiedToolCalling(report: GatewayReadinessReport): boolean {
  return (
    report.verifiedCapabilities.toolCalling === true &&
    report.probes.some((probe) => probe.name === "tool_calling" && probe.status === "passed")
  );
}

async function probeAutomaticReadinessCandidates(
  candidates: readonly ModelCapability[],
): Promise<boolean> {
  for (const candidate of candidates) {
    const report = await bffFetchJson<GatewayReadinessReport>("/api/gateway/readiness", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({
        modelId: candidate.id,
        options: { probes: ["tool_calling"], purpose: "coding-workbench-auto" },
      }),
    });
    if (reportVerifiedToolCalling(report)) return true;
  }
  return false;
}

function requestAutomaticReadiness(candidates: readonly ModelCapability[]): Promise<boolean> {
  ensureAutomaticReadinessConfigListener();
  const generation = automaticReadinessGeneration;
  const fingerprint = readinessConfigurationKey(candidates);
  const requestKey = `${String(generation)}:${fingerprint}`;
  if ((automaticReadinessRetryAt.get(requestKey) ?? 0) > Date.now()) {
    return Promise.resolve(false);
  }
  const active = automaticReadinessRequests.get(requestKey);
  if (active !== undefined) return active;
  const request = probeAutomaticReadinessCandidates(candidates)
    .then((ready): boolean => {
      if (generation !== automaticReadinessGeneration) return false;
      if (ready) {
        automaticReadinessRetryAt.delete(requestKey);
        resetModelRequestCache();
        notifyGatewayModelReadinessUpdated();
      } else {
        automaticReadinessRetryAt.set(
          requestKey,
          Date.now() + AUTOMATIC_READINESS_RETRY_COOLDOWN_MS,
        );
      }
      return ready;
    })
    .catch((error: unknown): never => {
      if (generation === automaticReadinessGeneration) {
        automaticReadinessRetryAt.set(
          requestKey,
          Date.now() + AUTOMATIC_READINESS_RETRY_COOLDOWN_MS,
        );
      }
      throw error;
    });
  const tracked = request.finally(() => automaticReadinessRequests.delete(requestKey));
  automaticReadinessRequests.set(requestKey, tracked);
  return tracked;
}

async function recoverUnverifiedGatewayProfile(
  profile: CodingWorkbenchSidecarGatewayResult,
): Promise<CodingWorkbenchSidecarGatewayResult> {
  if (profile.status !== "unavailable" || !AUTOMATIC_READINESS_REASONS.has(profile.reason)) {
    return profile;
  }
  const response = await bffFetchJson<ModelListResponse>(
    "/api/models",
    { cache: "no-store", signal: readDeadlineSignal() },
    { validator: contractValidator<ModelListResponse>(validateModelListResponse) },
  );
  const candidates = listCodingWorkbenchReadinessCandidates(response.models);
  if (candidates.length === 0) return profile;
  if (!(await requestAutomaticReadiness(candidates))) return profile;
  return readSidecarGatewayProfile();
}

export async function fetchCodingWorkbenchSidecarGatewayProfile(): Promise<CodingWorkbenchSidecarGatewayResult> {
  return recoverUnverifiedGatewayProfile(await readSidecarGatewayProfile());
}

export async function fetchCodingWorkbenchCodexSubscriptionProfile(): Promise<CodingWorkbenchCodexSubscriptionProfile> {
  return bffFetchJson(
    "/api/coding-workbench/codex-subscription/profile",
    { cache: "no-store", signal: readDeadlineSignal() },
    {
      validator: contractValidator<CodingWorkbenchCodexSubscriptionProfile>(
        validateCodexSubscriptionProfileResponse,
      ),
    },
  );
}

export async function prepareCodingWorkbenchCodexSubscriptionSetup(
  method: CodingWorkbenchCodexAuthMethod,
): Promise<CodingWorkbenchCodexAuthSetupPlan> {
  return bffFetchJson(
    "/api/coding-workbench/codex-subscription/setup",
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ method }),
    },
    {
      validator: contractValidator<CodingWorkbenchCodexAuthSetupPlan>(
        validateCodexAuthSetupPlanResponse,
      ),
    },
  );
}
