/**
 * Private wire format for the one-shot secure workspace helper.  This is deliberately
 * binary and closed: neither side accepts JSON, optional fields, or trailing bytes.
 */
export const SECURE_WORKSPACE_TEXT_READ_MAX_BYTES = 65_536;
export const SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES = 32_768;
export const SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES = 4_096;
export const SECURE_WORKSPACE_TEXT_READ_MAX_FRAME_BYTES =
  20 + SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES + SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES;

const REQUEST_MAGIC = Buffer.from("KSR1", "ascii");
const RESPONSE_MAGIC = Buffer.from("KSS1", "ascii");
const REQUEST_HEADER_BYTES = 20;
const RESPONSE_HEADER_BYTES = 12;
const VERSION = 1;

export type SecureWorkspaceReadClosedStatus =
  | "malformed-request"
  | "unsupported-platform"
  | "invalid-path"
  | "access-denied"
  | "not-regular"
  | "content-too-large"
  | "content-not-text"
  | "changed-during-read"
  | "io-failure";

export type SecureWorkspaceReadHelperResponse =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: SecureWorkspaceReadClosedStatus };

const STATUS_TO_CODE: Readonly<Record<SecureWorkspaceReadHelperResponse["status"], number>> = {
  ok: 0,
  "malformed-request": 1,
  "unsupported-platform": 2,
  "invalid-path": 3,
  "access-denied": 4,
  "not-regular": 5,
  "content-too-large": 6,
  "content-not-text": 7,
  "changed-during-read": 8,
  "io-failure": 9,
};

const CODE_TO_STATUS: Readonly<
  Record<number, SecureWorkspaceReadHelperResponse["status"] | undefined>
> = {
  0: "ok",
  1: "malformed-request",
  2: "unsupported-platform",
  3: "invalid-path",
  4: "access-denied",
  5: "not-regular",
  6: "content-too-large",
  7: "content-not-text",
  8: "changed-during-read",
  9: "io-failure",
};

export interface SecureWorkspaceReadHelperRequest {
  readonly root: string;
  readonly relativePath: string;
  readonly byteCap: number;
}

export function encodeSecureWorkspaceReadRequest(
  request: SecureWorkspaceReadHelperRequest,
): Buffer {
  const root = encodeBoundedUtf8(request.root, SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES);
  const relativePath = encodeBoundedUtf8(
    request.relativePath,
    SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES,
  );
  const maxBytes = request.byteCap;
  if (!Number.isInteger(maxBytes) || maxBytes !== SECURE_WORKSPACE_TEXT_READ_MAX_BYTES) {
    throw new Error("secure-workspace-read-invalid-request");
  }
  const frame = Buffer.allocUnsafe(
    REQUEST_HEADER_BYTES + root.byteLength + relativePath.byteLength,
  );
  REQUEST_MAGIC.copy(frame, 0);
  frame.writeUInt16LE(VERSION, 4);
  frame.writeUInt16LE(0, 6);
  frame.writeUInt32LE(root.byteLength, 8);
  frame.writeUInt32LE(relativePath.byteLength, 12);
  frame.writeUInt32LE(maxBytes, 16);
  root.copy(frame, REQUEST_HEADER_BYTES);
  relativePath.copy(frame, REQUEST_HEADER_BYTES + root.byteLength);
  return frame;
}

export function decodeSecureWorkspaceReadRequest(
  frame: Uint8Array,
): SecureWorkspaceReadHelperRequest {
  const bytes = Buffer.from(frame);
  if (
    bytes.byteLength < REQUEST_HEADER_BYTES ||
    bytes.byteLength > SECURE_WORKSPACE_TEXT_READ_MAX_FRAME_BYTES
  ) {
    throw new Error("secure-workspace-read-malformed-request");
  }
  if (!bytes.subarray(0, 4).equals(REQUEST_MAGIC))
    throw new Error("secure-workspace-read-malformed-request");
  const rootLength = bytes.readUInt32LE(8);
  const pathLength = bytes.readUInt32LE(12);
  const maxBytes = bytes.readUInt32LE(16);
  if (
    bytes.readUInt16LE(4) !== VERSION ||
    bytes.readUInt16LE(6) !== 0 ||
    rootLength > SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES ||
    pathLength > SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES ||
    maxBytes !== SECURE_WORKSPACE_TEXT_READ_MAX_BYTES ||
    REQUEST_HEADER_BYTES + rootLength + pathLength !== bytes.byteLength
  ) {
    throw new Error("secure-workspace-read-malformed-request");
  }
  return {
    root: decodeStrictUtf8(bytes.subarray(REQUEST_HEADER_BYTES, REQUEST_HEADER_BYTES + rootLength)),
    relativePath: decodeStrictUtf8(bytes.subarray(REQUEST_HEADER_BYTES + rootLength)),
    byteCap: maxBytes,
  };
}

export function encodeSecureWorkspaceReadResponse(
  response: SecureWorkspaceReadHelperResponse,
): Buffer {
  const payload = response.status === "ok" ? Buffer.from(response.bytes) : Buffer.alloc(0);
  if (payload.byteLength > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES) {
    throw new Error("secure-workspace-read-response-too-large");
  }
  const frame = Buffer.allocUnsafe(RESPONSE_HEADER_BYTES + payload.byteLength);
  RESPONSE_MAGIC.copy(frame, 0);
  frame.writeUInt16LE(VERSION, 4);
  frame.writeUInt16LE(STATUS_TO_CODE[response.status], 6);
  frame.writeUInt32LE(payload.byteLength, 8);
  payload.copy(frame, RESPONSE_HEADER_BYTES);
  return frame;
}

export function decodeSecureWorkspaceReadResponse(
  frame: Uint8Array,
): SecureWorkspaceReadHelperResponse {
  const bytes = Buffer.from(frame);
  if (
    bytes.byteLength < RESPONSE_HEADER_BYTES ||
    bytes.byteLength > RESPONSE_HEADER_BYTES + SECURE_WORKSPACE_TEXT_READ_MAX_BYTES
  ) {
    throw new Error("secure-workspace-read-malformed-response");
  }
  if (!bytes.subarray(0, 4).equals(RESPONSE_MAGIC))
    throw new Error("secure-workspace-read-malformed-response");
  const status = CODE_TO_STATUS[bytes.readUInt16LE(6)];
  const payloadLength = bytes.readUInt32LE(8);
  if (
    bytes.readUInt16LE(4) !== VERSION ||
    status === undefined ||
    payloadLength !== bytes.byteLength - RESPONSE_HEADER_BYTES
  ) {
    throw new Error("secure-workspace-read-malformed-response");
  }
  if (status !== "ok" && payloadLength !== 0)
    throw new Error("secure-workspace-read-malformed-response");
  return status === "ok" ? { status, bytes: bytes.subarray(RESPONSE_HEADER_BYTES) } : { status };
}

/** Strict UTF-8 plus source-text byte policy; response bytes never escape this transient boundary. */
// eslint-disable-next-line complexity
export function decodeSecureWorkspaceText(
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "not-text" } {
  if (bytes.byteLength > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)
    return { ok: false, reason: "not-text" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const codePoint of text) {
      const code = codePoint.codePointAt(0);
      if (
        code === undefined ||
        code === 0 ||
        (code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f)
      )
        return { ok: false, reason: "not-text" };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "not-text" };
  }
}

function encodeBoundedUtf8(value: string, limit: number): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > limit || bytes.includes(0)) {
    throw new Error("secure-workspace-read-invalid-request");
  }
  return bytes;
}

function decodeStrictUtf8(value: Uint8Array): string {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    if (decoded.length === 0 || decoded.includes("\0")) throw new Error("invalid");
    return decoded;
  } catch {
    throw new Error("secure-workspace-read-malformed-request");
  }
}
