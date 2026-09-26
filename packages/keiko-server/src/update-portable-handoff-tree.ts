import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  hashPortableTreeKht1,
  PortableTreeAttestationError,
} from "@oscharko-dev/keiko-security/portable-tree-attestation";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const BUFFER_BYTES = 64 * 1024;

export const PORTABLE_HANDOFF_TREE_HASH_SCHEMA = "KHT1";

export interface PortableHandoffOperationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadline: number;
  readonly now?: (() => number) | undefined;
  readonly yieldControl?: (() => Promise<void>) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export interface PortableHandoffOperation {
  readonly signal: AbortSignal | undefined;
  readonly deadline: number;
  readonly now: () => number;
  readonly yieldControl: () => Promise<void>;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export class PortableHandoffBuilderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortableHandoffBuilderError";
  }
}

function fail(message: string): never {
  throw new PortableHandoffBuilderError(message);
}

function defaultYieldControl(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export function portableHandoffOperationFrom(
  options: PortableHandoffOperationOptions,
): PortableHandoffOperation {
  if (!Number.isSafeInteger(options.deadline) || options.deadline < 1) {
    fail("portable handoff operation deadline is invalid");
  }
  return {
    signal: options.signal,
    deadline: options.deadline,
    now: options.now ?? Date.now,
    yieldControl: options.yieldControl ?? defaultYieldControl,
    ...(options.securityLogSink === undefined ? {} : { securityLogSink: options.securityLogSink }),
  };
}

export function assertPortableHandoffOperation(operation: PortableHandoffOperation): void {
  if (operation.signal?.aborted === true) fail("portable handoff preparation was cancelled");
  if (operation.now() > operation.deadline) fail("portable handoff preparation timed out");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertOpenedFile(before: Stats, opened: Stats, maximumBytes: number): void {
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !opened.isFile() ||
    opened.nlink !== 1 ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    opened.size > maximumBytes
  ) {
    fail("portable handoff artifact is unsafe");
  }
}

async function readFileDigest(
  handle: FileHandle,
  expectedSize: number,
  maximumBytes: number,
  operation: PortableHandoffOperation,
): Promise<{ readonly bytes: number; readonly digest: Buffer }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  let bytes = 0;
  let reads = 0;
  for (;;) {
    assertPortableHandoffOperation(operation);
    const result = await handle.read(buffer, 0, buffer.length, null);
    if (result.bytesRead === 0) return { bytes, digest: hash.digest() };
    bytes += result.bytesRead;
    if (bytes > expectedSize || bytes > maximumBytes) fail("portable handoff artifact changed");
    hash.update(buffer.subarray(0, result.bytesRead));
    reads += 1;
    if (reads % 64 === 0) await operation.yieldControl();
  }
}

function assertStableFile(opened: Stats, after: Stats, current: Stats, bytes: number): void {
  if (
    bytes !== opened.size ||
    !after.isFile() ||
    after.nlink !== 1 ||
    !sameFileIdentity(after, opened) ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    !sameFileIdentity(current, opened)
  ) {
    fail("portable handoff artifact changed");
  }
}

export async function digestPortableHandoffFile(
  path: string,
  operation: PortableHandoffOperation,
  maximumBytes = MAX_FILE_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_FILE_BYTES) {
    fail("portable handoff artifact byte limit is invalid");
  }
  assertPortableHandoffOperation(operation);
  const before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertOpenedFile(before, opened, maximumBytes);
    const result = await readFileDigest(handle, opened.size, maximumBytes, operation);
    assertStableFile(opened, await handle.stat(), await lstat(path), result.bytes);
    return result.digest;
  } finally {
    await handle.close();
  }
}

export async function hashPortableHandoffTree(
  root: string,
  options: PortableHandoffOperationOptions,
): Promise<string> {
  const operation = portableHandoffOperationFrom(options);
  try {
    return await hashPortableTreeKht1(root, operation);
  } catch (error) {
    if (error instanceof PortableTreeAttestationError) fail(error.message);
    throw error;
  }
}
