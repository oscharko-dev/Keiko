// Governed Git delivery action-sheet BFF route (Issue #473, Epic #470).
//
// Single additive, READ-ONLY HTTP handler:
//   * POST /api/git-delivery/action-sheet
//
// It is a COMPUTATIONAL endpoint: it NEVER mutates the repository and NEVER calls runGitMutation. It
// validates a content-free request envelope, runs the kernel preflight + the server-side policy
// evaluator over TRUSTED packs, and returns a UI-safe GitDeliveryActionSheet projection.
//
// AUTHORITY (AC1): the policy decision, approval necessity, and required approvers come from
// evaluateGitPolicy over the server's trusted packs — NEVER from a client-asserted field. The request
// may carry a GRANTED approval payload; only its SHAPE is validated (isGitDeliveryApprovalRequirement).
// There is no client-supplied policy-decision field, and there must never be one.
//
// Hard constraints (mirroring qualityIntelligence/handoffRoutes.ts):
//   * Unknown top-level keys are REJECTED so a leaky client cannot smuggle content through the seam.
//   * Every string field is scrubbed for credential-shaped substrings before processing.
//   * Bounded body read (~64 KiB) → 413; bad JSON / failed validation → 400; both as a content-free
//     `{ error: { code, message } }` envelope keyed by a typed code union.
//   * CSRF + JSON content-type are enforced CENTRALLY by server.ts for POST — no per-route opt-in.
//
// Content-free: the response carries counts, flags, branch names, and typed codes only — never diff
// content, file paths, secrets, command strings, or raw subprocess output. The assembled sheet is
// additionally deep-redacted through deps.redactor before it leaves the server (defence-in-depth).

import type { IncomingMessage } from "node:http";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  isGitDeliveryApprovalRequirement,
  isGitDeliveryBranchProtection,
  isGitDeliveryChecksState,
  isGitDeliveryMergeReadiness,
  isGitDeliveryProviderCapability,
  isGitDeliveryPullRequestState,
  parseGitDeliveryResolvedInputs,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryProviderCapability,
  type GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { containsForbiddenSecretShape } from "../qualityIntelligence/connectorErrors.js";
import { isGitDeliveryTrusted } from "./capability.js";
import {
  buildActionSheetFromFacts,
  type GitDeliveryProviderStateFacts,
  type GitDeliveryTrustedPolicyPacks,
} from "./actionSheetProjection.js";

// ─── Error envelope (typed, content-free) ────────────────────────────────────────────

export type GitDeliveryActionSheetErrorCode =
  | "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST"
  | "GIT_DELIVERY_ACTION_SHEET_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_ACTION_SHEET_FORBIDDEN_PAYLOAD";

export interface GitDeliveryActionSheetErrorBody {
  readonly error: {
    readonly code: GitDeliveryActionSheetErrorCode;
    readonly message: string;
  };
}

const SAFE_MESSAGES: Readonly<Record<GitDeliveryActionSheetErrorCode, string>> = {
  GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST:
    "The request body is not a valid Git delivery action-sheet request.",
  GIT_DELIVERY_ACTION_SHEET_PAYLOAD_TOO_LARGE:
    "The Git delivery action-sheet request exceeds the maximum permitted size.",
  GIT_DELIVERY_ACTION_SHEET_FORBIDDEN_PAYLOAD:
    "The action-sheet request contained a forbidden field. Requests may not carry credentials, headers, or URLs.",
};

const errResult = (status: number, code: GitDeliveryActionSheetErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } } satisfies GitDeliveryActionSheetErrorBody,
});

// ─── Bounded body reading ──────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {
  public constructor() {
    super("Action-sheet body exceeds the route cap");
    this.name = "BodyTooLargeError";
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

// ─── Validation helpers ──────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyAllowedKeys = (
  obj: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
};

const ALLOWED_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "resolvedInputs",
  "worktreeSnapshot",
  "approval",
  "providerState",
  "activeProviderCapabilities",
]);

const ALLOWED_PROVIDER_STATE_KEYS: ReadonlySet<string> = new Set([
  "pullRequest",
  "mergeReadiness",
  "branchProtection",
  "checks",
]);

const scanForbiddenStrings = (value: unknown): boolean => {
  if (typeof value === "string") return containsForbiddenSecretShape(value);
  if (Array.isArray(value)) return value.some(scanForbiddenStrings);
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) {
      if (scanForbiddenStrings(v)) return true;
    }
    return false;
  }
  return false;
};

// Zero-width, bidi-control, and BOM format characters. Branch names / refs / IDs in this content-free
// request never legitimately contain them; a U+202E override or zero-width char would spoof the
// approval target on the surface whose whole purpose is to show WHICH branch is being approved
// (Trojan-Source). Reject fail-closed at the boundary. (C0/C1 controls are already barred by git ref
// rules and the kernel adapter's NUL/flag guards, so this set deliberately omits them.)
const UNSAFE_FORMAT_CHAR = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]",
  "u",
);

const scanUnsafeFormatChars = (value: unknown): boolean => {
  if (typeof value === "string") return UNSAFE_FORMAT_CHAR.test(value);
  if (Array.isArray(value)) return value.some(scanUnsafeFormatChars);
  if (isPlainObject(value)) return Object.values(value).some(scanUnsafeFormatChars);
  return false;
};

// ─── Worktree-snapshot shape validation (content-free; counts/flags/names only) ──────

const isNonNegInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isBool = (value: unknown): value is boolean => typeof value === "boolean";

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isOptional = <T>(check: (v: unknown) => v is T, v: unknown): v is T | undefined =>
  v === undefined || check(v);

const ABORTABLE_OPERATIONS: ReadonlySet<string> = new Set([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "bisect",
]);

function snapshotCountFieldsValid(value: Record<string, unknown>): boolean {
  return (
    isBool(value.headDetached) &&
    isOptional((v): v is string => typeof v === "string", value.currentBranchName) &&
    isNonNegInt(value.stagedFileCount) &&
    isNonNegInt(value.unstagedFileCount) &&
    isNonNegInt(value.untrackedFileCount)
  );
}

function snapshotRemoteFieldsValid(value: Record<string, unknown>): boolean {
  return (
    isBool(value.hasUpstream) &&
    isNonNegInt(value.aheadCount) &&
    isNonNegInt(value.behindCount) &&
    isStringArray(value.existingLocalBranchNames) &&
    isStringArray(value.remoteAliases) &&
    isOptional(isBool, value.remoteReachable) &&
    isOptional(
      (v): v is string => typeof v === "string" && ABORTABLE_OPERATIONS.has(v),
      value.operationInProgress,
    )
  );
}

function isGitWorktreeSnapshot(value: unknown): value is GitWorktreeSnapshot {
  return (
    isPlainObject(value) && snapshotCountFieldsValid(value) && snapshotRemoteFieldsValid(value)
  );
}

// ─── Provider-state validation ───────────────────────────────────────────────────────

function validateProviderState(
  raw: unknown,
): { readonly ok: true; readonly value: GitDeliveryProviderStateFacts } | { readonly ok: false } {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isPlainObject(raw) || !hasOnlyAllowedKeys(raw, ALLOWED_PROVIDER_STATE_KEYS)) {
    return { ok: false };
  }
  if (
    !isOptional(isGitDeliveryPullRequestState, raw.pullRequest) ||
    !isOptional(isGitDeliveryMergeReadiness, raw.mergeReadiness) ||
    !isOptional(isGitDeliveryBranchProtection, raw.branchProtection) ||
    !isOptional(isGitDeliveryChecksState, raw.checks)
  ) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

function validateProviderCapabilities(
  raw: unknown,
):
  | { readonly ok: true; readonly value: readonly GitDeliveryProviderCapability[] }
  | { readonly ok: false } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || !raw.every(isGitDeliveryProviderCapability)) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

function validateApproval(
  raw: unknown,
): { readonly ok: true; readonly value: GitDeliveryApprovalRequirement } | { readonly ok: false } {
  if (raw === undefined) return { ok: true, value: { required: false } };
  if (!isGitDeliveryApprovalRequirement(raw)) return { ok: false };
  return { ok: true, value: raw };
}

// ─── Validated request ─────────────────────────────────────────────────────────────

interface ValidatedRequest {
  readonly resolvedInputs: GitDeliveryResolvedInputs;
  readonly worktreeSnapshot: GitWorktreeSnapshot;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
  readonly providerState: GitDeliveryProviderStateFacts;
  readonly activeProviderCapabilities: readonly GitDeliveryProviderCapability[];
}

type Validation =
  | { readonly kind: "ok"; readonly request: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

const badRequest = (): Validation => ({
  kind: "err",
  result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST"),
});

type EnvelopeCheck =
  | { readonly ok: true; readonly obj: Record<string, unknown> }
  | { readonly ok: false; readonly result: RouteResult };

// Envelope-level gate: shape, allowed keys, schema version, secret-shape scan, and unsafe-format-char
// (bidi/zero-width/BOM) scan. Extracted so validateRequest stays within the complexity budget.
function preValidateEnvelope(parsed: unknown): EnvelopeCheck {
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, ALLOWED_REQUEST_KEYS)) {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST") };
  }
  if (parsed.schemaVersion !== "1") {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST") };
  }
  if (scanForbiddenStrings(parsed)) {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_FORBIDDEN_PAYLOAD") };
  }
  if (scanUnsafeFormatChars(parsed)) {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST") };
  }
  return { ok: true, obj: parsed };
}

function validateRequest(parsed: unknown): Validation {
  const envelope = preValidateEnvelope(parsed);
  if (!envelope.ok) return { kind: "err", result: envelope.result };
  const obj = envelope.obj;
  const inputs = parseGitDeliveryResolvedInputs(obj.resolvedInputs);
  if (!inputs.ok) return badRequest();
  if (!isGitWorktreeSnapshot(obj.worktreeSnapshot)) return badRequest();
  const approval = validateApproval(obj.approval);
  if (!approval.ok) return badRequest();
  const providerState = validateProviderState(obj.providerState);
  if (!providerState.ok) return badRequest();
  const capabilities = validateProviderCapabilities(obj.activeProviderCapabilities);
  if (!capabilities.ok) return badRequest();
  return {
    kind: "ok",
    request: {
      resolvedInputs: inputs.value,
      worktreeSnapshot: obj.worktreeSnapshot,
      approvalRequirement: approval.value,
      providerState: providerState.value,
      activeProviderCapabilities: capabilities.value,
    },
  };
}

// ─── Deterministic action id ─────────────────────────────────────────────────────────
// A stable id derived from the content-free request facts so identical requests are addressable
// identically and the projection is reproducible. Injectable via options.idGenerator for tests.

function defaultActionId(request: ValidatedRequest): string {
  const seed = JSON.stringify({
    inputs: request.resolvedInputs,
    snapshot: request.worktreeSnapshot,
    capabilities: request.activeProviderCapabilities,
  });
  return `git-delivery-action-${sha256Hex(seed).slice(0, 24)}`;
}

// ─── Handler ───────────────────────────────────────────────────────────────────────
//
// The org/repo policy packs come from a TRUSTED server-side SEAM ONLY — never from the request body,
// preserving the AUTHORITY RULE (AC1). No gateway-config field carries them today, so the default
// resolver returns no packs; evaluateGitPolicy then fail-closes to blocked/no-applicable-rule, the
// correct secure default. The injectable `policyPacks` option lets a future slice (#476) hydrate packs
// from storage — and lets tests configure trusted packs deterministically — without touching the
// request shape.

export interface GitDeliveryActionSheetRouteOptions {
  readonly idGenerator?: (request: ValidatedRequest) => string;
  // Resolves the trusted org/repo policy packs for this deployment. Default: none configured.
  readonly policyPacks?: (deps: UiHandlerDeps) => GitDeliveryTrustedPolicyPacks;
  // The server clock (epoch ms). Injectable for deterministic tests; defaults to Date.now. Used only
  // to demote an expired granted approval to "waiting-for-approval" in the projection.
  readonly now?: () => number;
}

export const createHandleGitDeliveryActionSheet = (
  options: GitDeliveryActionSheetRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const idGenerator = options.idGenerator ?? defaultActionId;
  const resolvePolicyPacks = options.policyPacks ?? ((): GitDeliveryTrustedPolicyPacks => ({}));
  const now = options.now ?? ((): number => Date.now());
  return async (ctx, deps): Promise<RouteResult> => {
    let raw: string;
    try {
      raw = await readBody(ctx.req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return errResult(413, "GIT_DELIVERY_ACTION_SHEET_PAYLOAD_TOO_LARGE");
      }
      return errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST");
    }
    const validation = validateRequest(parsed);
    if (validation.kind === "err") return validation.result;
    const { request } = validation;

    const sheet = buildActionSheetFromFacts({
      actionId: idGenerator(request),
      resolvedInputs: request.resolvedInputs,
      worktreeSnapshot: request.worktreeSnapshot,
      approvalRequirement: request.approvalRequirement,
      policyPacks: resolvePolicyPacks(deps),
      activeProviderCapabilities: request.activeProviderCapabilities,
      providerState: request.providerState,
      providerReady: isGitDeliveryTrusted(deps),
      nowMs: now(),
    });
    return { status: 200, body: deps.redactor(sheet) };
  };
};

export const handleGitDeliveryActionSheet = createHandleGitDeliveryActionSheet();

// Mechanically-mergeable route group. routes.ts spreads this into API_ROUTES, mirroring
// QI_HANDOFF_ROUTE_GROUP, so concurrent #470 epic merges stay merge-safe.
export const GIT_DELIVERY_ACTION_SHEET_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/git-delivery/action-sheet",
    handler: handleGitDeliveryActionSheet,
  },
];
