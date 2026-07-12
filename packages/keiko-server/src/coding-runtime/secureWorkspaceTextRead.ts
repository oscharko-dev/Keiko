import {
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

export interface SecureWorkspaceTextReadDeps {
  /** Resolved at server composition time, never supplied by a runtime consumer. */
  readonly workspaceRoot: string;
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

  // eslint-disable-next-line max-lines-per-function, complexity
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
    let frame: Buffer | undefined;
    try {
      const verifiedArtifact = await resolveSecureWorkspaceReadArtifact(
        this.deps.artifact,
        platform,
        this.deps.artifactVerifier,
      );
      if (verifiedArtifact === undefined) return { ok: false, reason: "artifact-unverified" };
      frame = encodeSecureWorkspaceReadRequest({
        root: this.deps.workspaceRoot,
        relativePath: request.relativePath,
        byteCap: 65_536,
      });
      const signal =
        request.signal === undefined
          ? AbortSignal.timeout(SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS)
          : AbortSignal.any([
              request.signal,
              AbortSignal.timeout(SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS),
            ]);
      let response: Uint8Array;
      try {
        response = await this.deps.processFactory
          .create(verifiedArtifact)
          .run({ stdin: frame, signal });
      } catch (error) {
        if (error instanceof SecureWorkspaceReadProcessError && error.reason === "protocol-invalid")
          return { ok: false, reason: "protocol-invalid" };
        return {
          ok: false,
          reason: signal.aborted
            ? callerCancelled(request.signal)
              ? "cancelled"
              : "timeout"
            : "process-failed",
        };
      }
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
    } finally {
      frame?.fill(0);
      this.live -= 1;
    }
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
    value.length > 4_096 ||
    value.includes("\0") ||
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
