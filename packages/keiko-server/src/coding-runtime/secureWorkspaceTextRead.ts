import { createHash } from "node:crypto";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES,
  SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES,
  decodeSecureWorkspaceReadResponse,
  decodeSecureWorkspaceText,
  encodeSecureWorkspaceReadRequest,
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
    if (!isNormalizedRelativePath(request.relativePath)) return { ok: false, reason: "denied" };
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
      return decodeHelperResponse(response);
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

function decodeHelperResponse(response: Uint8Array): SecureWorkspaceTextReadResult {
  try {
    const decoded = decodeSecureWorkspaceReadResponse(response);
    if (decoded.status !== "ok") return { ok: false, reason: helperFailure(decoded.status) };
    const text = decodeSecureWorkspaceText(decoded.bytes);
    return text.ok ? { ok: true, text: text.text } : { ok: false, reason: text.reason };
  } catch {
    return { ok: false, reason: "protocol-invalid" };
  } finally {
    response.fill(0);
  }
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

function helperFailure(
  status: Exclude<
    import("./secureWorkspaceTextReadProtocol.js").SecureWorkspaceReadHelperResponse["status"],
    "ok"
  >,
): SecureWorkspaceTextReadFailure {
  switch (status) {
    case "malformed-request":
      return "protocol-invalid";
    case "unsupported-platform":
      return "unsupported-platform";
    case "invalid-path":
    case "access-denied":
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
