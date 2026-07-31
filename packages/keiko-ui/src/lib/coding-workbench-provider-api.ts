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
} from "@oscharko-dev/keiko-contracts";
import {
  isGatewayVerificationState,
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import { ApiError } from "./api";
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
]);

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

export async function fetchCodingWorkbenchSidecarGatewayProfile(): Promise<CodingWorkbenchSidecarGatewayResult> {
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
