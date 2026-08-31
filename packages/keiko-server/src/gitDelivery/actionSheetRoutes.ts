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
// evaluateGitPolicy over the server's trusted packs — NEVER from a client-asserted field. Browser
// requests may not satisfy approval; execution routes consume server-issued approval claims instead.
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
import type {
  GitDeliveryActionKind,
  GitDeliveryApprovalRequirement,
  GitDeliveryProviderCapability,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import {
  isGitDeliveryProviderCapability,
  parseGitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { containsForbiddenSecretShape } from "../qualityIntelligence/connectorErrors.js";
import {
  buildActionSheetFromFacts,
  type GitDeliveryProviderStateFacts,
  type GitDeliveryTrustedPolicyPacks,
} from "./actionSheetProjection.js";
import { defaultGitDeliveryPolicyPacksForAction } from "./defaultPolicyPacks.js";
import { gitDeliveryTerminationHandler, resolveProjectWorkspace } from "./execution.js";
import {
  createTrustedGitDeliveryBranchProtectionReader,
  type GitDeliveryBranchProtectionReader,
} from "./branchProtectionPreflight.js";

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
  "projectId",
  "resolvedInputs",
  "worktreeSnapshot",
  "activeProviderCapabilities",
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
const UNSAFE_FORMAT_CHAR = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/u;

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

// ─── Validated request ─────────────────────────────────────────────────────────────

interface ValidatedRequest {
  readonly projectId: string;
  readonly resolvedInputs: GitDeliveryResolvedInputs;
  readonly worktreeSnapshot: GitWorktreeSnapshot;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
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
  if (typeof obj.projectId !== "string" || obj.projectId.length === 0) return badRequest();
  const inputs = parseGitDeliveryResolvedInputs(obj.resolvedInputs);
  if (!inputs.ok) return badRequest();
  if (!isGitWorktreeSnapshot(obj.worktreeSnapshot)) return badRequest();
  const capabilities = validateProviderCapabilities(obj.activeProviderCapabilities);
  if (!capabilities.ok) return badRequest();
  return {
    kind: "ok",
    request: {
      projectId: obj.projectId,
      resolvedInputs: inputs.value,
      worktreeSnapshot: obj.worktreeSnapshot,
      approvalRequirement: { required: false },
      activeProviderCapabilities: capabilities.value,
    },
  };
}

// ─── Deterministic action id ─────────────────────────────────────────────────────────
// A stable id derived from the content-free request facts so identical requests are addressable
// identically and the projection is reproducible. Injectable via options.idGenerator for tests.

function defaultActionId(request: ValidatedRequest): string {
  const seed = JSON.stringify({
    projectId: request.projectId,
    inputs: request.resolvedInputs,
    snapshot: request.worktreeSnapshot,
    capabilities: request.activeProviderCapabilities,
  });
  return `git-delivery-action-${sha256Hex(seed).slice(0, 24)}`;
}

// ─── Handler ───────────────────────────────────────────────────────────────────────
//
// The org/repo policy packs come from a TRUSTED server-side SEAM ONLY — never from the request body,
// preserving the AUTHORITY RULE (AC1). Production resolves the exact shipped pack used by the
// executing route for the action kind. Deployment composition may inject a stricter trusted resolver
// without touching the request shape.

export interface GitDeliveryActionSheetRouteOptions {
  readonly idGenerator?: (request: ValidatedRequest) => string;
  readonly policyPacks?: (
    deps: UiHandlerDeps,
    actionKind: GitDeliveryActionKind,
  ) => GitDeliveryTrustedPolicyPacks;
  readonly providerState?: (
    deps: UiHandlerDeps,
    request: ValidatedRequest,
  ) => Promise<GitDeliveryProviderResolution> | GitDeliveryProviderResolution;
  readonly branchProtectionReader?: GitDeliveryBranchProtectionReader;
  // The server clock (epoch ms). Injectable for deterministic tests; defaults to Date.now. Used only
  // to demote an expired granted approval to "waiting-for-approval" in the projection.
  readonly now?: () => number;
  // Test/deployment seam for the default branch-protection reader's runCommand
  // termination-evidence callback (see gitDeliveryTerminationHandler). Production writes
  // content-free termination evidence through the process activity log, same as every other
  // git-delivery route.
  readonly activityLog?: ServerLogSink;
}

interface GitDeliveryProviderResolution {
  readonly facts: GitDeliveryProviderStateFacts;
  readonly ready: boolean;
}

function preferredRemoteAlias(snapshot: GitWorktreeSnapshot): string | undefined {
  return snapshot.remoteAliases.includes("origin") ? "origin" : snapshot.remoteAliases[0];
}

function providerProtectionTarget(
  request: ValidatedRequest,
): { readonly remoteAlias: string; readonly branchName: string } | undefined {
  const inputs = request.resolvedInputs;
  if (inputs.kind === "push") {
    return { remoteAlias: inputs.remoteAlias, branchName: inputs.remoteBranchName };
  }
  if (inputs.kind !== "commit") return undefined;
  const remoteAlias = preferredRemoteAlias(request.worktreeSnapshot);
  const branchName = request.worktreeSnapshot.currentBranchName;
  return remoteAlias === undefined || branchName === undefined
    ? undefined
    : { remoteAlias, branchName };
}

async function defaultProviderState(
  deps: UiHandlerDeps,
  request: ValidatedRequest,
  reader: GitDeliveryBranchProtectionReader,
): Promise<GitDeliveryProviderResolution> {
  const target = providerProtectionTarget(request);
  if (target === undefined) return { facts: {}, ready: true };
  const workspace = resolveProjectWorkspace(deps, request.projectId);
  if (workspace === undefined) return { facts: {}, ready: false };
  const result = await reader(workspace, target.remoteAlias, target.branchName);
  if (result.outcome === "unavailable") return { facts: {}, ready: false };
  return result.outcome === "protected"
    ? { facts: { branchProtection: result.protection }, ready: true }
    : { facts: {}, ready: true };
}

async function resolvedProviderState(
  resolver: NonNullable<GitDeliveryActionSheetRouteOptions["providerState"]>,
  deps: UiHandlerDeps,
  request: ValidatedRequest,
): Promise<GitDeliveryProviderResolution> {
  try {
    return await resolver(deps, request);
  } catch {
    return { facts: {}, ready: false };
  }
}

type ActionSheetRequestRead =
  | { readonly ok: true; readonly request: ValidatedRequest }
  | { readonly ok: false; readonly result: RouteResult };

// Reads the bounded body, parses JSON, and validates the envelope. Extracted from
// createHandleGitDeliveryActionSheet's returned handler purely to stay under the
// function-length budget (AGENTS.md §6) — no behavioral seam of its own.
async function readValidatedActionSheetRequest(ctx: RouteContext): Promise<ActionSheetRequestRead> {
  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { ok: false, result: errResult(413, "GIT_DELIVERY_ACTION_SHEET_PAYLOAD_TOO_LARGE") };
    }
    return { ok: false, result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST") };
  }
  const validation = validateRequest(parsed);
  return validation.kind === "err"
    ? { ok: false, result: validation.result }
    : { ok: true, request: validation.request };
}

export const createHandleGitDeliveryActionSheet = (
  options: GitDeliveryActionSheetRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const idGenerator = options.idGenerator ?? defaultActionId;
  const resolvePolicyPacks =
    options.policyPacks ??
    ((_deps: UiHandlerDeps, actionKind: GitDeliveryActionKind): GitDeliveryTrustedPolicyPacks =>
      defaultGitDeliveryPolicyPacksForAction(actionKind));
  const now = options.now ?? ((): number => Date.now());
  const activityLog = options.activityLog ?? processServerLogSink();
  return async (ctx, deps): Promise<RouteResult> => {
    const read = await readValidatedActionSheetRequest(ctx);
    if (!read.ok) return read.result;
    const { request } = read;

    // Built per-request (not at factory-construction time) so the default branch-protection
    // reader's runCommand termination-evidence callback carries THIS request's own correlationId
    // instead of silently omitting it (audit finding: this was the one branchProtectionReader
    // consumer, alongside commitRoutes.ts and pushRoutes.ts, that never wired one in at all).
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const branchProtectionReader =
      options.branchProtectionReader ??
      createTrustedGitDeliveryBranchProtectionReader(
        gitDeliveryTerminationHandler({ activityLog }, correlationId),
      );
    const resolveProviderState =
      options.providerState ??
      ((
        stateDeps: UiHandlerDeps,
        stateRequest: ValidatedRequest,
      ): Promise<GitDeliveryProviderResolution> =>
        defaultProviderState(stateDeps, stateRequest, branchProtectionReader));

    const provider = await resolvedProviderState(resolveProviderState, deps, request);
    const sheet = buildActionSheetFromFacts({
      actionId: idGenerator(request),
      resolvedInputs: request.resolvedInputs,
      worktreeSnapshot: request.worktreeSnapshot,
      approvalRequirement: request.approvalRequirement,
      policyPacks: resolvePolicyPacks(deps, request.resolvedInputs.kind),
      activeProviderCapabilities: request.activeProviderCapabilities,
      providerState: provider.facts,
      providerReady: provider.ready,
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
