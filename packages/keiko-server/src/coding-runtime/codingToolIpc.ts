import { parseDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type { CodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import { parseRuntimeGitRequest, type RuntimeGitRequest } from "./codingRuntimeGitIpc.js";
import {
  captureCodingRepositoryRequest,
  type CodingRepositoryRequest,
  type CodingRepositoryResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { isUtf8 } from "node:buffer";

import type {
  AuxiliaryCapabilityOutcomeV1,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  EditorAgentChangeset,
  VerifiedCommitResult,
  CodingRuntimeGitResult,
} from "@oscharko-dev/keiko-contracts";
import { isCodeTaskSkillId } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { isEditorAgentChangeset } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { isDenied } from "@oscharko-dev/keiko-workspace";

export const CODING_TOOL_MAX_BODY_BYTES = 262_144;
export const CODING_TOOL_MAX_IN_FLIGHT = 8;
export const CODING_TOOL_MAX_READ_BYTES = 65_536;
/** Highest 1-based line a read window may start at; bounds the model-visible schema too. */
export const CODING_TOOL_READ_MAX_START_LINE = 1_000_000;
/** Largest read-window height; bounds the model-visible schema too. */
export const CODING_TOOL_READ_MAX_WINDOW_LINES = 5_000;
/** Largest model-visible repository-path discovery result. */
export const CODING_TOOL_DISCOVER_MAX_RESULTS = 100;

export type CodingToolAction =
  | "read"
  | "discover"
  | "search"
  | "edit"
  | "command"
  | "verification"
  | "git"
  | "delivery"
  | "connector"
  | "egress"
  | "skill"
  | "child-agent";

export interface CodingToolRequestIdentity {
  readonly actionId: string;
  readonly idempotencyKey: string;
}

export interface CodingToolApprovalProof {
  readonly approvalId: string;
  readonly approvalDigest: string;
}

export type CodingToolActionRequest =
  | (CodingToolRequestIdentity & {
      readonly action: "read";
      readonly relativePath: string;
      /** Optional 1-based first line of the returned window (#2473 large-file reads). */
      readonly startLine?: number;
      /** Optional maximum number of lines in the returned window. */
      readonly maxLines?: number;
    })
  | (CodingToolRequestIdentity & {
      readonly action: "discover";
      readonly query: string;
      readonly maxResults: number;
    })
  | (CodingToolRequestIdentity & {
      readonly action: "search";
      readonly repositoryRequest: CodingRepositoryRequest;
    })
  | (CodingToolRequestIdentity & {
      readonly action: "edit";
      readonly changeset: EditorAgentChangeset;
    })
  | (CodingToolRequestIdentity & {
      readonly action: "command";
      readonly commandId: string;
      readonly approvalProof?: CodingToolApprovalProof | undefined;
    })
  | (CodingToolRequestIdentity & {
      readonly action: "verification";
      readonly verifierId: string;
      readonly approvalProof?: CodingToolApprovalProof | undefined;
    })
  | (CodingToolRequestIdentity & { readonly action: "git"; readonly operation: "read" })
  | (CodingToolRequestIdentity & { readonly action: "git"; readonly operation: "write" })
  | (CodingToolRequestIdentity & {
      readonly action: "git";
      readonly operation: "ci";
      /** #3388: bypasses the cached readiness snapshot for one fresh provider read. */
      readonly forceFresh?: boolean;
      /** 3941816393: redeems a Workbench-issued approval for a governed CI observation. */
      readonly approvalProof?: CodingToolApprovalProof | undefined;
    })
  | RuntimeGitRequest
  | (CodingToolRequestIdentity & {
      readonly action: "delivery";
      readonly intent: "commit" | "push" | "pull-request" | "merge";
      readonly phase?: "propose" | "execute" | "reconcile";
      readonly title?: string;
      readonly message?: string;
      readonly proposalId?: string;
      readonly approvalProof?: CodingToolApprovalProof | undefined;
    })
  | (CodingToolRequestIdentity & {
      readonly action: "connector";
      readonly scope: string;
      /** 3941816393: redeems a Workbench-issued approval for a governed connector read. */
      readonly approvalProof?: CodingToolApprovalProof | undefined;
    })
  | (CodingToolRequestIdentity & { readonly action: "egress"; readonly target: string })
  | (CodingToolRequestIdentity & { readonly action: "skill"; readonly skillId: string })
  | (CodingToolRequestIdentity & {
      readonly action: "child-agent";
      readonly objective: string;
      readonly maxToolCalls: number;
    });

type RuntimeActionClass =
  CodingWorkbenchRuntimeAuthorityEnvelope["authority"]["actionClasses"][number];

const STATIC_REQUIRED_CLASSES: Readonly<
  Record<Exclude<CodingToolActionRequest["action"], "git">, readonly RuntimeActionClass[]>
> = {
  read: ["workspace-read"],
  discover: ["workspace-read"],
  search: ["workspace-read"],
  edit: ["workspace-write"],
  command: ["command-execution"],
  verification: ["verification"],
  delivery: ["delivery-substrate"],
  connector: ["connector-access", "network-egress"],
  egress: ["network-egress"],
  skill: ["workspace-read"],
  "child-agent": ["workspace-read"],
};

/** Exact authority effects required by one parsed coding-tool action. */
export function codingToolRequiredActionClasses(
  request: CodingToolActionRequest,
): readonly RuntimeActionClass[] {
  if (request.action !== "git") return Object.freeze([...STATIC_REQUIRED_CLASSES[request.action]]);
  if (request.operation === "ci")
    return Object.freeze(["workspace-read", "connector-access", "network-egress"]);
  const effect =
    request.operation === "write" || (request.operation === "stage" && request.phase === "execute")
      ? "workspace-write"
      : "workspace-read";
  return Object.freeze([effect]);
}

export type CodingToolResult =
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly ci: CodingRuntimeCiResult;
    }
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly draftDelivery: CodingRuntimeDeliveryResult;
    }
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly git: CodingRuntimeGitResult;
    }
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly verifiedCommit: VerifiedCommitResult;
    }
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly search: CodingRepositoryResult;
    }
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly read: CodingToolReadResult | CodingToolEgressReadResult;
    }
  | { readonly status: "completed"; readonly evidence: readonly CodingToolEvidence[] }
  | {
      readonly status: "failed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly reasonCode?: string | undefined;
    }
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly auxiliary: AuxiliaryCapabilityOutcomeV1;
    }
  | {
      readonly status: "denied" | "invalid" | "cancelled" | "busy" | "observed";
      readonly evidence: readonly [];
    };

/** A research page read (#2387): digest and byte count cover exactly the returned bytes. */
export interface CodingToolEgressReadResult {
  readonly text: string;
  readonly byteCount: number;
  readonly digest: string;
}

/**
 * A repository read: `text` is the returned window — the whole file unless the request narrowed
 * it — while `digest` covers the WHOLE file so edit optimistic concurrency stays anchored (#2473).
 */
export interface CodingToolReadResult extends CodingToolEgressReadResult {
  /** Total number of lines in the whole file. */
  readonly totalLines: number;
  /** 1-based first line after the window; absent when the window reached the end of the file. */
  readonly nextStartLine?: number;
}

export interface CodingToolEvidence {
  readonly kind: string;
  readonly code: string;
}

export function parseCodingToolRequest(
  body: string | Buffer,
  maxBodyBytes: number,
): CodingToolActionRequest | undefined {
  const decoded = decodeBody(body, maxBodyBytes);
  if (decoded === undefined) return undefined;
  const value = parseJson(decoded);
  return isRecord(value) ? requestFromRecord(value) : undefined;
}

export function isPermissionObservation(body: string | Buffer, maxBodyBytes: number): boolean {
  const decoded = decodeBody(body, maxBodyBytes);
  if (decoded === undefined) return false;
  const value = parseJson(decoded);
  return (
    isRecord(value) &&
    hasExactKeys(value, ["action", "requestId"]) &&
    value.action === "permission-event" &&
    nonEmpty(value.requestId)
  );
}

function decodeBody(body: string | Buffer, maxBodyBytes: number): string | undefined {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (
    bytes.length > maxBodyBytes ||
    !isUtf8(bytes) ||
    (typeof body === "string" && bytes.toString("utf8") !== body)
  ) {
    return undefined;
  }
  return bytes.toString("utf8");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// Static dispatch on purpose. The `action` discriminator arrives in untrusted runtime JSON, so no
// form of table lookup is used to reach a callable: a plain object would resolve inherited keys
// such as "constructor" to a Function, and even a prototype-safe Map still calls a function chosen
// by attacker-controlled input. A switch names every reachable parser at compile time, and the
// `default` fails closed for anything else.
// One exhaustive case per wire action: the switch IS the parser table.
// eslint-disable-next-line complexity -- exhaustive static wire dispatch, see above
function requestFromRecord(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  switch (value.action) {
    case "read":
      return readRequest(value);
    case "discover":
      return discoverRequest(value);
    case "search":
      return searchRequest(value);
    case "edit":
      return editRequest(value);
    case "command":
      return approvableNamedRequest(value, "commandId", "command");
    case "verification":
      return approvableNamedRequest(value, "verifierId", "verification");
    case "git":
      return gitRequest(value);
    case "delivery":
      return deliveryRequest(value);
    case "connector":
      return simpleNamedRequest(value, "scope", "connector");
    case "egress":
      return simpleNamedRequest(value, "target", "egress");
    case "skill":
      return skillRequest(value);
    case "child-agent":
      return childAgentRequest(value);
    default:
      return undefined;
  }
}

function discoverRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  return identity !== undefined &&
    hasExactKeys(value, ["action", "actionId", "idempotencyKey", "query", "maxResults"]) &&
    boundedString(value.query, 256) &&
    positiveBoundedInteger(value.maxResults, CODING_TOOL_DISCOVER_MAX_RESULTS)
    ? {
        ...identity,
        action: "discover",
        query: value.query,
        maxResults: value.maxResults,
      }
    : undefined;
}

// Every field-shape and numeric limit lives in the contract's own `captureCodingRepositoryRequest`
// (packages/keiko-contracts/src/coding-repository-search.ts) and is never restated here: this
// parser only carries the envelope identity and hands the untrusted payload straight to it.
function searchRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (
    identity === undefined ||
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", "repositoryRequest"])
  ) {
    return undefined;
  }
  const repositoryRequest = captureCodingRepositoryRequest(value.repositoryRequest);
  return repositoryRequest === undefined
    ? undefined
    : { ...identity, action: "search", repositoryRequest };
}

function skillRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  return identity !== undefined &&
    hasExactKeys(value, ["action", "actionId", "idempotencyKey", "skillId"]) &&
    isCodeTaskSkillId(value.skillId)
    ? { ...identity, action: "skill", skillId: value.skillId }
    : undefined;
}

function childAgentRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  return identity !== undefined &&
    hasExactKeys(value, ["action", "actionId", "idempotencyKey", "objective", "maxToolCalls"]) &&
    nonEmpty(value.objective) &&
    positiveBoundedInteger(value.maxToolCalls, 32)
    ? {
        ...identity,
        action: "child-agent",
        objective: value.objective,
        maxToolCalls: value.maxToolCalls,
      }
    : undefined;
}

function readRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  const startLine = readWindowParameter(value, "startLine", CODING_TOOL_READ_MAX_START_LINE);
  const maxLines = readWindowParameter(value, "maxLines", CODING_TOOL_READ_MAX_WINDOW_LINES);
  return identity !== undefined &&
    hasAllowedKeys(value, [
      "action",
      "actionId",
      "idempotencyKey",
      "relativePath",
      "startLine",
      "maxLines",
    ]) &&
    normalizedRelativePath(value.relativePath) &&
    !isDenied(value.relativePath) &&
    startLine !== "invalid" &&
    maxLines !== "invalid"
    ? {
        ...identity,
        action: "read",
        relativePath: value.relativePath,
        ...(startLine === undefined ? {} : { startLine }),
        ...(maxLines === undefined ? {} : { maxLines }),
      }
    : undefined;
}

/** Absent stays absent; anything present must be a bounded positive integer or the request dies. */
function readWindowParameter(
  value: Record<string, unknown>,
  key: "startLine" | "maxLines",
  maximum: number,
): number | undefined | "invalid" {
  if (!Object.hasOwn(value, key)) return undefined;
  const candidate = value[key];
  return positiveBoundedInteger(candidate, maximum) ? candidate : "invalid";
}

function editRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  return identity !== undefined &&
    hasExactKeys(value, ["action", "actionId", "idempotencyKey", "changeset"]) &&
    isExactEditorAgentChangeset(value.changeset)
    ? { ...identity, action: "edit", changeset: value.changeset }
    : undefined;
}

export function isExactEditorAgentChangeset(value: unknown): value is EditorAgentChangeset {
  if (!isEditorAgentChangeset(value) || !isRecord(value)) return false;
  if (!hasAllowedKeys(value, ["patch", "files", "selectedFiles", "prepared"])) return false;
  return value.files.every(exactChangesetFile) && exactPreparedChangeset(value.prepared);
}

function exactChangesetFile(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ["file", "expectedDocumentVersion", "expectedContentHash"])
  )
    return false;
  return (
    value.expectedDocumentVersion === undefined ||
    exactDocumentVersion(value.expectedDocumentVersion)
  );
}

function exactDocumentVersion(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["sizeBytes", "modifiedAt", "contentHash"]);
}

function exactPreparedChangeset(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ["files"]) &&
    Array.isArray(value.files) &&
    value.files.every(exactPreparedFile)
  );
}

function exactPreparedFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["file", "kind", "textEdits"]) &&
    Array.isArray(value.textEdits) &&
    value.textEdits.every(exactTextEdit)
  );
}

function exactTextEdit(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["range", "newText"]) && exactRange(value.range);
}

function exactRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["start", "end"]) &&
    exactPosition(value.start) &&
    exactPosition(value.end)
  );
}

function exactPosition(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["line", "character"]);
}

function approvableNamedRequest(
  value: Record<string, unknown>,
  key: "commandId" | "verifierId",
  action: "command" | "verification",
): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  const approvalProof = optionalApprovalProof(value);
  if (
    identity === undefined ||
    !hasAllowedKeys(value, ["action", "actionId", "idempotencyKey", key, "approvalProof"]) ||
    !nonEmpty(value[key]) ||
    approvalProof.kind === "invalid"
  )
    return undefined;
  if (action === "command")
    return {
      ...identity,
      action,
      commandId: value[key],
      ...(approvalProof.kind === "present" ? { approvalProof: approvalProof.proof } : {}),
    };
  return {
    ...identity,
    action,
    verifierId: value[key],
    ...(approvalProof.kind === "present" ? { approvalProof: approvalProof.proof } : {}),
  };
}

/** A single explicit result shape: `optionalApprovalProof` always returns an object literal
 * discriminated on `kind`, instead of mixing an object payload with the `"invalid"` string
 * sentinel and a bare `undefined` "not supplied" signal. */
type ApprovalProofOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "present"; readonly proof: CodingToolApprovalProof };

function optionalApprovalProof(value: Record<string, unknown>): ApprovalProofOutcome {
  if (!Object.hasOwn(value, "approvalProof")) return { kind: "absent" };
  const proof = value.approvalProof;
  if (
    !isRecord(proof) ||
    !hasExactKeys(proof, ["approvalId", "approvalDigest"]) ||
    !nonEmpty(proof.approvalId) ||
    typeof proof.approvalDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(proof.approvalDigest)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "present",
    proof: { approvalId: proof.approvalId, approvalDigest: proof.approvalDigest },
  };
}

function simpleNamedRequest(
  value: Record<string, unknown>,
  key: "scope" | "target",
  action: "connector" | "egress",
): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (identity === undefined) return undefined;
  if (action === "egress") {
    return hasExactKeys(value, ["action", "actionId", "idempotencyKey", key]) &&
      nonEmpty(value[key])
      ? { ...identity, action, target: value[key] }
      : undefined;
  }
  // 3941816393: `connector`, unlike `egress`, can redeem a Workbench-issued approval proof.
  const approvalProof = optionalApprovalProof(value);
  if (
    !hasAllowedKeys(value, ["action", "actionId", "idempotencyKey", key, "approvalProof"]) ||
    !nonEmpty(value[key]) ||
    approvalProof.kind === "invalid"
  ) {
    return undefined;
  }
  return {
    ...identity,
    action,
    scope: value[key],
    ...(approvalProof.kind === "present" ? { approvalProof: approvalProof.proof } : {}),
  };
}

function gitRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (identity === undefined) return undefined;
  if (value.operation === "ci") return ciRequest(value, identity);
  const operation = value.operation;
  const simple = operation === "read" || operation === "write";
  if (!simple) return parseRuntimeGitRequest(value, identity);
  return hasExactKeys(value, ["action", "actionId", "idempotencyKey", "operation"])
    ? { ...identity, action: "git", operation }
    : undefined;
}

// #3388: the CI-observation tool's one optional argument. `forceFresh` stays a plain boolean
// (never a token/identifier) so it cannot smuggle anything the model does not already own.
function ciRequest(
  value: Record<string, unknown>,
  identity: CodingToolRequestIdentity,
): CodingToolActionRequest | undefined {
  // 3941816393: a "git ci" observation can redeem a Workbench-issued approval proof, same as
  // command/verification (see codingToolApprovalBridge.ts's ApprovableCiObservationRequest).
  const approvalProof = optionalApprovalProof(value);
  if (approvalProof.kind === "invalid") return undefined;
  const base = {
    ...identity,
    action: "git" as const,
    operation: "ci" as const,
    ...(approvalProof.kind === "present" ? { approvalProof: approvalProof.proof } : {}),
  };
  if (!Object.hasOwn(value, "forceFresh"))
    return hasAllowedKeys(value, [
      "action",
      "actionId",
      "idempotencyKey",
      "operation",
      "approvalProof",
    ])
      ? base
      : undefined;
  return hasAllowedKeys(value, [
    "action",
    "actionId",
    "idempotencyKey",
    "operation",
    "forceFresh",
    "approvalProof",
  ]) && typeof value.forceFresh === "boolean"
    ? { ...base, forceFresh: value.forceFresh }
    : undefined;
}

function deliveryRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (identity === undefined || !deliveryIntent(value.intent)) return undefined;
  if (value.phase === undefined)
    return hasExactKeys(value, ["action", "actionId", "idempotencyKey", "intent"])
      ? { ...identity, action: "delivery", intent: value.intent }
      : undefined;
  if (value.intent !== "commit") return parseDraftToolRequest(value, identity);
  if (value.phase === "propose") return commitProposalRequest(value, identity);
  return commitExecutionRequest(value, identity);
}
function commitExecutionRequest(
  value: Record<string, unknown>,
  identity: CodingToolRequestIdentity,
): CodingToolActionRequest | undefined {
  if (value.phase !== "execute" || !nonEmpty(value.proposalId)) return undefined;
  const approvalProof = optionalApprovalProof(value);
  if (
    approvalProof.kind === "invalid" ||
    !hasAllowedKeys(value, [
      "action",
      "actionId",
      "idempotencyKey",
      "intent",
      "phase",
      "proposalId",
      "approvalProof",
    ])
  )
    return undefined;
  return {
    ...identity,
    action: "delivery",
    intent: "commit",
    phase: "execute",
    proposalId: value.proposalId,
    ...(approvalProof.kind === "present" ? { approvalProof: approvalProof.proof } : {}),
  };
}
function commitProposalRequest(
  value: Record<string, unknown>,
  identity: CodingToolRequestIdentity,
): CodingToolActionRequest | undefined {
  if (
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", "intent", "phase", "message"]) ||
    !nonEmpty(value.message)
  )
    return undefined;
  if (Buffer.byteLength(value.message, "utf8") > 8192 || value.message.includes("\0"))
    return undefined;
  return {
    ...identity,
    action: "delivery",
    intent: "commit",
    phase: "propose",
    message: value.message,
  };
}

function requestIdentity(value: Record<string, unknown>): CodingToolRequestIdentity | undefined {
  return nonEmpty(value.actionId) && nonEmpty(value.idempotencyKey)
    ? { actionId: value.actionId, idempotencyKey: value.idempotencyKey }
    : undefined;
}

function normalizedRelativePath(value: unknown): value is string {
  return (
    nonEmpty(value) &&
    !value.includes("\0") &&
    // Colons are rejected wholesale: `C:/…` is drive-absolute under win32 resolution and
    // `file.txt:stream` names an NTFS alternate data stream — neither is workspace-relative.
    !value.includes(":") &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    value
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}
function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
  );
}
function deliveryIntent(value: unknown): value is "commit" | "push" | "pull-request" | "merge" {
  return value === "commit" || value === "push" || value === "pull-request" || value === "merge";
}
function positiveBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
