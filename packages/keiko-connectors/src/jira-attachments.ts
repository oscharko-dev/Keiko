import {
  JIRA_ATTACHMENT_MAX_BYTES,
  JIRA_ATTACHMENT_SOURCE_KINDS,
  isJiraAttachmentName,
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { AtlassianHttpUpload } from "./atlassian-http-port.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

/**
 * Attaching a file to an issue (#4176). The bytes never come from a path the model names: the
 * composing owner supplies a source port that reads only what Keiko already governs, and this
 * module only shapes, bounds and verifies the Jira side — the multipart envelope, the instance's
 * own upload limit, and the readback of the stored attachment's id, name and size.
 */

/** What the composing owner returns for a source reference: the bytes and the name they carry. */
export interface JiraAttachmentContent {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
export type JiraAttachmentSourceResult =
  | { readonly ok: true; readonly content: JiraAttachmentContent }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly detail?: JiraMutationFailureDetail;
    };
export interface JiraAttachmentSourceRequest {
  readonly kind: (typeof JIRA_ATTACHMENT_SOURCE_KINDS)[number];
  /** Relative to a root the owner already governs; the owner re-validates containment. */
  readonly path: string;
  /** The name to attach under; the source's own file name when absent. */
  readonly name?: string;
  readonly maxBytes: number;
}
/** Read one governed source. The owner enforces containment, deny-lists, size and currentness. */
export type JiraAttachmentSource = (
  request: JiraAttachmentSourceRequest,
) => Promise<JiraAttachmentSourceResult>;

export interface JiraAttachmentArguments {
  readonly issueKey: string;
  readonly path: string;
  readonly name?: string;
}
type Failure = Extract<JiraMutationAttempt, { ok: false }>;
const INVALID = { ok: false, reason: "field-validation" } as const;
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
const CONFLICT = { ok: false, reason: "conflict" } as const;

function sourceInput(value: unknown): string | undefined {
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).sort(compareStrings).join() !== "kind,path")
    return undefined;
  const kinds: readonly unknown[] = JIRA_ATTACHMENT_SOURCE_KINDS;
  return kinds.includes(raw.kind) && isPortableWorkspaceRelativePath(raw.path)
    ? raw.path
    : undefined;
}
/** Exactly the allowed keys; a missing or malformed part refuses the whole request. */
export function parseJiraAttachmentArguments(
  args: CatalogJsonObject,
): JiraAttachmentArguments | undefined {
  const allowed = new Set(["issueKey", "source", "name"]);
  const path = sourceInput(args.source);
  if (
    !Object.keys(args).every((key) => allowed.has(key)) ||
    !isSafeAtlassianIdentifier(args.issueKey) ||
    path === undefined ||
    (args.name !== undefined && !isJiraAttachmentName(args.name))
  )
    return undefined;
  return {
    issueKey: args.issueKey,
    path,
    ...(typeof args.name === "string" ? { name: args.name } : {}),
  };
}

const ENCODER = new TextEncoder();
/** A boundary derived from the content digest that the content itself does not contain. */
function boundaryFor(content: JiraAttachmentContent): string {
  const body = Buffer.from(content.bytes.buffer, content.bytes.byteOffset, content.bytes.length);
  for (let attempt = 0; ; attempt += 1) {
    const boundary = `keiko-${createHash("sha256")
      .update(`${content.sha256}:${String(attempt)}`)
      .digest("hex")
      .slice(0, 40)}`;
    if (!body.includes(boundary)) return boundary;
  }
}
/** The name every header parser reads: printable ASCII only. */
export function jiraAttachmentAsciiName(name: string): string {
  return name.replaceAll(/[^\u0020-\u007e]/gu, "_");
}
/** RFC 5987 `UTF-8''` value: everything but attr-char is percent-encoded. */
function extendedFilename(name: string): string {
  return encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (character) => `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
}
function dispositionFor(name: string): string {
  const ascii = jiraAttachmentAsciiName(name);
  return ascii === name
    ? `filename="${name}"`
    : `filename="${ascii}"; filename*=UTF-8''${extendedFilename(name)}`;
}
/**
 * One `file` part, the shape Jira's attachment endpoint documents. A name outside ASCII travels as
 * an ASCII-sanitized `filename` plus the RFC 5987 `filename*`; whether Jira honours the extended
 * form is not assumed — the readback accepts either spelling of the stored name.
 */
export function jiraAttachmentUpload(
  content: JiraAttachmentContent,
  name: string,
): AtlassianHttpUpload {
  const boundary = boundaryFor(content);
  const head = ENCODER.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; ${dispositionFor(name)}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = ENCODER.encode(`\r\n--${boundary}--\r\n`);
  const bytes = new Uint8Array(head.length + content.bytes.length + tail.length);
  bytes.set(head, 0);
  bytes.set(content.bytes, head.length);
  bytes.set(tail, head.length + content.bytes.length);
  return { contentType: `multipart/form-data; boundary=${boundary}`, bytes };
}

/** The instance's own attachment switch and limit; Keiko's ceiling can only lower it. */
export async function jiraAttachmentLimit(
  request: JiraMutationRequest,
): Promise<{ readonly ok: true; readonly maxBytes: number } | Failure> {
  const response = await request("attachment/meta");
  if (!response.ok) return { ok: false, reason: response.reason };
  const body = response.body;
  const limit = body?.uploadLimit;
  if (response.status !== 200 || body === undefined || typeof body.enabled !== "boolean")
    return MALFORMED;
  if (!body.enabled) return { ok: false, reason: "unavailable" };
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) return MALFORMED;
  return { ok: true, maxBytes: Math.min(limit, JIRA_ATTACHMENT_MAX_BYTES) };
}

/** Jira answers an upload with the stored attachments; ours is the one new entry of this size. */
function createdAttachmentId(
  items: readonly unknown[] | undefined,
  size: number,
): string | undefined {
  if (items?.length !== 1) return undefined;
  const raw = asRecord(items[0]);
  return raw !== undefined && isSafeAtlassianIdentifier(raw.id) && raw.size === size
    ? raw.id
    : undefined;
}
/** A refused request keeps its closed reason and Jira's bounded explanation, never the HTTP outcome. */
function requestFailure(response: Extract<AtlassianWriteHttpOutcome, { ok: false }>): Failure {
  return {
    ok: false,
    reason: response.reason,
    ...(response.remote === undefined ? {} : { detail: response.remote }),
  };
}
interface StoredAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}
/**
 * The readback confirms that Jira holds an attachment with this id, name and size on the issue. It
 * does not read the stored bytes back, so it proves Jira's record, not byte equality. The name may
 * be spelled as sent or in its ASCII-sanitized form (Jira's handling of `filename*` is not assumed).
 */
async function readbackAttachment(
  request: JiraMutationRequest,
  issueKey: string,
  expected: StoredAttachment,
): Promise<JiraMutationAttempt> {
  const response = await request(`issue/${encodeURIComponent(issueKey)}?fields=attachment`);
  if (!response.ok) return requestFailure(response);
  const attachments = asArray(asRecord(response.body?.fields)?.attachment);
  if (response.status !== 200 || attachments === undefined) return MALFORMED;
  const stored = attachments
    .map((value) => asRecord(value))
    .find((value) => value?.id === expected.id);
  const names = [expected.name, jiraAttachmentAsciiName(expected.name)];
  const matches =
    stored?.size === expected.size &&
    typeof stored.filename === "string" &&
    names.includes(stored.filename);
  return matches ? { ok: true, receipt: { issueKey, attachmentId: expected.id } } : CONFLICT;
}

export interface JiraAttachDispatch {
  readonly issueKey: string;
  readonly content: JiraAttachmentContent;
  readonly name: string;
}
/** POST once, then confirm by direct readback; a lost response is never sent again. */
export async function dispatchJiraAttachment(
  request: JiraMutationRequest,
  input: JiraAttachDispatch,
): Promise<JiraMutationAttempt> {
  const { issueKey, content, name } = input;
  const response = await request(
    `issue/${encodeURIComponent(issueKey)}/attachments`,
    "POST",
    undefined,
    "json-array",
    jiraAttachmentUpload(content, name),
  );
  if (!response.ok) return requestFailure(response);
  const size = content.bytes.length;
  const id = createdAttachmentId(response.items, size);
  return response.status === 200 && id !== undefined
    ? readbackAttachment(request, issueKey, { id, name, size })
    : MALFORMED;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
/**
 * The source's bounds, name and digest shape are checked before a single byte is sent. The digest
 * is computed once, by the source that read the bytes; it is not recomputed here.
 */
export function verifiedJiraAttachmentContent(
  content: JiraAttachmentContent,
  maxBytes: number,
): Failure | undefined {
  if (
    content.bytes.length === 0 ||
    content.bytes.length > maxBytes ||
    content.bytes.length > JIRA_ATTACHMENT_MAX_BYTES
  )
    return { ok: false, reason: "bounds-exceeded" };
  return SHA256_HEX.test(content.sha256) && isJiraAttachmentName(content.name)
    ? undefined
    : INVALID;
}
