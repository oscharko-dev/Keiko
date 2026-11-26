// #4492 (ADR-0043 D21): the patched Node.js a confined Windows verification step runs. Official
// Node.js 26.13.1 hangs inside an AppContainer on any child with piped stdio, a fork or
// `node --test` (libuv#5181, fixed in libuv 1.53, which no official Node.js carries yet), so the
// runtime package carries a build of 26.13.1 plus that fix at `runtime/step-node/node.exe`. It is
// offered to the steps only when its bytes match the pin compiled into this server; without a
// verified one a step runs exactly as it did before, and the log says so. Closed values only: never
// a path.

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { WindowsStepNode } from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { NPM_LANE_RUNTIME_APPROVALS } from "../coding-runtime/npmLaneRuntimeApprovals.js";
import type { NpmLaneStepNodeApproval } from "../coding-runtime/npmLaneRuntimeApprovals.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

const WINDOWS_STEP_NODE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.windows-step-node",
  category: "process",
  owner: "keiko-server",
  emitter: "editor.windowsStepNode.record",
  fields: {
    image: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["step-node", "resolved"],
    },
    npmLaunch: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["step-node", "install-cmd", "not-npm"],
    },
    npmFallback: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "cli-missing", "cli-outside-grant"],
    },
    pathPrefixed: { type: "boolean", dataClass: "closed-enum", required: true },
    placement: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["applied", "inside-execution-root"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  // A step that cannot use the patched Node.js hangs on a piped child: the decision is the evidence.
  failureClasses: ["runtime-confinement-unavailable"],
  proofIds: ["editor.verification.windows-step-node.emitted-line"],
  releaseImpact: "patch",
});

/** Where the runtime keeps it, beside `native/`, and the one file the folder may hold. */
export const STEP_NODE_DIRECTORY_NAME = "step-node";
export const STEP_NODE_FILE_NAME = "node.exe";

/** What discovery found: the verified build, none at all, or one that is not the pinned build. */
export type StepNodeResolution =
  | {
      readonly outcome: "patched";
      readonly directory: string;
      readonly executable: string;
    }
  | { readonly outcome: "absent" | "mismatch" };

/** The pin this server carries for the Windows step Node.js. */
export function windowsStepNodePin(): NpmLaneStepNodeApproval | undefined {
  return NPM_LANE_RUNTIME_APPROVALS["windows-x64"].stepNode;
}

const READ_CHUNK_BYTES = 4 * 1024 * 1024;

// The digest of a large file without holding it in memory.
function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function isOrdinaryFile(path: string, sizeBytes: number): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  return (
    entry !== undefined &&
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === 1 &&
    entry.size === sizeBytes
  );
}

/**
 * The runtime's step Node.js, verified against `pin`. It lives in `step-node/` beside the runtime's
 * `native/` folder, which holds the supervisor `supervisorPath` names. The folder is granted to the
 * step as a whole, so it must be a real folder (no link or junction) that holds exactly the one
 * pinned file; anything else is not the build the pin describes.
 */
export function resolveStepNode(input: {
  readonly supervisorPath: string | undefined;
  readonly pin: NpmLaneStepNodeApproval | undefined;
  readonly isDirectory: (path: string) => boolean;
  readonly correlationId: string | undefined;
}): StepNodeResolution {
  const { supervisorPath, pin } = input;
  if (supervisorPath === undefined || pin === undefined) return { outcome: "absent" };
  const directory = join(dirname(dirname(supervisorPath)), STEP_NODE_DIRECTORY_NAME);
  if (lstatSync(directory, { throwIfNoEntry: false }) === undefined) return { outcome: "absent" };
  const executable = join(directory, STEP_NODE_FILE_NAME);
  try {
    const exact =
      input.isDirectory(directory) &&
      readdirSync(directory).length === 1 &&
      isOrdinaryFile(executable, pin.sizeBytes) &&
      sha256OfFile(executable) === pin.sha256;
    return exact ? { outcome: "patched", directory, executable } : { outcome: "mismatch" };
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "editor.verification.windows-step-supervisor.step-node-unreadable",
        source: "editor.verification.windows-step-supervisor",
        error,
        redact: () => "The Windows step Node.js could not be read to verify it.",
      }),
    );
    return { outcome: "mismatch" };
  }
}

/** The verified build as the steps receive it, recording each step's launch decision. */
export function windowsStepNodeFor(
  resolution: Extract<StepNodeResolution, { outcome: "patched" }>,
  log: { readonly activityLog: ServerLogSink; readonly correlationId?: string | undefined },
): WindowsStepNode {
  return {
    directory: resolution.directory,
    executable: resolution.executable,
    record: (decision): void => {
      log.activityLog.write(
        activityLogEvent(
          WINDOWS_STEP_NODE_OPERATION,
          { correlationId: log.correlationId ?? UNKNOWN_CORRELATION_ID },
          { ...decision },
        ),
      );
    },
  };
}
