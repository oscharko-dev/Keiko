import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

/**
 * Supported external references (#3900 AC5). OpenCode can read directories outside its project
 * when the `external_directory` permission admits them. Keiko admits only the directories the
 * operator explicitly accepted in `KEIKO_CODING_EXTERNAL_READ_ROOTS` (absolute paths, separated
 * like `PATH`), read-only, through the existing boundary: the kernel read allowlist names them,
 * the policy decides each external read as an `external-file` action of the run's mode (asked in
 * Ask for approval and Supervised workspace, allowed in Full access), and nothing is ever written
 * there. The whole set is admitted or none of it: one entry that is not an existing directory
 * reached without a symbolic link, is too broad, overlaps the run or lies in a denied root
 * refuses all of them. The kernel allowlist exists on macOS only; elsewhere none is admitted.
 */
export const KEIKO_CODING_EXTERNAL_READ_ROOTS_ENV = "KEIKO_CODING_EXTERNAL_READ_ROOTS";
const EXTERNAL_READ_ROOTS_MAX = 8;

const RESOLUTION_STATES = ["absent", "admitted", "refused", "unsupported-platform"] as const;
type ExternalRootsState = (typeof RESOLUTION_STATES)[number];
const REFUSAL_REASONS = [
  "not-absolute",
  "not-directory",
  "symlinked",
  "too-broad",
  "overlaps-run",
  "denied-root",
  "too-many",
] as const;
export type ExternalRootsRefusal = (typeof REFUSAL_REASONS)[number];

export interface NativeExternalRootsResolution {
  readonly state: ExternalRootsState;
  /** The admitted roots; empty unless `admitted`. */
  readonly roots: readonly string[];
  readonly reason?: ExternalRootsRefusal | undefined;
}

export interface NativeExternalRootsInput {
  /** The operator's raw setting; absent or blank admits none. */
  readonly value: string | undefined;
  /** Whether the run's sandbox has a kernel read allowlist (macOS). */
  readonly kernelAllowlist: boolean;
  readonly workspaceRoot: string;
  readonly privateStateRoot: string;
  /** Credential stores and Keiko's own state: a root inside one is refused. */
  readonly deniedRoots: readonly string[];
}

export function resolveNativeExternalReadRoots(
  input: NativeExternalRootsInput,
): NativeExternalRootsResolution {
  const entries = (input.value ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return { state: "absent", roots: [] };
  if (!input.kernelAllowlist) return { state: "unsupported-platform", roots: [] };
  if (entries.length > EXTERNAL_READ_ROOTS_MAX)
    return { state: "refused", roots: [], reason: "too-many" };
  for (const entry of entries) {
    const reason = rootRefusal(entry, input);
    if (reason !== undefined) return { state: "refused", roots: [], reason };
  }
  return { state: "admitted", roots: [...new Set(entries)] };
}

function rootRefusal(
  root: string,
  input: NativeExternalRootsInput,
): ExternalRootsRefusal | undefined {
  if (!isAbsolute(root) || resolve(root) !== root) return "not-absolute";
  // A top-level directory or a home directory (`/Users/<name>`) would open everything beneath it.
  if (root.split("/").length <= 3) return "too-broad";
  const physical = physicalPath(root);
  if (physical === undefined || !statSync(physical).isDirectory()) return "not-directory";
  if (physical !== root) return "symlinked";
  if (overlaps(root, input.workspaceRoot) || overlaps(root, input.privateStateRoot))
    return "overlaps-run";
  return input.deniedRoots.some((denied) => inside(denied, root)) ? "denied-root" : undefined;
}

function physicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function overlaps(first: string, second: string): boolean {
  return inside(first, second) || inside(second, first);
}

const NATIVE_EXTERNAL_ROOTS_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-external-roots.resolved",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeExternalRoots.recordNativeExternalRootsResolved",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...RESOLUTION_STATES],
    },
    rootCount: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...REFUSAL_REASONS],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-external-roots.resolved.emitted-line"],
  releaseImpact: "patch",
});

/** Counts and the closed outcome only; never a path. */
export function recordNativeExternalRootsResolved(
  activityLog: ServerLogSink | undefined,
  runId: string,
  resolution: NativeExternalRootsResolution,
): void {
  activityLog?.write(
    activityLogEvent(
      NATIVE_EXTERNAL_ROOTS_RESOLVED_OPERATION,
      {
        correlationId: runId,
        ...(resolution.state === "refused" ? { level: "warn" as const } : {}),
      },
      {
        runId,
        state: resolution.state,
        rootCount: resolution.roots.length,
        ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
      },
    ),
  );
}
