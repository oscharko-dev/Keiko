import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { MAX_RECURSIVE_TEXT_FILE_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

// #4457: the query-independent content layer keeps the redacted evidence-lane text of one file so
// a differently worded question can match it without reading and redacting the file again. Only
// the text the redacting read already produced enters this record; raw bytes never do.
export interface WorkspaceIndexRecordContent {
  readonly sha256: string;
  readonly bytes: number;
  readonly deflated: string;
}

// The redaction floor may lengthen a file slightly; four times the read cap bounds inflation.
export const MAX_WORKSPACE_INDEX_CONTENT_BYTES = 4 * MAX_RECURSIVE_TEXT_FILE_BYTES;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
// In unicode mode a paired surrogate is one code point, so this matches lone surrogates only.
const LONE_SURROGATE_RE = /\p{Cs}/u;

function textSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** UTF-8 cannot carry a lone surrogate; it would come back as U+FFFD. */
export function workspaceIndexContentIsEncodable(text: string): boolean {
  return !LONE_SURROGATE_RE.test(text);
}

export function encodeWorkspaceIndexContent(text: string): WorkspaceIndexRecordContent | undefined {
  // Such a text is not stored; the file is read live again instead.
  if (!workspaceIndexContentIsEncodable(text)) return undefined;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_WORKSPACE_INDEX_CONTENT_BYTES) return undefined;
  return {
    sha256: textSha256(bytes),
    bytes: bytes.byteLength,
    deflated: deflateRawSync(bytes, { level: 6 }).toString("base64"),
  };
}

/** Returns the stored text only when its size and digest prove it is the text that was stored. */
export function decodeWorkspaceIndexContent(
  content: WorkspaceIndexRecordContent,
): string | undefined {
  try {
    const bytes = inflateRawSync(Buffer.from(content.deflated, "base64"), {
      maxOutputLength: MAX_WORKSPACE_INDEX_CONTENT_BYTES,
    });
    if (bytes.byteLength !== content.bytes || textSha256(bytes) !== content.sha256)
      return undefined;
    return bytes.toString("utf8");
  } catch {
    // A corrupted or oversized payload is a cache miss; the caller reads the file live instead.
    return undefined;
  }
}

function wholeBytes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_WORKSPACE_INDEX_CONTENT_BYTES
  );
}

function matchingString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

export function normalizeWorkspaceIndexContent(
  value: unknown,
): WorkspaceIndexRecordContent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("sha256" in value && "bytes" in value && "deflated" in value)) return undefined;
  const { sha256, bytes, deflated } = value;
  if (!matchingString(sha256, SHA256_RE) || !wholeBytes(bytes)) return undefined;
  return matchingString(deflated, BASE64_RE) ? { sha256, bytes, deflated } : undefined;
}

function framed(hash: ReturnType<typeof createHash>, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  hash.update(`${String(encoded.byteLength)}:`);
  hash.update(encoded);
}

/**
 * The lane text depends on the redaction implementation, the content policy and the configured
 * secret literals. Any change to one of them yields another storage key, so a stored text can
 * never outlive the policy that produced it (a newly configured secret invalidates every entry).
 */
export function workspaceIndexContentPolicyFingerprint(
  redactionRevision: number,
  policy: string,
  secrets: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update("keiko-workspace-index:content-policy:v1\0");
  framed(hash, String(redactionRevision));
  framed(hash, policy);
  for (const secret of [...new Set(secrets)].sort(compareStrings)) framed(hash, secret);
  return hash.digest("hex");
}
