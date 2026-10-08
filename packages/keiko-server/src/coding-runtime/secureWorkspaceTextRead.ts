import { createHash } from "node:crypto";

import { isDenied } from "@oscharko-dev/keiko-workspace";

import {
  proveWorkspacePathAbsent,
  type WorkspacePathAbsence,
  type WorkspacePathLstat,
} from "./secureWorkspaceTextReadAbsence.js";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES,
  SECURE_WORKSPACE_TEXT_READ_MAX_ROOT_BYTES,
  decodeSecureWorkspaceReadResponse,
  decodeSecureWorkspaceText,
  encodeSecureWorkspaceReadRequest,
  encodeSecureWorkspaceSnapshotRequest,
  decodeSecureWorkspaceSnapshotResponse,
  encodeSecureWorkspaceNativeRequest,
  decodeSecureWorkspaceNativeResponse,
  decodeSecureWorkspaceNativeDirectory,
  SECURE_WORKSPACE_NATIVE_MAX_BYTES,
  type SecureWorkspaceNativeFileInfo,
  type SecureWorkspaceNativeDirEntry,
  type SecureWorkspaceNativeRequest,
  type SecureWorkspaceNativeResponse,
  type SecureWorkspaceTextSnapshotInfo,
  type SecureWorkspaceReadClosedStatus,
  type SecureWorkspaceReadHelperResponse,
} from "./secureWorkspaceTextReadProtocol.js";
import {
  resolveSecureWorkspaceReadArtifact,
  secureWorkspaceReadArtifactByteCap,
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

/** Same bound as the native path component scope, sufficient for one complete ancestor load. */
export const SECURE_WORKSPACE_NATIVE_MAX_WAITERS = 64;

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
  | {
      readonly ok: false;
      readonly reason: SecureWorkspaceTextReadFailure;
      /**
       * Set only when the native helper answered `access-denied`: the closed verdict of the server's
       * no-follow walk that decided between `not-found` and `denied` (`absent`, `exists`, `link`,
       * `not-directory`, `foreign-device`, `probe-failed`, `root-unusable`, `aborted`). It is how a
       * denial that was refined can be told apart in the log (#3873 review), and it never carries a
       * path or an error text. Absent for every other failure, which the walk never ran for.
       */
      readonly absence?: WorkspacePathAbsence;
    };

export type SecureWorkspaceTextSnapshotResult =
  | { readonly ok: true; readonly text: string; readonly info: SecureWorkspaceTextSnapshotInfo }
  | Extract<SecureWorkspaceTextReadResult, { readonly ok: false }>
  | { readonly ok: false; readonly reason: "snapshot-unavailable" };

export interface SecureWorkspaceTextReadRequest {
  readonly relativePath: string;
  readonly signal?: AbortSignal | undefined;
}

export type SecureWorkspaceNativeIOFailure =
  | Extract<SecureWorkspaceTextReadResult, { readonly ok: false }>
  | { readonly ok: false; readonly reason: "native-io-unavailable" }
  | {
      readonly ok: false;
      readonly reason: "wrong-kind";
      readonly info: SecureWorkspaceNativeFileInfo;
    };

export type SecureWorkspaceNativeBytesResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly info: SecureWorkspaceNativeFileInfo }
  | SecureWorkspaceNativeIOFailure;
export type SecureWorkspaceNativeStatResult =
  | { readonly ok: true; readonly info: SecureWorkspaceNativeFileInfo }
  | SecureWorkspaceNativeIOFailure;
export type SecureWorkspaceNativeListResult =
  | {
      readonly ok: true;
      readonly entries: readonly SecureWorkspaceNativeDirEntry[];
      readonly info: SecureWorkspaceNativeFileInfo;
    }
  | SecureWorkspaceNativeIOFailure;
export interface SecureWorkspaceNativeIORequest extends SecureWorkspaceTextReadRequest {
  /** Additional veto from the same current parent owner; never grants authority. */
  readonly isCurrent?: (() => boolean) | undefined;
}
export interface SecureWorkspaceNativeBytesRequest extends SecureWorkspaceNativeIORequest {
  readonly range?: { readonly offset: number; readonly length: number };
}
/** Private, separately pinned IO primitives; no public model/IPC window or tool admission. */
export interface SecureWorkspaceNativeFileIO {
  readBytes(request: SecureWorkspaceNativeBytesRequest): Promise<SecureWorkspaceNativeBytesResult>;
  stat(request: SecureWorkspaceNativeIORequest): Promise<SecureWorkspaceNativeStatResult>;
  list(request: SecureWorkspaceNativeIORequest): Promise<SecureWorkspaceNativeListResult>;
}

export interface SecureWorkspaceTextReadPort {
  readonly nativeFileIO?: SecureWorkspaceNativeFileIO;
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
  readText(request: SecureWorkspaceTextReadRequest): Promise<SecureWorkspaceTextReadResult>;
  /** Optional same-descriptor text facet. Capability is separately pinned on the helper identity. */
  readTextSnapshot?(
    request: SecureWorkspaceTextReadRequest,
  ): Promise<SecureWorkspaceTextSnapshotResult>;
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
  const readSnapshot = port.readTextSnapshot?.bind(port);
  const nativeIO = port.nativeFileIO;
  return {
    ...(nativeIO === undefined
      ? {}
      : { nativeFileIO: exactNativeFileIO(nativeIO, isRunWorkspace, refusal) }),
    readText: async (request): Promise<SecureWorkspaceTextReadResult> => {
      if (!isRunWorkspace()) return { ok: false, reason: refusal };
      const result = await port.readText(request);
      return isRunWorkspace() ? result : { ok: false, reason: refusal };
    },
    ...(readSnapshot === undefined
      ? {}
      : {
          readTextSnapshot: async (
            request: SecureWorkspaceTextReadRequest,
          ): Promise<SecureWorkspaceTextSnapshotResult> => {
            if (!isRunWorkspace()) return { ok: false, reason: refusal };
            const result = await readSnapshot(request);
            return isRunWorkspace() ? result : { ok: false, reason: refusal };
          },
        }),
  };
}

export interface SecureWorkspaceTextReadDeps {
  /** Resolves the current active binding for every admitted read. */
  readonly resolveWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
  readonly artifact: SecureWorkspaceTextReadArtifact;
  readonly artifactVerifier: SecureWorkspaceTextReadArtifactVerifier;
  readonly processFactory: SecureWorkspaceTextReadProcessFactory;
  readonly platform?: SecureWorkspaceReadPlatform | undefined;
  /** Test seam for the absence walk's metadata probe; production uses `node:fs/promises` `lstat`. */
  readonly lstat?: WorkspacePathLstat | undefined;
}

export function createSecureWorkspaceTextReadPort(
  deps: SecureWorkspaceTextReadDeps,
): SecureWorkspaceTextReadPort {
  return new SecureWorkspaceTextReadPortImpl(deps);
}

interface NativeSlotWaiter {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly finish: (acquired: boolean) => void;
}

class SecureWorkspaceTextReadPortImpl implements SecureWorkspaceTextReadPort {
  private live = 0;
  /** Eight running plus at most sixty-four waiting; overflow remains an explicit technical refusal. */
  private readonly nativeWaiters: NativeSlotWaiter[] = [];

  public readonly nativeFileIO: SecureWorkspaceNativeFileIO;

  public constructor(private readonly deps: SecureWorkspaceTextReadDeps) {
    this.nativeFileIO = Object.freeze({
      readBytes: (request: SecureWorkspaceNativeBytesRequest) =>
        this.nativeRead(captureNativeRequest(request), "read"),
      stat: async (
        request: SecureWorkspaceNativeIORequest,
      ): Promise<SecureWorkspaceNativeStatResult> => {
        const result = await this.nativeRead(captureNativeRequest(request), "stat");
        return result.ok ? { ok: true, info: result.info } : result;
      },
      list: async (
        request: SecureWorkspaceNativeIORequest,
      ): Promise<SecureWorkspaceNativeListResult> => {
        const captured = captureNativeRequest(request);
        const result = await this.nativeRead(captured, "list");
        return nativeListResult(result, captured.relativePath);
      },
    });
  }

  private async nativeRead(
    request: SecureWorkspaceNativeBytesRequest,
    operation: "read" | "stat" | "list",
  ): Promise<SecureWorkspaceNativeBytesResult> {
    if (!validNativeRequest(request, operation)) return { ok: false, reason: "denied" };
    if (request.signal?.aborted === true) return { ok: false, reason: "cancelled" };
    const platform = this.deps.platform ?? { os: process.platform, arch: process.arch };
    if (secureWorkspaceReadTargetFor(platform) === undefined)
      return { ok: false, reason: "unsupported-platform" };
    return this.nativeGuarded(request, operation, readSignal(request.signal));
  }

  private async nativeGuarded(
    request: SecureWorkspaceNativeBytesRequest,
    operation: "read" | "stat" | "list",
    signal: AbortSignal,
  ): Promise<SecureWorkspaceNativeBytesResult> {
    const material = await resolveVerifiedReadMaterial(this.deps);
    if (!material.ok) return material;
    if (material.verifiedArtifact.nativeProtocol !== "KSR3/KSS3")
      return { ok: false, reason: "native-io-unavailable" };
    if (callerCancelled(signal)) return processRunFailure(undefined, signal, request.signal);
    if (request.isCurrent?.() === false) return { ok: false, reason: "denied" };
    const artifact = Object.freeze({ ...material.verifiedArtifact });
    if (!(await this.acquireNativeSlot(signal))) {
      return callerCancelled(signal)
        ? processRunFailure(undefined, signal, request.signal)
        : { ok: false, reason: "busy" };
    }
    try {
      return await this.nativeAcquired(
        request,
        operation,
        signal,
        material.workspaceRoot,
        artifact,
      );
    } finally {
      this.releaseSlot();
    }
  }

  private async nativeAcquired(
    request: SecureWorkspaceNativeBytesRequest,
    operation: "read" | "stat" | "list",
    signal: AbortSignal,
    root: string,
    artifact: SecureWorkspaceTextReadArtifact,
  ): Promise<SecureWorkspaceNativeBytesResult> {
    const verified = await resolveSecureWorkspaceReadArtifact(
      artifact,
      this.deps.platform ?? { os: process.platform, arch: process.arch },
      this.deps.artifactVerifier,
    );
    if (verified === undefined) return { ok: false, reason: "artifact-unverified" };
    const refusal = await this.nativePreflight(request, signal, root);
    if (refusal !== undefined) return refusal;
    const input: SecureWorkspaceNativeRequest = {
      root,
      relativePath: request.relativePath,
      operation,
      ...(operation === "read" && request.range !== undefined ? { range: request.range } : {}),
    };
    const frame = encodeSecureWorkspaceNativeRequest(input);
    try {
      return await this.nativeRun(request, input, verified, frame, signal);
    } finally {
      frame.fill(0);
    }
  }

  private async nativePreflight(
    request: SecureWorkspaceNativeBytesRequest,
    signal: AbortSignal,
    root: string,
  ): Promise<Extract<SecureWorkspaceTextReadResult, { readonly ok: false }> | undefined> {
    if (callerCancelled(signal)) return processRunFailure(undefined, signal, request.signal);
    if ((await resolveLiveWorkspaceRoot(this.deps.resolveWorkspaceRoot)) !== root)
      return { ok: false, reason: "workspace-unavailable" };
    if (callerCancelled(signal)) return processRunFailure(undefined, signal, request.signal);
    return request.isCurrent?.() === false ? { ok: false, reason: "denied" } : undefined;
  }

  private acquireNativeSlot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.live < SECURE_WORKSPACE_TEXT_READ_MAX_LIVE && this.nativeWaiters.length === 0) {
      this.live += 1;
      return Promise.resolve(true);
    }
    if (this.nativeWaiters.length >= SECURE_WORKSPACE_NATIVE_MAX_WAITERS)
      return Promise.resolve(false);
    return new Promise((finish) => {
      const waiter: NativeSlotWaiter = {
        signal,
        finish,
        abort: (): void => {
          this.removeNativeWaiter(waiter);
        },
      };
      this.nativeWaiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) this.removeNativeWaiter(waiter);
    });
  }

  private removeNativeWaiter(waiter: NativeSlotWaiter): void {
    const index = this.nativeWaiters.indexOf(waiter);
    if (index === -1) return;
    this.nativeWaiters.splice(index, 1);
    waiter.signal.removeEventListener("abort", waiter.abort);
    waiter.finish(false);
  }

  private releaseSlot(): void {
    this.live -= 1;
    while (this.live < SECURE_WORKSPACE_TEXT_READ_MAX_LIVE && this.nativeWaiters.length > 0) {
      const waiter = this.nativeWaiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (!waiter.signal.aborted) this.live += 1;
      waiter.finish(!waiter.signal.aborted);
    }
  }

  private async nativeRun(
    request: SecureWorkspaceNativeBytesRequest,
    input: SecureWorkspaceNativeRequest,
    artifact: SecureWorkspaceTextReadArtifact,
    frame: Uint8Array,
    signal: AbortSignal,
  ): Promise<SecureWorkspaceNativeBytesResult> {
    let response: Uint8Array;
    try {
      response = await this.deps.processFactory.create(artifact).run({ stdin: frame, signal });
    } catch (error) {
      return processRunFailure(error, signal, request.signal);
    }
    try {
      if (callerCancelled(signal)) return processRunFailure(undefined, signal, request.signal);
      if ((await resolveLiveWorkspaceRoot(this.deps.resolveWorkspaceRoot)) !== input.root)
        return { ok: false, reason: "workspace-unavailable" };
      if (callerCancelled(signal)) return processRunFailure(undefined, signal, request.signal);
      if (request.isCurrent?.() === false) return { ok: false, reason: "denied" };
      const decoded = decodeNativeHelperResponse(response, input);
      if (decoded.kind === "access-denied")
        return await refinedAccessDenial(input.root, input.relativePath, signal, this.deps.lstat);
      return decoded.result;
    } finally {
      response.fill(0);
    }
  }

  public readText(request: SecureWorkspaceTextReadRequest): Promise<SecureWorkspaceTextReadResult> {
    return this.read(request, false);
  }

  public readTextSnapshot(
    request: SecureWorkspaceTextReadRequest,
  ): Promise<SecureWorkspaceTextSnapshotResult> {
    return this.read(request, true);
  }

  private read(
    request: SecureWorkspaceTextReadRequest,
    snapshot: false,
  ): Promise<SecureWorkspaceTextReadResult>;
  private read(
    request: SecureWorkspaceTextReadRequest,
    snapshot: true,
  ): Promise<SecureWorkspaceTextSnapshotResult>;
  private async read(
    request: SecureWorkspaceTextReadRequest,
    snapshot: boolean,
  ): Promise<SecureWorkspaceTextReadResult | SecureWorkspaceTextSnapshotResult> {
    // The always-on deny list (ADR-0005 D3) is the wrapper's own, not only its callers': the helper
    // has no policy and reads a `.env` it can open, and the read-only child passes the model's path
    // straight through. A denied path answers `denied` before anything touches the filesystem, so
    // it is the same answer whether or not the path exists and cannot be used to probe for it.
    if (
      !isSecureWorkspaceTextRelativePath(request.relativePath) ||
      isDenied(request.relativePath)
    ) {
      return { ok: false, reason: "denied" };
    }
    if (request.signal?.aborted === true) return { ok: false, reason: "cancelled" };
    const platform = this.deps.platform ?? { os: process.platform, arch: process.arch };
    if (secureWorkspaceReadTargetFor(platform) === undefined)
      return { ok: false, reason: "unsupported-platform" };
    if (this.live >= SECURE_WORKSPACE_TEXT_READ_MAX_LIVE) return { ok: false, reason: "busy" };
    this.live += 1;
    try {
      return await this.readTextGuarded(request, snapshot);
    } finally {
      this.releaseSlot();
    }
  }

  private async readTextGuarded(
    request: SecureWorkspaceTextReadRequest,
    snapshot: boolean,
  ): Promise<SecureWorkspaceTextReadResult | SecureWorkspaceTextSnapshotResult> {
    const material = await resolveVerifiedReadMaterial(this.deps);
    if (!material.ok) return material;
    const { workspaceRoot, verifiedArtifact } = material;
    if (snapshot && verifiedArtifact.snapshotProtocol !== "KSR2/KSS2")
      return { ok: false, reason: "snapshot-unavailable" };
    const encode = snapshot
      ? encodeSecureWorkspaceSnapshotRequest
      : encodeSecureWorkspaceReadRequest;
    const frame = encode({
      root: workspaceRoot,
      relativePath: request.relativePath,
      byteCap: secureWorkspaceReadArtifactByteCap(verifiedArtifact),
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
      if (snapshot && signal.aborted) {
        response.fill(0);
        return processRunFailure(undefined, signal, request.signal);
      }
      const answer = snapshot
        ? decodeSnapshotHelperResponse(response)
        : decodeHelperResponse(response, secureWorkspaceReadArtifactByteCap(verifiedArtifact));
      if (answer.kind === "settled") return answer.result;
      return await refinedAccessDenial(
        workspaceRoot,
        request.relativePath,
        signal,
        this.deps.lstat,
      );
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
): Extract<SecureWorkspaceTextReadResult, { readonly ok: false }> {
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

function decodeHelperResponse(response: Uint8Array, byteCap: number): HelperAnswer {
  try {
    const decoded = decodeSecureWorkspaceReadResponse(response);
    if (decoded.status === "ok" && decoded.bytes.byteLength > byteCap) {
      return { kind: "settled", result: { ok: false, reason: "protocol-invalid" } };
    }
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
 *
 * The walk's closed verdict rides out with the result as `absence` (#3873 review): both answers came
 * from the helper's single `access-denied`, and a denial that cannot be told from another in the log
 * leaves an operator unable to say whether a creation was refused because the path was there, linked,
 * on another device, unprobeable or aborted.
 */
async function refinedAccessDenial(
  workspaceRoot: string,
  relativePath: string,
  signal: AbortSignal,
  lstat: WorkspacePathLstat | undefined,
): Promise<Extract<SecureWorkspaceTextReadResult, { readonly ok: false }>> {
  const absence = await proveWorkspacePathAbsent({
    root: workspaceRoot,
    relativePath,
    signal,
    lstat,
  });
  return { ok: false, reason: absence === "absent" ? "not-found" : "denied", absence };
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

export function isSecureWorkspaceTextRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES ||
    value.includes("\0") ||
    // Drive-qualified (`C:/…`) and NTFS alternate-data-stream (`file:stream`) forms are never
    // workspace-relative; rejecting the colon keeps win32 resolution inside the workspace.
    value.includes(":") ||
    value.startsWith("/") ||
    value.includes("\\") ||
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

function decodeSnapshotHelperResponse(
  response: Uint8Array,
):
  | { readonly kind: "settled"; readonly result: SecureWorkspaceTextSnapshotResult }
  | { readonly kind: "access-denied" } {
  try {
    const decoded = decodeSecureWorkspaceSnapshotResponse(response);
    if (decoded.status === "access-denied") return { kind: "access-denied" };
    if (decoded.status !== "ok")
      return { kind: "settled", result: { ok: false, reason: helperFailure(decoded.status) } };
    const text = decodeSecureWorkspaceText(decoded.bytes);
    return {
      kind: "settled",
      result: text.ok ? { ok: true, text: text.text, info: decoded.info } : text,
    };
  } catch {
    return { kind: "settled", result: { ok: false, reason: "protocol-invalid" } };
  } finally {
    response.fill(0);
  }
}

async function resolveVerifiedReadMaterial(deps: SecureWorkspaceTextReadDeps): Promise<
  | {
      readonly ok: true;
      readonly workspaceRoot: string;
      readonly verifiedArtifact: SecureWorkspaceTextReadArtifact;
    }
  | { readonly ok: false; readonly reason: "workspace-unavailable" | "artifact-unverified" }
> {
  const platform = deps.platform ?? { os: process.platform, arch: process.arch };
  const workspaceRoot = await resolveLiveWorkspaceRoot(deps.resolveWorkspaceRoot);
  if (workspaceRoot === undefined) return { ok: false, reason: "workspace-unavailable" };
  const verifiedArtifact = await resolveSecureWorkspaceReadArtifact(
    deps.artifact,
    platform,
    deps.artifactVerifier,
  );
  return verifiedArtifact === undefined
    ? { ok: false, reason: "artifact-unverified" }
    : { ok: true, workspaceRoot, verifiedArtifact };
}

function validNativePath(value: string): boolean {
  if (
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > SECURE_WORKSPACE_TEXT_READ_MAX_PATH_BYTES
  )
    return false;
  if (value === "") return true;
  const parts = value.split("/");
  return (
    parts.length <= SECURE_WORKSPACE_NATIVE_MAX_WAITERS &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validNativeRange(range: SecureWorkspaceNativeBytesRequest["range"]): boolean {
  return (
    range === undefined ||
    (Number.isSafeInteger(range.offset) &&
      range.offset >= 0 &&
      Number.isSafeInteger(range.length) &&
      range.length >= 0 &&
      range.length <= SECURE_WORKSPACE_NATIVE_MAX_BYTES &&
      Number.isSafeInteger(range.offset + range.length))
  );
}

function nativeResult(
  decoded: SecureWorkspaceNativeResponse,
  request: SecureWorkspaceNativeRequest,
): SecureWorkspaceNativeBytesResult {
  if (decoded.status === "wrong-kind") {
    const invalid =
      request.operation === "stat" ||
      (request.operation === "read" && decoded.info.type === "file") ||
      (request.operation === "list" && decoded.info.type === "directory");
    return invalid
      ? { ok: false, reason: "protocol-invalid" }
      : { ok: false, reason: "wrong-kind", info: decoded.info };
  }
  if (decoded.status === "access-denied") return { ok: false, reason: "denied" };
  if (decoded.status !== "ok") return { ok: false, reason: helperFailure(decoded.status) };
  if (!validNativeContent(decoded, request)) return { ok: false, reason: "protocol-invalid" };
  return { ok: true, bytes: Buffer.from(decoded.bytes), info: decoded.info };
}

function validNativeContent(
  decoded: Extract<SecureWorkspaceNativeResponse, { readonly status: "ok" }>,
  request: SecureWorkspaceNativeRequest,
): boolean {
  if (request.operation === "stat") return decoded.bytes.byteLength === 0;
  if (request.operation === "list") return decoded.info.type === "directory";
  if (decoded.info.type !== "file") return false;
  const size =
    request.range === undefined
      ? decoded.info.size
      : Math.min(request.range.length, Math.max(0, decoded.info.size - request.range.offset));
  return decoded.bytes.byteLength === size;
}

function nativeListResult(
  result: SecureWorkspaceNativeBytesResult,
  relativePath: string,
): SecureWorkspaceNativeListResult {
  if (!result.ok) return result;
  try {
    const entries = decodeSecureWorkspaceNativeDirectory(result.bytes).filter(
      (entry) => !isDenied(relativePath === "" ? entry.name : `${relativePath}/${entry.name}`),
    );
    return { ok: true, entries: Object.freeze(entries), info: result.info };
  } catch {
    return { ok: false, reason: "protocol-invalid" };
  } finally {
    result.bytes.fill(0);
  }
}

function exactNativeFileIO(
  io: SecureWorkspaceNativeFileIO,
  current: () => boolean,
  refusal: SecureWorkspaceTextReadFailure,
): SecureWorkspaceNativeFileIO {
  const read = io.readBytes.bind(io),
    stat = io.stat.bind(io),
    list = io.list.bind(io);
  return Object.freeze({
    readBytes: async (
      request: SecureWorkspaceNativeBytesRequest,
    ): Promise<SecureWorkspaceNativeBytesResult> => {
      if (!current()) return { ok: false, reason: refusal };
      const result = await read(captureNativeRequest(request, current));
      if (current()) return result;
      if (result.ok) result.bytes.fill(0);
      return { ok: false, reason: refusal };
    },
    stat: async (
      request: SecureWorkspaceNativeIORequest,
    ): Promise<SecureWorkspaceNativeStatResult> => {
      if (!current()) return { ok: false, reason: refusal };
      const result = await stat(captureNativeRequest(request, current));
      return current() ? result : { ok: false, reason: refusal };
    },
    list: async (
      request: SecureWorkspaceNativeIORequest,
    ): Promise<SecureWorkspaceNativeListResult> => {
      if (!current()) return { ok: false, reason: refusal };
      const result = await list(captureNativeRequest(request, current));
      return current() ? result : { ok: false, reason: refusal };
    },
  });
}

function validNativeRequest(
  request: SecureWorkspaceNativeBytesRequest,
  operation: "read" | "stat" | "list",
): boolean {
  return (
    validNativePath(request.relativePath) &&
    !isDenied(request.relativePath) &&
    validNativeRange(request.range) &&
    (operation === "read" || request.range === undefined)
  );
}

function decodeNativeHelperResponse(
  response: Uint8Array,
  request: SecureWorkspaceNativeRequest,
):
  | { readonly kind: "settled"; readonly result: SecureWorkspaceNativeBytesResult }
  | { readonly kind: "access-denied" } {
  try {
    const decoded = decodeSecureWorkspaceNativeResponse(response);
    return decoded.status === "access-denied"
      ? { kind: "access-denied" }
      : { kind: "settled", result: nativeResult(decoded, request) };
  } catch {
    return { kind: "settled", result: { ok: false, reason: "protocol-invalid" } };
  }
}

function captureNativeRequest(
  request: SecureWorkspaceNativeBytesRequest,
  current?: () => boolean,
): SecureWorkspaceNativeBytesRequest {
  const relativePath = request.relativePath;
  const signal = request.signal;
  const range = request.range;
  const guard = request.isCurrent;
  return Object.freeze({
    relativePath,
    ...(signal === undefined ? {} : { signal }),
    ...(range === undefined ? {} : { range: Object.freeze({ ...range }) }),
    ...(current === undefined && guard === undefined
      ? {}
      : { isCurrent: (): boolean => current?.() !== false && guard?.() !== false }),
  });
}
