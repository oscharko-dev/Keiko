import {
  validateBrowserApprovalChallengeResult,
  validateBrowserApprovalDecisionResult,
  validateBrowserApprovalManagementResult,
  validateBrowserApprovalProofResult,
  validateBrowserApprovalRequestResult,
  type BrowserApprovalChallengeInput,
  type BrowserApprovalChallengeResult,
  type BrowserApprovalDecisionInput,
  type BrowserApprovalDecisionResult,
  type BrowserApprovalManagementResult,
  type BrowserApprovalProofInput,
  type BrowserApprovalProofResult,
  type BrowserApprovalRequestInput,
  type BrowserApprovalRequestResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import type { CodingWorkbenchValidationResult } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";

const ROOT = "/api/coding-workbench/app-session/browser";
const REQUEST_TIMEOUT_MS = 15_000;
type Validator<T> = (value: unknown) => CodingWorkbenchValidationResult<T>;

function validated<T>(validate: Validator<T>, value: unknown): T {
  const parsed = validate(value);
  if (!parsed.ok)
    throw new ApiError("CONTRACT_VALIDATION_FAILED", "Browser approval response is invalid.", 502);
  return parsed.value;
}

function request<T>(
  action: string,
  body: unknown,
  validate: Validator<T>,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return bffFetchJson<T>(
    ROOT + action,
    {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    },
    {
      repairSession: false,
      ...(correlationId === undefined ? {} : { correlationId }),
      validator: (_path, value): T => validated(validate, value),
    },
  );
}

export function inspectBrowserApprovals(
  signal?: AbortSignal,
  correlationId?: string,
): Promise<BrowserApprovalManagementResult> {
  return request("", undefined, validateBrowserApprovalManagementResult, signal, correlationId);
}

export function requestBrowserApproval(
  input: BrowserApprovalRequestInput,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<BrowserApprovalRequestResult> {
  return request("/request", input, validateBrowserApprovalRequestResult, signal, correlationId);
}

export function approveBrowserRequest(
  input: BrowserApprovalDecisionInput,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<BrowserApprovalDecisionResult> {
  return request("/approve", input, validateBrowserApprovalDecisionResult, signal, correlationId);
}

export function requestBrowserChallenge(
  input: BrowserApprovalChallengeInput,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<BrowserApprovalChallengeResult> {
  return request(
    "/challenge",
    input,
    validateBrowserApprovalChallengeResult,
    signal,
    correlationId,
  );
}

export function proveBrowserApproval(
  input: BrowserApprovalProofInput,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<BrowserApprovalProofResult> {
  return request("/prove", input, validateBrowserApprovalProofResult, signal, correlationId);
}

export function revokeBrowserApproval(
  approvalId: string,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<BrowserApprovalDecisionResult> {
  return request(
    "/revoke",
    approvalId,
    validateBrowserApprovalDecisionResult,
    signal,
    correlationId,
  );
}
