import { basename } from "node:path";
import {
  SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT,
  SAFE_ARTIFACT_DIRECTORY_MUTATION_OPERATIONS,
  type SafeArtifactDirectoryMutationOperation,
  type SafeArtifactDirectoryMutationRequest,
} from "./safe-artifact-directory-mutation-protocol.js";

const DECIMAL_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const UNSUPPORTED_LINK_CODES = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

export interface SafeArtifactDirectoryMutationIo {
  readonly directoryMatches: (expectedDev: bigint, expectedIno: bigint) => boolean;
  readonly link: (source: string, target: string) => void;
  readonly unlink: (source: string) => void;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isMutationOperation(value: unknown): value is SafeArtifactDirectoryMutationOperation {
  return (
    typeof value === "string" &&
    (SAFE_ARTIFACT_DIRECTORY_MUTATION_OPERATIONS as readonly string[]).includes(value)
  );
}

function isSafeBasename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0") &&
    basename(value) === value
  );
}

function parseExpectedIdentity(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !DECIMAL_INTEGER_PATTERN.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function mapMutationFailure(
  operation: SafeArtifactDirectoryMutationOperation,
  error: unknown,
): number {
  const code = errorCode(error);
  if (operation === "link" && code === "EEXIST") {
    return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.targetExists;
  }
  if (operation === "link" && code !== undefined && UNSUPPORTED_LINK_CODES.has(code)) {
    return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported;
  }
  return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed;
}

function executeMutation(
  io: SafeArtifactDirectoryMutationIo,
  operation: SafeArtifactDirectoryMutationOperation,
  source: string,
  target: string | undefined,
): void {
  if (operation === "unlink") {
    io.unlink(source);
    return;
  }
  if (target === undefined) throw new TypeError("missing mutation target");
  io.link(source, target);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedRequest(value: unknown): SafeArtifactDirectoryMutationRequest | undefined {
  if (!isRecord(value)) return undefined;
  const expectedDev = parseExpectedIdentity(value.expectedDev);
  const expectedIno = parseExpectedIdentity(value.expectedIno);
  const source = value.source;
  const target = value.target;
  if (
    !isMutationOperation(value.operation) ||
    expectedDev === undefined ||
    expectedIno === undefined ||
    !isSafeBasename(source)
  ) {
    return undefined;
  }
  const identity = { expectedDev: expectedDev.toString(), expectedIno: expectedIno.toString() };
  if (value.operation === "link") {
    if (!isSafeBasename(target)) return undefined;
    return { operation: value.operation, ...identity, source, target };
  }
  if (target !== undefined) return undefined;
  return { operation: value.operation, ...identity, source };
}

export function runSafeArtifactDirectoryMutation(
  value: unknown,
  io: SafeArtifactDirectoryMutationIo,
): number {
  const request = parsedRequest(value);
  if (request === undefined) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.invalidInput;
  const expectedDev = BigInt(request.expectedDev);
  const expectedIno = BigInt(request.expectedIno);
  if (!io.directoryMatches(expectedDev, expectedIno)) {
    return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.directoryMismatch;
  }
  try {
    executeMutation(io, request.operation, request.source, request.target);
  } catch (error) {
    return mapMutationFailure(request.operation, error);
  }
  return io.directoryMatches(expectedDev, expectedIno)
    ? SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success
    : SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.directoryMismatch;
}
