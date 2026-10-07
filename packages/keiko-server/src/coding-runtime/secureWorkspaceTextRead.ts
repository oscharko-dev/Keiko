import { createHash } from "node:crypto";

import { isDenied } from "@oscharko-dev/keiko-workspace";

import { proveWorkspacePathAbsent } from "./secureWorkspaceTextReadAbsence.js";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES,
  SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES,
  decodeSecureWorkspaceReadResponse,
  decodeSecureWorkspaceText,
  encodeSecureWorkspaceReadRequest,
  type SecureWorkspaceReadClosedStatus,
  type SecureWorkspaceReadHelperResponse,
} from "./secureWorkspaceTextReadProtocol.js";
import {
  resolveSecureWorkspaceReadArtifact,
  secureWorkspaceReadTargetFor,
  type SecureWorkspaceTextReadArtifact,
  type SecureWorkspaceTextReadArtifactVerifier,
} from "./secureWorkspaceTextReadArtifact.js";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_LIVE,
  SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS,
  SecureWorkspaceReadProcessError,
  type SecureWorkspaceReadPlatform,
  type SecureWorkspaceTextReadProcessFactory,
} from "./secureWorkspaceTextReadProcess.js";

export type SecureWorkspaceTextReadFailure =
  | "unsupported-platform"
  | "workspace-unavailable"
  | "artifact-unverified"
  | "busy"
  | "cancelled"
  | "timeout"
  | "process-failed"
  | "protocol-invalid"
  | "denied"
  | "not-found"
  | "not-text"
  | "too-large"
  | "unstable";

export type SecureWorkspaceTextReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: SecureWorkspaceTextReadFailure };

export interface SecureWorkspaceTextReadPort {
  /**
   * The text of one workspace-relative file, or the closed reason it could not be read.
   *
   * `denied` is a path the always-on deny list refuses (answered whether or not it exists), a path
   * that is not a valid workspace-relative one, or one the secure read refused and that the server
   * could not prove absent: it exists, or a link, a file used as a directory, another device or an
   * unusable root is in the way. `not-found` means exactly one thing: a no-follow walk under the
   * live root proved the path absent after the helper refused it (F27, #3876). It is the precondition
   * of a file creation and of a rename target, and it never reaches past a link.
   */
  readText(request: {
    readonly relativePath: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<SecureWorkspaceTextReadResult>;
}

/**
 * The whole-file digest `keiko_workspace_read` reports and every hash-bound edit is checked
 * against (#3612): one formula, owned by the read port both the tool result and the replacement
 * materializer read through, so the two sides of a precondition cannot drift apart (#3873 review).
 */
export function secureWorkspaceTextDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The secure read answered only while the run's exact workspace is the one the port resolves to,
 * checked before AND after the read (#3873 review). The port resolves its root at read time from the
 * global active pointer, so an operator who switches the active workspace mid-run must never hand a
 * run another workspace's file. `isRunWorkspace` is the caller's own exact-workspace check; a read
 * it refuses answers with the caller's closed `refusal`. One bracket for every run-scoped read
 * through the host port: the auxiliary ports and the repository-instructions loader.
 */
export function exactWorkspaceRead(
  port: SecureWorkspaceTextReadPort,
  isRunWorkspace: () => boolean,
  refusal: SecureWorkspaceTextReadFailure,
): SecureWorkspaceTextReadPort {
  return {
    readText: async (request): Promise<SecureWorkspaceTextReadResult> => {
      if (!isRunWorkspace()) return { ok: false, reason: refusal };
      const result = await port.readText(request);
      return isRunWorkspace() ? result : { ok: false, reason: refusal };
    },
  };
}

export interface SecureWorkspaceTextReadDeps {
  /** Resolves the current active binding for every admitted read. */
  readonly resolveWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
  readonly artifact: SecureWorkspaceTextReadArtifact;
  readonly artifactVerifier: SecureWorkspaceTextReadArtifactVerifier;
  readonly processFactory: SecureWorkspaceTextReadProcessFactory;
  readonly platform?: SecureWorkspaceReadPlatform | undefined;
}

export function createSecureWorkspaceTextReadPort(
  deps: SecureWorkspaceTextReadDeps,
): SecureWorkspaceTextReadPort {
  return new SecureWorkspaceTextReadPortImpl(deps);
}

class SecureWorkspaceTextReadPortImpl implements SecureWorkspaceTextReadPort {
  private live = 0;

  public constructor(private readonly deps: SecureWorkspaceTextReadDeps) {}

  public async readText(request: {
    readonly relativePath: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<SecureWorkspaceTextReadResult> {
    // The always-on deny list (ADR-0005 D3) is the wrapper's own, not only its callers': the helper
    // has no policy and reads a `.env` it can open, and the read-only child passes the model's path
    // straight through. A denied path answers `denied` before anything touches the filesystem, so
    // it is the same answer whether or not the path exists and cannot be used to probe for it.
    if (!isNormalizedRelativePath(request.relativePath) || isDenied(request.relativePath)) {
      return { ok: false, reason: "denied" };
    }
    if (request.signal?.aborted === true) return { ok: false, reason: "cancelled" };
    const platform = this.deps.platform ?? { os: process.platform, arch: process.arch };
    if (secureWorkspaceReadTargetFor(platform) === undefined)
      return { ok: false, reason: "unsupported-platform" };
    if (this.live >= SECURE_WORKSPACE_TEXT_READ_MAX_LIVE) return { ok: false, reason: "busy" };
    this.live += 1;
    try {
      return await this.readTextGuarded(request);
    } finally {
      this.live -= 1;
    }
  }

  private async readTextGuarded(request: {
    readonly relativePath: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<SecureWorkspaceTextReadResult> {
    const platform = this.deps.platform ?? { os: process.platform, arch: process.arch };
    const workspaceRoot = await resolveLiveWorkspaceRoot(this.deps.resolveWorkspaceRoot);
    if (workspaceRoot === undefined) return { ok: false, reason: "workspace-unavailable" };
    const verifiedArtifact = await resolveSecureWorkspaceReadArtifact(
      this.deps.artifact,
      platform,
      this.deps.artifactVerifier,
    );
    if (verifiedArtifact === undefined) return { ok: false, reason: "artifact-unverified" };
    const frame = encodeSecureWorkspaceReadRequest({
      root: workspaceRoot,
      relativePath: request.relativePath,
      byteCap: 65_536,
    });
    try {
      const signal = readSignal(request.signal);
      let response: Uint8Array;
      try {
        response = await this.deps.processFactory
          .create(verifiedArtifact)
          .run({ stdin: frame, signal });
      } catch (error) {
        return processRunFailure(error, signal, request.signal);
      }
      const answer = decodeHelperResponse(response);
      if (answer.kind === "settled") return answer.result;
      return await refinedAccessDenial(workspaceRoot, request.relativePath, signal);
    } finally {
      frame.fill(0);
    }
  }
}

function readSignal(callerSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS);
  return callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
}

function processRunFailure(
  error: unknown,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): SecureWorkspaceTextReadResult {
  if (error instanceof SecureWorkspaceReadProcessError && error.reason === "protocol-invalid")
    return { ok: false, reason: "protocol-invalid" };
  if (!signal.aborted) return { ok: false, reason: "process-failed" };
  return { ok: false, reason: callerCancelled(callerSignal) ? "cancelled" : "timeout" };
}

// What the helper said, with the one answer that is not yet a result kept apart: `access-denied` is
// the helper's single word for every path it could not open, so it is refined below, never mapped.
type HelperAnswer =
  | { readonly kind: "settled"; readonly result: SecureWorkspaceTextReadResult }
  | { readonly kind: "access-denied" };

type MappedHelperStatus = Exclude<SecureWorkspaceReadClosedStatus, "access-denied">;

type MappedHelperResponse =
  { readonly status: "ok"; readonly bytes: Uint8Array } | { readonly status: MappedHelperStatus };

function isMappedResponse(
  decoded: SecureWorkspaceReadHelperResponse,
): decoded is MappedHelperResponse {
  return decoded.status !== "access-denied";
}

function decodeHelperResponse(response: Uint8Array): HelperAnswer {
  try {
    const decoded = decodeSecureWorkspaceReadResponse(response);
    return isMappedResponse(decoded)
      ? { kind: "settled", result: mappedHelperResult(decoded) }
      : { kind: "access-denied" };
  } catch {
    return { kind: "settled", result: { ok: false, reason: "protocol-invalid" } };
  } finally {
    response.fill(0);
  }
}

function mappedHelperResult(decoded: MappedHelperResponse): SecureWorkspaceTextReadResult {
  if (decoded.status !== "ok") return { ok: false, reason: helperFailure(decoded.status) };
  const text = decodeSecureWorkspaceText(decoded.bytes);
  return text.ok ? { ok: true, text: text.text } : { ok: false, reason: text.reason };
}

/**
 * Settles the helper's `access-denied` as `not-found` when the server can prove the path absent, and
 * as `denied` otherwise (F27, #3876).
 *
 * The helper answers `access-denied` for every path it cannot open and has no not-found status, so a
 * path that was never there came back `denied` and a file could not be created through the
 * replacement form. The helper is neither changed nor skipped: it is asked first, every other status
 * keeps its own mapping (an `invalid-path` stays `denied` whatever the filesystem holds), and only its
 * `access-denied` is refined. The refinement is the no-follow walk of `proveWorkspacePathAbsent`
 * under the same live root the helper was given: it never follows a link, never leaves the root's
 * device, and answers `not-found` only on a missing component below a chain of real directories.
 * Whatever it cannot decide stays the helper's `denied`, so a path that exists, a link, a file used as
 * a directory and an unusable root keep their denial. The deny list was applied before the helper
 * ran, so a denied path never gets here and the answer never tells whether it exists.
 */
async function refinedAccessDenial(
  workspaceRoot: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<SecureWorkspaceTextReadResult> {
  const absence = await proveWorkspacePathAbsent({ root: workspaceRoot, relativePath, signal });
  return { ok: false, reason: absence === "absent" ? "not-found" : "denied" };
}

async function resolveLiveWorkspaceRoot(
  resolve: SecureWorkspaceTextReadDeps["resolveWorkspaceRoot"],
): Promise<string | undefined> {
  try {
    const root = await resolve();
    return isUsableWorkspaceRoot(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

function callerCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// `access-denied` is not here: it is refined by `refinedAccessDenial`, never mapped.
function helperFailure(status: MappedHelperStatus): SecureWorkspaceTextReadFailure {
  switch (status) {
    case "malformed-request":
      return "protocol-invalid";
    case "unsupported-platform":
      return "unsupported-platform";
    case "invalid-path":
      return "denied";
    case "not-regular":
      return "not-text";
    case "content-too-large":
      return "too-large";
    case "content-not-text":
      return "not-text";
    case "changed-during-read":
      return "unstable";
    case "io-failure":
      return "process-failed";
  }
}

function isNormalizedRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES ||
    value.includes("\0") ||
    // Drive-qualified (`C:/…`) and NTFS alternate-data-stream (`file:stream`) forms are never
    // workspace-relative; rejecting the colon keeps win32 resolution inside the workspace.
    value.includes(":") ||
    value.startsWith("/") ||
    value.startsWith("\\")
  )
    return false;
  const components = value.split("/");
  return components.every(
    (component) =>
      component.length > 0 && component !== "." && component !== ".." && !component.includes("\\"),
  );
}

function isUsableWorkspaceRoot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES
  );
}
