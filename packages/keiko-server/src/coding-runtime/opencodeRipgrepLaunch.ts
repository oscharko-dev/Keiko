import { delimiter, dirname, isAbsolute } from "node:path";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  RIPGREP_OVERRIDE_ENV,
  RIPGREP_RUNTIME_MANIFEST,
  resolveVerifiedRipgrep,
  ripgrepActivationDigest,
  ripgrepRuntimeApproval,
  ripgrepTargetKeyForPortableTarget,
  verifyRipgrepExecutable,
  type RipgrepPortableTarget,
  type RipgrepRuntimeManifest,
  type RipgrepRuntimeTargetKey,
  type RipgrepVerification,
} from "./ripgrepRuntime.js";

// OpenCode's glob and grep tools and its file finder run ripgrep. The runtime looks for `rg` on its
// PATH, then in its own cache, and otherwise DOWNLOADS an archive from GitHub (Epic #3897). Keiko
// never lets the runtime reach that third step: at every launch it resolves the one pinned
// executable through the verifier, and only a verified executable's directory is put on the child
// PATH. An unverified one leaves the run starting with search degraded, and the closed reason is
// recorded on the Activity Log (never a path).

/** The closed vocabulary of why a launch has no verified ripgrep. */
export const OPENCODE_RIPGREP_UNVERIFIED_REASONS = [
  "unsupported-target",
  "missing",
  "not-regular-file",
  "untrusted-parent",
  "untrusted-owner-or-mode",
  "oversized",
  "unreadable",
  "changed-during-verification",
  "digest-mismatch",
  "no-location",
  "unsafe-directory",
] as const;

export type OpenCodeRipgrepUnverifiedReason = (typeof OPENCODE_RIPGREP_UNVERIFIED_REASONS)[number];

const RIPGREP_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.ripgrep.resolved",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRipgrepLaunch.recordOpenCodeRipgrepResolution",
  fields: {
    targetKey: {
      type: "string",
      dataClass: "safe-platform-class",
      required: true,
      values: [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "win32-arm64",
        "win32-x64",
      ],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["verified", "unverified"],
    },
    layout: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["portable", "provisioned", "override", "none"],
    },
    toolProfile: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["native", "mapped"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: OPENCODE_RIPGREP_UNVERIFIED_REASONS,
    },
    overrideReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: OPENCODE_RIPGREP_UNVERIFIED_REASONS,
    },
    digestSource: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pinned", "activation-bound"],
    },
    version: { type: "string", dataClass: "safe-version", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  diagnosticWhen: [{ field: "outcome", values: ["unverified"] }],
  failureClasses: ["coding-runtime-ripgrep-unavailable"],
  proofIds: ["coding-runtime.ripgrep.resolved.emitted-line"],
  releaseImpact: "patch",
});

export type OpenCodeRipgrepLayout = "portable" | "provisioned" | "override";

export type OpenCodeRipgrepResolution =
  | {
      readonly outcome: "verified";
      readonly targetKey: RipgrepRuntimeTargetKey;
      readonly layout: OpenCodeRipgrepLayout;
      readonly version: string;
      /** `pinned` is the upstream digest; `activation-bound` is the digest a platform signature left. */
      readonly digestSource: "pinned" | "activation-bound";
      /** The ONLY directory the launch puts on the child PATH. Never logged. */
      readonly directory: string;
      readonly overrideReason?: OpenCodeRipgrepUnverifiedReason | undefined;
    }
  | {
      readonly outcome: "unverified";
      readonly targetKey: RipgrepRuntimeTargetKey;
      readonly layout: OpenCodeRipgrepLayout | "none";
      readonly reason: OpenCodeRipgrepUnverifiedReason;
      readonly overrideReason?: OpenCodeRipgrepUnverifiedReason | undefined;
    };

/** Where this launch may look for the pinned executable. */
export type OpenCodeRipgrepLocation =
  /** A packaged runtime: `<resourceRoot>/runtime/native/rg`, bound by its attested activation record. */
  | { readonly kind: "packaged"; readonly resourceRoot: string; readonly activation: unknown }
  /** A development checkout: `<checkoutRoot>/.ripgrep/<version>/<target>/rg`. */
  | { readonly kind: "checkout"; readonly checkoutRoot: string }
  /** No fixed place (npm runtime package, functional harness): only an explicit override. */
  | { readonly kind: "override-only" };

export interface OpenCodeRipgrepRequest {
  readonly target: RipgrepPortableTarget;
  readonly location: OpenCodeRipgrepLocation;
  /** The server environment; read only for the explicit override, never forwarded by this module. */
  readonly env: NodeJS.ProcessEnv | undefined;
  /** Hermetic seams of the verifier. Production supplies neither. */
  readonly manifest?: Readonly<RipgrepRuntimeManifest> | undefined;
  readonly currentUid?: number | undefined;
}

type Attempt =
  | {
      readonly layout: OpenCodeRipgrepLayout;
      readonly ok: true;
      readonly path: string;
      readonly sha256: string;
      readonly version: string;
    }
  | {
      readonly layout: OpenCodeRipgrepLayout;
      readonly ok: false;
      readonly reason: OpenCodeRipgrepUnverifiedReason;
    };

function directoryIsSafeForPath(directory: string): boolean {
  return isAbsolute(directory) && !directory.includes(delimiter) && !/[\0\r\n]/u.test(directory);
}

// A verified file in a directory that cannot be named on a PATH is not usable; say so truthfully
// instead of claiming a verification the child could not act on.
function attemptFrom(layout: OpenCodeRipgrepLayout, result: RipgrepVerification): Attempt {
  if (!result.ok) return { layout, ok: false, reason: result.reason };
  return directoryIsSafeForPath(dirname(result.path))
    ? { layout, ok: true, path: result.path, sha256: result.sha256, version: result.version }
    : { layout, ok: false, reason: "unsafe-directory" };
}

function verifierOptions(
  request: OpenCodeRipgrepRequest,
): Pick<NonNullable<Parameters<typeof resolveVerifiedRipgrep>[2]>, "manifest" | "currentUid"> {
  return {
    ...(request.manifest === undefined ? {} : { manifest: request.manifest }),
    ...(request.currentUid === undefined ? {} : { currentUid: request.currentUid }),
  };
}

// A packaged release-qualified runtime runs only its attested payload, so the environment cannot
// redirect it; every other lane may be pointed at a file that must still verify.
function overrideAttempt(
  request: OpenCodeRipgrepRequest,
  targetKey: RipgrepRuntimeTargetKey,
): Attempt | undefined {
  if (request.location.kind === "packaged") return undefined;
  const path = request.env?.[RIPGREP_OVERRIDE_ENV];
  if (path === undefined || path.length === 0) return undefined;
  if (!isAbsolute(path)) return { layout: "override", ok: false, reason: "missing" };
  return attemptFrom(
    "override",
    verifyRipgrepExecutable(path, targetKey, verifierOptions(request)),
  );
}

function layoutAttempt(
  request: OpenCodeRipgrepRequest,
  targetKey: RipgrepRuntimeTargetKey,
): Attempt | undefined {
  const { location } = request;
  if (location.kind === "override-only") return undefined;
  if (location.kind === "checkout") {
    return attemptFrom(
      "provisioned",
      resolveVerifiedRipgrep(location.checkoutRoot, targetKey, {
        ...verifierOptions(request),
        layout: "provisioned",
      }),
    );
  }
  const bound = ripgrepActivationDigest(location.activation, targetKey, request.manifest);
  return attemptFrom(
    "portable",
    resolveVerifiedRipgrep(location.resourceRoot, targetKey, {
      ...verifierOptions(request),
      layout: "portable",
      ...(bound === undefined ? {} : { acceptedSha256: [bound] }),
    }),
  );
}

function rejectionOf(attempt: Attempt | undefined): OpenCodeRipgrepUnverifiedReason | undefined {
  return attempt === undefined || attempt.ok ? undefined : attempt.reason;
}

function verifiedResolution(
  attempt: Extract<Attempt, { readonly ok: true }>,
  targetKey: RipgrepRuntimeTargetKey,
  request: OpenCodeRipgrepRequest,
  overrideReason: OpenCodeRipgrepUnverifiedReason | undefined,
): OpenCodeRipgrepResolution {
  const pinned = ripgrepRuntimeApproval(targetKey, request.manifest ?? RIPGREP_RUNTIME_MANIFEST);
  return {
    outcome: "verified",
    targetKey,
    layout: attempt.layout,
    version: attempt.version,
    digestSource: attempt.sha256 === pinned?.binarySha256 ? "pinned" : "activation-bound",
    directory: dirname(attempt.path),
    ...(overrideReason === undefined ? {} : { overrideReason }),
  };
}

/**
 * Resolves, once per launch, the one ripgrep executable the run may use. An explicit override is
 * tried first (outside a packaged runtime), then the lane's own location; the first that verifies
 * wins. Nothing here reads the inherited PATH: a `rg` that merely happens to be on it is neither
 * relied on nor reported as verified.
 */
export function resolveOpenCodeRipgrep(request: OpenCodeRipgrepRequest): OpenCodeRipgrepResolution {
  const targetKey = ripgrepTargetKeyForPortableTarget(request.target);
  const override = overrideAttempt(request, targetKey);
  if (override?.ok === true) return verifiedResolution(override, targetKey, request, undefined);
  const overrideReason = rejectionOf(override);
  const layout = layoutAttempt(request, targetKey);
  if (layout?.ok === true) {
    return verifiedResolution(layout, targetKey, request, overrideReason);
  }
  const failed = layout ?? override;
  return {
    outcome: "unverified",
    targetKey,
    layout: failed?.layout ?? "none",
    reason: rejectionOf(failed) ?? "no-location",
    ...(overrideReason === undefined ? {} : { overrideReason }),
  };
}

/** `directory` first, then every inherited entry except a repeat of it. */
function prependDirectory(directory: string, path: string | undefined): string {
  const inherited =
    path === undefined || path.length === 0
      ? []
      : path.split(delimiter).filter((entry) => entry !== directory);
  return [directory, ...inherited].join(delimiter);
}

/**
 * The PATH the native profile's child and its kernel read allowlist share: the verified directory
 * in front of what the launcher already had. `undefined` leaves the inherited PATH exactly as it
 * was, so an unverified launch is not changed by this module at all.
 */
export function ripgrepNativePath(
  launcherPath: string | undefined,
  resolution: OpenCodeRipgrepResolution,
): string | undefined {
  return resolution.outcome === "verified"
    ? prependDirectory(resolution.directory, launcherPath)
    : undefined;
}

/**
 * The environment the manager copies the launch's allowlisted names from. Only a verified
 * executable changes it. The native profile inherits the launcher's PATH, so its child PATH is the
 * verified directory followed by that PATH. The mapped profiles inherit nothing else, so theirs is
 * the verified directory alone; no entry of the launcher's PATH is ever relied on to find ripgrep.
 */
export function ripgrepLaunchEnvironment(
  processEnv: NodeJS.ProcessEnv | undefined,
  resolution: OpenCodeRipgrepResolution,
  native: boolean,
): NodeJS.ProcessEnv | undefined {
  if (resolution.outcome !== "verified") return processEnv;
  const path = native
    ? prependDirectory(resolution.directory, processEnv?.PATH)
    : resolution.directory;
  return { ...(processEnv ?? {}), PATH: path };
}

/** The mapped profiles inherit no names; they inherit PATH only to carry the verified directory. */
export function ripgrepMappedInheritedEnvNames(
  resolution: OpenCodeRipgrepResolution,
): readonly string[] {
  return resolution.outcome === "verified" ? ["PATH"] : [];
}

/** One body-free line per launch. Never the path, only closed words, the version and the target. */
export function recordOpenCodeRipgrepResolution(
  sink: ServerLogSink,
  runId: string,
  native: boolean,
  resolution: OpenCodeRipgrepResolution,
): void {
  const verified = resolution.outcome === "verified";
  sink.write(
    activityLogEvent(
      RIPGREP_RESOLVED_OPERATION,
      { level: verified ? "info" : "warn", correlationId: runId },
      {
        targetKey: resolution.targetKey,
        outcome: resolution.outcome,
        layout: resolution.layout,
        toolProfile: native ? "native" : "mapped",
        ...(resolution.outcome === "unverified" ? { reason: resolution.reason } : {}),
        ...(resolution.overrideReason === undefined
          ? {}
          : { overrideReason: resolution.overrideReason }),
        ...(resolution.outcome === "verified"
          ? { digestSource: resolution.digestSource, version: resolution.version }
          : {}),
      },
    ),
  );
}
