import { isUtf8 } from "node:buffer";

import {
  isCodeTaskSkillId,
  isEditorAgentChangeset,
  type AuxiliaryCapabilityOutcomeV1,
  type EditorAgentChangeset,
} from "@oscharko-dev/keiko-contracts";
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
      readonly action: "edit";
      readonly changeset: EditorAgentChangeset;
    })
  | (CodingToolRequestIdentity & { readonly action: "command"; readonly commandId: string })
  | (CodingToolRequestIdentity & { readonly action: "verification"; readonly verifierId: string })
  | (CodingToolRequestIdentity & { readonly action: "git"; readonly operation: "read" | "write" })
  | (CodingToolRequestIdentity & {
      readonly action: "delivery";
      readonly intent: "commit" | "push" | "pull-request" | "merge";
    })
  | (CodingToolRequestIdentity & { readonly action: "connector"; readonly scope: string })
  | (CodingToolRequestIdentity & { readonly action: "egress"; readonly target: string })
  | (CodingToolRequestIdentity & { readonly action: "skill"; readonly skillId: string })
  | (CodingToolRequestIdentity & {
      readonly action: "child-agent";
      readonly objective: string;
      readonly maxToolCalls: number;
    });

export type CodingToolResult =
  | {
      readonly status: "completed";
      readonly evidence: readonly CodingToolEvidence[];
      readonly read: CodingToolReadResult | CodingToolEgressReadResult;
    }
  | { readonly status: "completed" | "failed"; readonly evidence: readonly CodingToolEvidence[] }
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
    case "edit":
      return editRequest(value);
    case "command":
      return namedRequest(value, "commandId", "command");
    case "verification":
      return namedRequest(value, "verifierId", "verification");
    case "git":
      return gitRequest(value);
    case "delivery":
      return deliveryRequest(value);
    case "connector":
      return namedRequest(value, "scope", "connector");
    case "egress":
      return namedRequest(value, "target", "egress");
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

function namedRequest(
  value: Record<string, unknown>,
  key: "commandId" | "verifierId" | "scope" | "target",
  action: "command" | "verification" | "connector" | "egress",
): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (
    identity === undefined ||
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", key]) ||
    !nonEmpty(value[key])
  )
    return undefined;
  if (action === "command") return { ...identity, action, commandId: value[key] };
  if (action === "verification") return { ...identity, action, verifierId: value[key] };
  return action === "connector"
    ? { ...identity, action, scope: value[key] }
    : { ...identity, action, target: value[key] };
}

function gitRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  return identity !== undefined &&
    hasExactKeys(value, ["action", "actionId", "idempotencyKey", "operation"]) &&
    (value.operation === "read" || value.operation === "write")
    ? { ...identity, action: "git", operation: value.operation }
    : undefined;
}

function deliveryRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  return identity !== undefined &&
    hasExactKeys(value, ["action", "actionId", "idempotencyKey", "intent"]) &&
    deliveryIntent(value.intent)
    ? { ...identity, action: "delivery", intent: value.intent }
    : undefined;
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
