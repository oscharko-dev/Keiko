/**
 * Private wire format for the one-shot secure workspace helper.  This is deliberately
 * binary and closed: neither side accepts JSON, optional fields, or trailing bytes.
 */
export const SECURE_WORKSPACE_TEXT_READ_MAX_BYTES = 1_048_576;
export const SECURE_WORKSPACE_TEXT_READ_LEGACY_MAX_BYTES = 65_536;
export const SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES = 32_768;
export const SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES = 4_096;
export const SECURE_WORKSPACE_TEXT_READ_MAX_FRAME_BYTES =
  20 + SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES + SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES;

const REQUEST_MAGIC = Buffer.from("KSR1", "ascii");
const RESPONSE_MAGIC = Buffer.from("KSS1", "ascii");
const REQUEST_HEADER_BYTES = 20;
const RESPONSE_HEADER_BYTES = 12;
export const SECURE_WORKSPACE_TEXT_READ_MAX_RESPONSE_BYTES =
  RESPONSE_HEADER_BYTES + SECURE_WORKSPACE_TEXT_READ_MAX_BYTES;
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
  let root: Buffer | undefined;
  let relativePath: Buffer | undefined;
  try {
    root = encodeBoundedUtf8(request.root, SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES);
    relativePath = encodeBoundedUtf8(
      request.relativePath,
      SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES,
    );
    const maxBytes = request.byteCap;
    if (!isSecureWorkspaceReadByteCap(maxBytes)) {
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
  } finally {
    root?.fill(0);
    relativePath?.fill(0);
  }
}

export function decodeSecureWorkspaceReadRequest(
  frame: Uint8Array,
): SecureWorkspaceReadHelperRequest {
  const bytes = bufferView(frame);
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
    !isSecureWorkspaceReadByteCap(maxBytes) ||
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
  const bytes = bufferView(frame);
  if (
    bytes.byteLength < RESPONSE_HEADER_BYTES ||
    bytes.byteLength > SECURE_WORKSPACE_TEXT_READ_MAX_RESPONSE_BYTES
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
  preserveBom = false,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "not-text" } {
  if (bytes.byteLength > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)
    return { ok: false, reason: "not-text" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
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

export function isSecureWorkspaceReadByteCap(value: number): boolean {
  return (
    value === SECURE_WORKSPACE_TEXT_READ_MAX_BYTES ||
    value === SECURE_WORKSPACE_TEXT_READ_LEGACY_MAX_BYTES
  );
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
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    if (decoded.length === 0 || decoded.includes("\0")) throw new Error("invalid");
    return decoded;
  } catch {
    throw new Error("secure-workspace-read-malformed-request");
  }
}

function bufferView(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Same-descriptor facts for the bounded regular text file; no path or content is metadata. */
export interface SecureWorkspaceTextSnapshotInfo {
  readonly type: "file";
  readonly size: number;
  readonly mtimeMs: number;
}

export type SecureWorkspaceSnapshotHelperResponse =
  | {
      readonly status: "ok";
      readonly bytes: Uint8Array;
      readonly info: SecureWorkspaceTextSnapshotInfo;
    }
  | { readonly status: SecureWorkspaceReadClosedStatus };

const SNAPSHOT_METADATA_BYTES = 16;
export const SECURE_WORKSPACE_TEXT_SNAPSHOT_MAX_RESPONSE_BYTES =
  SECURE_WORKSPACE_TEXT_READ_MAX_RESPONSE_BYTES + SNAPSHOT_METADATA_BYTES;

export function encodeSecureWorkspaceSnapshotRequest(
  request: SecureWorkspaceReadHelperRequest,
): Buffer {
  if (request.byteCap !== SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)
    throw new Error("secure-workspace-read-invalid-request");
  const frame = encodeSecureWorkspaceReadRequest(request);
  frame.write("KSR2", 0, "ascii");
  frame.writeUInt16LE(2, 4);
  return frame;
}

export function encodeSecureWorkspaceSnapshotResponse(
  response: SecureWorkspaceSnapshotHelperResponse,
): Buffer {
  const base = encodeSecureWorkspaceReadResponse(response);
  base.write("KSS2", 0, "ascii");
  base.writeUInt16LE(2, 4);
  if (response.status !== "ok") return base;
  assertSnapshotInfo(response.info, response.bytes.byteLength);
  const metadata = Buffer.alloc(SNAPSHOT_METADATA_BYTES);
  metadata.writeBigUInt64LE(BigInt(response.info.size), 0);
  metadata.writeDoubleLE(response.info.mtimeMs, 8);
  base.writeUInt32LE(response.bytes.byteLength + SNAPSHOT_METADATA_BYTES, 8);
  return Buffer.concat([
    base.subarray(0, RESPONSE_HEADER_BYTES),
    metadata,
    base.subarray(RESPONSE_HEADER_BYTES),
  ]);
}

export function decodeSecureWorkspaceSnapshotResponse(
  frame: Uint8Array,
): SecureWorkspaceSnapshotHelperResponse {
  const bytes = bufferView(frame);
  if (
    bytes.byteLength < RESPONSE_HEADER_BYTES ||
    bytes.byteLength > SECURE_WORKSPACE_TEXT_SNAPSHOT_MAX_RESPONSE_BYTES ||
    bytes.subarray(0, 4).toString("ascii") !== "KSS2" ||
    bytes.readUInt16LE(4) !== 2
  )
    throw new Error("secure-workspace-read-malformed-response");
  const status = CODE_TO_STATUS[bytes.readUInt16LE(6)];
  if (status === undefined || bytes.readUInt32LE(8) !== bytes.byteLength - RESPONSE_HEADER_BYTES)
    throw new Error("secure-workspace-read-malformed-response");
  if (status !== "ok") {
    if (bytes.byteLength !== RESPONSE_HEADER_BYTES)
      throw new Error("secure-workspace-read-malformed-response");
    return { status };
  }
  if (bytes.byteLength < RESPONSE_HEADER_BYTES + SNAPSHOT_METADATA_BYTES)
    throw new Error("secure-workspace-read-malformed-response");
  const content = bytes.subarray(RESPONSE_HEADER_BYTES + SNAPSHOT_METADATA_BYTES);
  const info: SecureWorkspaceTextSnapshotInfo = {
    type: "file",
    size: Number(bytes.readBigUInt64LE(12)),
    mtimeMs: bytes.readDoubleLE(20),
  };
  assertSnapshotInfo(info, content.byteLength);
  return { status, bytes: content, info: Object.freeze(info) };
}

function assertSnapshotInfo(info: SecureWorkspaceTextSnapshotInfo, byteLength: number): void {
  if (
    !snapshotFileType(info.type) ||
    !Number.isSafeInteger(info.size) ||
    info.size < 0 ||
    info.size !== byteLength ||
    info.size > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES ||
    !Number.isFinite(info.mtimeMs)
  )
    throw new Error("secure-workspace-read-malformed-response");
}

function snapshotFileType(type: unknown): boolean {
  return type === "file";
}

/** Path scope of the descriptor helper's KSR_MAX_COMPONENTS, independent of process capacity. */
export const SECURE_WORKSPACE_NATIVE_MAX_PATH_COMPONENTS = 64;

/** Inactive native file lane: the original process-backed Files contract collects at most 64 MiB. */
export const SECURE_WORKSPACE_NATIVE_MAX_BYTES = 64 * 1_024 * 1_024;
export const SECURE_WORKSPACE_NATIVE_MAX_RESPONSE_BYTES = SECURE_WORKSPACE_NATIVE_MAX_BYTES + 32;
const NATIVE_REQUEST_BYTES = 36;
const NATIVE_INFO_BYTES = 20;
const NATIVE_TYPES = ["file", "directory", "symlink", "other"] as const;
export type SecureWorkspaceNativeFileType = (typeof NATIVE_TYPES)[number];
export interface SecureWorkspaceNativeFileInfo {
  readonly type: SecureWorkspaceNativeFileType;
  readonly size: number;
  readonly mtimeMs: number;
}
export interface SecureWorkspaceNativeDirEntry {
  readonly name: string;
  readonly type: SecureWorkspaceNativeFileType;
}
export type SecureWorkspaceNativeRequest = {
  readonly root: string;
  readonly relativePath: string;
} & (
  | {
      readonly operation: "read";
      readonly range?: { readonly offset: number; readonly length: number };
    }
  | { readonly operation: "stat" }
  | { readonly operation: "list" }
);
export type SecureWorkspaceNativeResponse =
  | {
      readonly status: "ok";
      readonly info: SecureWorkspaceNativeFileInfo;
      readonly bytes: Uint8Array;
    }
  | { readonly status: "wrong-kind"; readonly info: SecureWorkspaceNativeFileInfo }
  | { readonly status: SecureWorkspaceReadClosedStatus };

export function encodeSecureWorkspaceNativeRequest(request: SecureWorkspaceNativeRequest): Buffer {
  const root = encodeBoundedUtf8(request.root, SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES);
  const path = Buffer.from(request.relativePath, "utf8");
  try {
    if (
      path.byteLength > SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES ||
      path.includes(0) ||
      path.toString("utf8") !== request.relativePath ||
      root.toString("utf8") !== request.root
    )
      throw new Error("secure-workspace-read-invalid-request");
    const range = request.operation === "read" ? request.range : undefined;
    assertNativeRange(range);
    const frame = Buffer.alloc(NATIVE_REQUEST_BYTES + root.length + path.length);
    frame.write("KSR3", 0, "ascii");
    frame.writeUInt16LE(3, 4);
    frame.writeUInt16LE(nativeOperationCode(request), 6);
    frame.writeUInt32LE(root.length, 8);
    frame.writeUInt32LE(path.length, 12);
    frame.writeUInt32LE(SECURE_WORKSPACE_NATIVE_MAX_BYTES, 16);
    frame.writeBigUInt64LE(BigInt(range?.offset ?? 0), 20);
    frame.writeBigUInt64LE(BigInt(range?.length ?? 0), 28);
    root.copy(frame, NATIVE_REQUEST_BYTES);
    path.copy(frame, NATIVE_REQUEST_BYTES + root.length);
    return frame;
  } finally {
    root.fill(0);
    path.fill(0);
  }
}

function nativeOperationCode(request: SecureWorkspaceNativeRequest): number {
  if (request.operation === "stat") return 3;
  if (request.operation === "list") return 4;
  return request.range === undefined ? 1 : 2;
}

function assertNativeRange(
  range: { readonly offset: number; readonly length: number } | undefined,
): void {
  if (range === undefined) return;
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.length) ||
    range.length < 0 ||
    range.length > SECURE_WORKSPACE_NATIVE_MAX_BYTES ||
    !Number.isSafeInteger(range.offset + range.length)
  )
    throw new Error("secure-workspace-read-invalid-request");
}

export function decodeSecureWorkspaceNativeResponse(
  frame: Uint8Array,
): SecureWorkspaceNativeResponse {
  const bytes = bufferView(frame);
  assertNativeResponseHeader(bytes);
  const code = bytes.readUInt16LE(6);
  if (code !== 0 && code !== 10) return nativeFailureResponse(bytes, code);
  if (bytes.length < RESPONSE_HEADER_BYTES + NATIVE_INFO_BYTES)
    throw new Error("secure-workspace-read-malformed-response");
  const info = nativeInfo(bytes);
  const content = bytes.subarray(RESPONSE_HEADER_BYTES + NATIVE_INFO_BYTES);
  if (code === 10) {
    if (content.length !== 0) throw new Error("secure-workspace-read-malformed-response");
    return { status: "wrong-kind", info };
  }
  return { status: "ok", info, bytes: content };
}

function nativeFailureResponse(bytes: Buffer, code: number): SecureWorkspaceNativeResponse {
  const status = CODE_TO_STATUS[code];
  if (status === undefined || status === "ok" || bytes.length !== RESPONSE_HEADER_BYTES)
    throw new Error("secure-workspace-read-malformed-response");
  return { status };
}

function nativeInfo(bytes: Buffer): SecureWorkspaceNativeFileInfo {
  const type = NATIVE_TYPES[bytes.readUInt16LE(12) - 1];
  const size = Number(bytes.readBigUInt64LE(16));
  const mtimeMs = bytes.readDoubleLE(24);
  if (
    type === undefined ||
    bytes.readUInt16LE(14) !== 0 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isFinite(mtimeMs)
  )
    throw new Error("secure-workspace-read-malformed-response");
  return Object.freeze({ type, size, mtimeMs });
}

export function decodeSecureWorkspaceNativeDirectory(
  bytes: Uint8Array,
): readonly SecureWorkspaceNativeDirEntry[] {
  const frame = bufferView(bytes);
  if (frame.length < 4) throw new Error("secure-workspace-read-malformed-response");
  const count = frame.readUInt32LE(0);
  if (count > Math.floor((frame.length - 4) / 6))
    throw new Error("secure-workspace-read-malformed-response");
  const entries: SecureWorkspaceNativeDirEntry[] = [];
  const names = new Set<string>();
  let offset = 4;
  for (let index = 0; index < count; index++) {
    const entry = nativeDirectoryEntry(frame, offset);
    if (names.has(entry.value.name)) throw new Error("secure-workspace-read-malformed-response");
    names.add(entry.value.name);
    entries.push(entry.value);
    offset = entry.end;
  }
  if (offset !== frame.length) throw new Error("secure-workspace-read-malformed-response");
  return Object.freeze(entries);
}

function nativeDirectoryEntry(
  frame: Buffer,
  offset: number,
): {
  readonly value: SecureWorkspaceNativeDirEntry;
  readonly end: number;
} {
  if (offset + 5 > frame.length) throw new Error("secure-workspace-read-malformed-response");
  const type = NATIVE_TYPES[frame.readUInt8(offset) - 1];
  const end = offset + 5 + frame.readUInt32LE(offset + 1);
  if (type === undefined || end > frame.length)
    throw new Error("secure-workspace-read-malformed-response");
  const name = decodeStrictUtf8(frame.subarray(offset + 5, end));
  if (name === "." || name === ".." || name.includes("/"))
    throw new Error("secure-workspace-read-malformed-response");
  return { value: Object.freeze({ name, type }), end };
}

function assertNativeResponseHeader(bytes: Buffer): void {
  if (
    bytes.length < RESPONSE_HEADER_BYTES ||
    bytes.length > SECURE_WORKSPACE_NATIVE_MAX_RESPONSE_BYTES ||
    bytes.subarray(0, 4).toString("ascii") !== "KSS3" ||
    bytes.readUInt16LE(4) !== 3 ||
    bytes.readUInt32LE(8) !== bytes.length - RESPONSE_HEADER_BYTES
  )
    throw new Error("secure-workspace-read-malformed-response");
}

/** The same canonical helper response, reused by inactive authenticated native IO delivery. */
export function encodeSecureWorkspaceNativeResponse(
  response: SecureWorkspaceNativeResponse,
): Buffer {
  const hasInfo = response.status === "ok" || response.status === "wrong-kind";
  const payload = response.status === "ok" ? response.bytes : new Uint8Array();
  if (payload.byteLength > SECURE_WORKSPACE_NATIVE_MAX_BYTES)
    throw new TypeError("secure-workspace-read-response-too-large");
  const frame = Buffer.alloc(
    RESPONSE_HEADER_BYTES + (hasInfo ? NATIVE_INFO_BYTES : 0) + payload.byteLength,
  );
  frame.write("KSS3", 0, "ascii");
  frame.writeUInt16LE(3, 4);
  frame.writeUInt16LE(response.status === "wrong-kind" ? 10 : STATUS_TO_CODE[response.status], 6);
  frame.writeUInt32LE(frame.length - RESPONSE_HEADER_BYTES, 8);
  if (hasInfo) writeNativeInfo(frame, response.info);
  if (response.status === "ok") frame.set(payload, RESPONSE_HEADER_BYTES + NATIVE_INFO_BYTES);
  decodeSecureWorkspaceNativeResponse(frame);
  return frame;
}

function writeNativeInfo(frame: Buffer, info: SecureWorkspaceNativeFileInfo): void {
  const code = NATIVE_TYPES.indexOf(info.type) + 1;
  if (
    code === 0 ||
    !Number.isSafeInteger(info.size) ||
    info.size < 0 ||
    !Number.isFinite(info.mtimeMs)
  )
    throw new TypeError("secure-workspace-read-invalid-info");
  frame.writeUInt16LE(code, 12);
  frame.writeBigUInt64LE(BigInt(info.size), 16);
  frame.writeDoubleLE(info.mtimeMs, 24);
}

export function encodeSecureWorkspaceNativeDirectory(
  entries: readonly SecureWorkspaceNativeDirEntry[],
): Buffer {
  let size = 4;
  for (const entry of entries) {
    size += 5 + Buffer.byteLength(entry.name, "utf8");
    if (size > SECURE_WORKSPACE_NATIVE_MAX_BYTES)
      throw new TypeError("secure-workspace-read-response-too-large");
  }
  const frame = Buffer.alloc(size);
  frame.writeUInt32LE(entries.length, 0);
  let offset = 4;
  for (const entry of entries) {
    const code = NATIVE_TYPES.indexOf(entry.type) + 1;
    if (code === 0) throw new TypeError("secure-workspace-read-invalid-info");
    frame.writeUInt8(code, offset);
    const length = Buffer.byteLength(entry.name, "utf8");
    frame.writeUInt32LE(length, offset + 1);
    frame.write(entry.name, offset + 5, length, "utf8");
    if (frame.subarray(offset + 5, offset + 5 + length).toString("utf8") !== entry.name) {
      frame.fill(0);
      throw new TypeError("secure-workspace-read-invalid-name");
    }
    offset += 5 + length;
  }
  decodeSecureWorkspaceNativeDirectory(frame);
  return frame;
}
