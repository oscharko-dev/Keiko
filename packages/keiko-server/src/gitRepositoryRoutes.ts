import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";
import type { IncomingMessage } from "node:http";
import type { RouteContext, RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody } from "./routes.js";
import { pathIsDenied } from "./files-deny.js";
import { assertUiDbOutsideProject, UiStoreError, validateProjectPath } from "./store/index.js";
import { projectWithWorkspaceAvailability } from "./workspace-root-membership.js";
import {
  classifyGitRemoteFailure,
  defaultGitNetworkProcessRunner,
  isSafeGitPositional,
  type GitProcessResult,
  type GitRemoteFailureReason,
} from "@oscharko-dev/keiko-git";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CLONE_TIMEOUT_MS = 120_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
}

// KEIKO-0341: distinguishable typed errors so createCloneRepositoryHandler can map
// each parse/validation failure to its own operator-visible message instead of the
// pre-fix single "The clone request is invalid." for all of malformed-JSON,
// wrong-shape, missing-field, and wrong-type.
class MalformedJsonBodyError extends Error {
  constructor() {
    super("Request body is not valid JSON.");
  }
}
class NotAnObjectBodyError extends Error {
  constructor() {
    super("Request body must be a JSON object.");
  }
}
class MissingFieldError extends Error {
  constructor(readonly field: string) {
    super(`${field} is required.`);
  }
}
class InvalidFieldTypeError extends Error {
  constructor(readonly field: string) {
    super(`${field} must be a string.`);
  }
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MalformedJsonBodyError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NotAnObjectBodyError();
  }
  return parsed as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidFieldTypeError(key);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) throw new MissingFieldError(key);
  return value;
}

function invalid(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function forbidden(message: string): RouteResult {
  return { status: 403, body: errorBody("DENIED", message) };
}

function redactedErrorMessage(message: string, deps: UiHandlerDeps): string {
  const redacted = deps.redactor(message);
  return typeof redacted === "string" ? redacted : "Request failed.";
}

function reportCloneFailure(ctx: RouteContext, deps: UiHandlerDeps, error: unknown): string {
  const correlationId = ctx.correlationId ?? randomUUID();
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "POST /api/repositories/clone",
      source: "git-repository-routes",
      error,
      summary: "server-operation-failed",
      redact: (message): string => redactedErrorMessage(message, deps),
    }),
  );
  return correlationId;
}

type RepositoryHostClass = "public" | "loopback" | "private" | "link-local" | "metadata";
type Ipv4Parts = readonly [number, number, number, number];
type Ipv4Rule = readonly [RepositoryHostClass, (parts: Ipv4Parts) => boolean];

function parseIpv4(hostname: string): Ipv4Parts | undefined {
  if (isIP(hostname) !== 4) return undefined;
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts as [number, number, number, number];
}

const REPOSITORY_IPV4_RULES: readonly Ipv4Rule[] = [
  ["loopback", ([a]): boolean => a === 127],
  ["metadata", ([a, b, c, d]): boolean => a === 169 && b === 254 && c === 169 && d === 254],
  ["link-local", ([a, b]): boolean => a === 169 && b === 254],
  ["private", ([a]): boolean => a === 10],
  ["private", ([a, b]): boolean => a === 172 && b >= 16 && b <= 31],
  ["private", ([a, b]): boolean => a === 192 && b === 168],
  ["private", ([a, b]): boolean => a === 100 && b >= 64 && b <= 127],
  ["private", ([a]): boolean => a === 0 || a >= 224],
  ["private", ([a, b, c]): boolean => a === 192 && b === 0 && c === 0],
  ["private", ([a, b]): boolean => a === 198 && (b === 18 || b === 19)],
];

function classifyRepositoryIpv4(parts: Ipv4Parts): RepositoryHostClass {
  return REPOSITORY_IPV4_RULES.find(([, matches]) => matches(parts))?.[0] ?? "public";
}

function classifyMappedIpv6(hostname: string): RepositoryHostClass | undefined {
  if (!hostname.startsWith("::ffff:")) return undefined;
  const ipv4 = parseIpv4(hostname.slice("::ffff:".length));
  return ipv4 === undefined ? "private" : classifyRepositoryIpv4(ipv4);
}

function classifyIpv6FirstSegment(hostname: string): RepositoryHostClass | undefined {
  const firstText = hostname.split(":", 1)[0] ?? "";
  const first = firstText.length === 0 ? 0 : Number.parseInt(firstText, 16);
  if (!Number.isInteger(first)) return undefined;
  if (first >= 0xfe80 && first <= 0xfebf) return "link-local";
  if ((first & 0xfe00) === 0xfc00) return "private";
  return undefined;
}

function classifyRepositoryIpv6(hostname: string): RepositoryHostClass {
  if (hostname === "::1") return "loopback";
  if (hostname === "::") return "private";
  return classifyMappedIpv6(hostname) ?? classifyIpv6FirstSegment(hostname) ?? "public";
}

function classifyRepositoryHost(hostname: string): RepositoryHostClass | undefined {
  const normalized = hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  if (normalized === "localhost") return "loopback";
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) return classifyRepositoryIpv4(ipv4);
  if (isIP(normalized) === 6) return classifyRepositoryIpv6(normalized);
  return undefined;
}

function repositoryHost(input: string): string | undefined {
  if (containsControlCharacter(input)) return undefined;
  const scpLike = /^git@([^:\s]+):[^\s]+$/u.exec(input);
  if (scpLike !== null) return scpLike[1];
  try {
    const url = new URL(input);
    if (url.username !== "" || url.password !== "") return undefined;
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
}

function repositoryUrlAllowed(input: string): boolean {
  // Reject option-like URLs (leading `-`) before anything else: a value git could re-read as an
  // option (e.g. `--upload-pack=<cmd>`) must never reach the clone argv, independent of the `--`
  // separator. Well-formed https/ssh/scp URLs never begin with `-`, so this rejects only abuse.
  if (!isSafeGitPositional(input)) return false;
  const host = repositoryHost(input);
  if (typeof host !== "string" || host.length === 0) return false;
  const hostClass = classifyRepositoryHost(host);
  return hostClass === undefined || hostClass === "public";
}

function containsControlCharacter(input: string): boolean {
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

async function assertDestination(candidate: string): Promise<RouteResult | string> {
  if (!isAbsolute(candidate)) return invalid("Destination path must be absolute.");
  const normalized = normalize(candidate);
  if (pathIsDenied(normalized)) {
    return forbidden("The destination path is excluded from Keiko's safe repository surface.");
  }
  try {
    await stat(normalized);
    return invalid("Destination path already exists.");
  } catch {
    // Expected: git clone creates the final directory.
  }
  const parent = dirname(normalized);
  if (pathIsDenied(parent)) {
    return forbidden("The destination parent is excluded from Keiko's safe repository surface.");
  }
  try {
    const info = await stat(parent);
    if (!info.isDirectory()) return invalid("Destination parent must be a directory.");
  } catch {
    return invalid("Destination parent must exist.");
  }
  return normalized;
}

type CloneRepositoryRunner = (
  repositoryUrl: string,
  destinationPath: string,
) => Promise<RouteResult | null>;

// Clone goes through the shared hardened runner (single spawn path, byte cap, timeout with
// SIGTERM→SIGKILL escalation) with the credential-capable network env.
const cloneRepository: CloneRepositoryRunner = async function cloneRepository(
  repositoryUrl: string,
  destinationPath: string,
): Promise<RouteResult | null> {
  // Fail closed at the spawn boundary: neither positional may be option-like, so a hostile URL or
  // destination can never be re-read by git as `--upload-pack`/`--exec`/… even though `--` already
  // separates them. The dash checks are written inline (not only via isSafeGitPositional, which
  // guards the upstream URL allow-list) so the barrier sits directly on the dataflow into the
  // spawn — a leading-dash value cannot reach the git argv below.
  if (repositoryUrl.startsWith("-") || destinationPath.startsWith("-")) {
    return invalid("The repository URL and destination must not be interpretable as git options.");
  }
  if (!isSafeGitPositional(repositoryUrl) || !isSafeGitPositional(destinationPath)) {
    return invalid("The repository URL and destination must be non-empty.");
  }
  const result = await defaultGitNetworkProcessRunner(
    ["clone", "--", repositoryUrl, destinationPath],
    { cwd: dirname(destinationPath), maxBytes: MAX_OUTPUT_BYTES, timeoutMs: CLONE_TIMEOUT_MS },
  );
  return classifyCloneOutcome(result);
};

interface CloneFailureShape {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

// One row per reason the shared classifier can produce. TOTAL over the vocabulary minus "none": a new
// remote failure reason is a COMPILE error here, so it can never inherit an existing row's meaning —
// which is exactly how an unreachable host used to be reported as "check the URL and credentials" and
// an over-cap run as a timeout. Every message is content-free: it names the class of failure and the
// operator's next step, never the git output, the URL, or a credential (the raw text stays in the
// spawn boundary and is not carried anywhere).
const CLONE_FAILURE: Readonly<Record<Exclude<GitRemoteFailureReason, "none">, CloneFailureShape>> =
  {
    "git-missing": {
      status: 503,
      code: "GIT_UNAVAILABLE",
      message: "Git is not available on this host.",
    },
    timeout: {
      status: 504,
      code: "GIT_CLONE_TIMEOUT",
      message: "Repository clone did not finish within the bounded execution window.",
    },
    "output-truncated": {
      status: 409,
      code: "GIT_CLONE_OUTPUT_TRUNCATED",
      message:
        "Repository clone produced more output than the bounded execution window admits and was stopped.",
    },
    "remote-unavailable": {
      status: 503,
      code: "GIT_CLONE_REMOTE_UNAVAILABLE",
      message:
        "The remote host could not be reached. Check the network connection and the host name.",
    },
    "auth-failed": {
      status: 409,
      code: "GIT_CLONE_AUTH_FAILED",
      message: "The remote rejected the credentials for this repository.",
    },
    "permission-denied": {
      status: 409,
      code: "GIT_CLONE_PERMISSION_DENIED",
      message: "The remote refused access to this repository for the configured identity.",
    },
    "repository-not-found": {
      status: 409,
      code: "GIT_CLONE_NOT_FOUND",
      message: "The remote repository does not exist or is not visible to the configured identity.",
    },
    "untrusted-host-key": {
      status: 409,
      code: "GIT_CLONE_HOST_KEY_UNTRUSTED",
      message: "The remote host's SSH key is not trusted on this machine.",
    },
    "unsafe-repository": {
      status: 409,
      code: "GIT_CLONE_UNSAFE_REPOSITORY",
      message: "Git refused the destination because of repository ownership.",
    },
    "not-a-repository": {
      status: 409,
      code: "GIT_CLONE_FAILED",
      message: "Repository clone failed. Check the URL, credentials, and destination path.",
    },
    "git-error": {
      status: 409,
      code: "GIT_CLONE_FAILED",
      message: "Repository clone failed. Check the URL, credentials, and destination path.",
    },
  };

/**
 * Pure projection from ONE bounded clone run to its HTTP outcome; `null` means the clone succeeded.
 * Exported so the mapping is testable without spawning git.
 */
export function classifyCloneOutcome(result: GitProcessResult): RouteResult | null {
  const reason = classifyGitRemoteFailure(result);
  if (reason === "none") return null;
  const failure = CLONE_FAILURE[reason];
  return { status: failure.status, body: errorBody(failure.code, failure.message) };
}

// KEIKO-0341: map each typed body-validation error to its own distinguishable
// 400-response, so an operator debugging a failed clone can tell "malformed JSON"
// from "missing repositoryUrl" from "wrong shape" without the correlation id.
function bodyValidationErrorResponse(error: unknown): RouteResult | undefined {
  if (
    error instanceof MalformedJsonBodyError ||
    error instanceof NotAnObjectBodyError ||
    error instanceof MissingFieldError ||
    error instanceof InvalidFieldTypeError
  ) {
    return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
  }
  return undefined;
}

function handleCloneError(ctx: RouteContext, deps: UiHandlerDeps, error: unknown): RouteResult {
  if (error instanceof BodyTooLargeError) {
    return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body is too large.") };
  }
  if (error instanceof UiStoreError) {
    return {
      status: error.status,
      body: errorBody(error.code, redactedErrorMessage(error.message, deps)),
    };
  }
  const typed = bodyValidationErrorResponse(error);
  if (typed !== undefined) return typed;
  const correlationId = reportCloneFailure(ctx, deps, error);
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "The clone request is invalid.", correlationId),
  };
}

export function createCloneRepositoryHandler(
  cloneRunner: CloneRepositoryRunner = cloneRepository,
): (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult> {
  return async (ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> => {
    try {
      const body = await readJsonObject(ctx.req);
      const repositoryUrl = requireString(body, "repositoryUrl");
      const destinationInput = requireString(body, "destinationPath");
      const name = optionalString(body, "name");
      if (!repositoryUrlAllowed(repositoryUrl)) {
        return invalid(
          "Repository URL must be HTTPS, SSH, or git@host:path without embedded secrets.",
        );
      }
      const destination = await assertDestination(destinationInput);
      if (typeof destination !== "string") return destination;
      assertUiDbOutsideProject(deps.uiDbPath, destination);
      const cloneResult = await cloneRunner(repositoryUrl, destination);
      if (cloneResult !== null) return cloneResult;
      const normalizedPath = validateProjectPath(destination, { mustExist: true });
      // Registration owns the paired project + single-root manifest transaction. Only after that
      // durable membership exists do we return the cloned repository to the Git client.
      const project = deps.store.createProject(normalizedPath, name);
      return {
        status: 201,
        body: { project: projectWithWorkspaceAvailability(deps.store, project) },
      };
    } catch (error) {
      return handleCloneError(ctx, deps, error);
    }
  };
}

export const handleCloneRepository = createCloneRepositoryHandler();
