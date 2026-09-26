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
  readonly entryMatches: (name: string, expectedDev: bigint, expectedIno: bigint) => boolean;
  readonly link: (source: string, target: string) => void;
  readonly rename: (source: string, target: string) => void;
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
  if (operation === "link") io.link(source, target);
  else io.rename(source, target);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MutationRequestCommon = Omit<SafeArtifactDirectoryMutationRequest, "target">;

function parsedCommon(value: Readonly<Record<string, unknown>>): MutationRequestCommon | undefined {
  const expectedDev = parseExpectedIdentity(value.expectedDev);
  const expectedIno = parseExpectedIdentity(value.expectedIno);
  const entryDev = parseExpectedIdentity(value.expectedEntryDev);
  const entryIno = parseExpectedIdentity(value.expectedEntryIno);
  if (
    !isMutationOperation(value.operation) ||
    expectedDev === undefined ||
    expectedIno === undefined ||
    entryDev === undefined ||
    entryIno === undefined ||
    !isSafeBasename(value.source)
  ) {
    return undefined;
  }
  return {
    operation: value.operation,
    expectedDev: expectedDev.toString(),
    expectedIno: expectedIno.toString(),
    source: value.source,
    expectedEntryDev: entryDev.toString(),
    expectedEntryIno: entryIno.toString(),
  };
}

function parsedRequest(value: unknown): SafeArtifactDirectoryMutationRequest | undefined {
  if (!isRecord(value)) return undefined;
  const common = parsedCommon(value);
  if (common === undefined) return undefined;
  if (common.operation === "unlink") return value.target === undefined ? common : undefined;
  return isSafeBasename(value.target) ? { ...common, target: value.target } : undefined;
}

// Every mutation runs only while its source still has the identity the caller verified and holds
// open. An unlink could otherwise destroy a file a concurrent writer just created under the same
// name, and a link or rename could publish a file that replaced the verified one.
function entryStillExpected(
  io: SafeArtifactDirectoryMutationIo,
  request: SafeArtifactDirectoryMutationRequest,
): boolean {
  return io.entryMatches(
    request.source,
    BigInt(request.expectedEntryDev),
    BigInt(request.expectedEntryIno),
  );
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
  if (!entryStillExpected(io, request)) return SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.entryMismatch;
  try {
    executeMutation(io, request.operation, request.source, request.target);
  } catch (error) {
    return mapMutationFailure(request.operation, error);
  }
  return io.directoryMatches(expectedDev, expectedIno)
    ? SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success
    : SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.directoryMismatch;
}
