// #4492 (ADR-0043 D21): the patched Node.js a confined Windows verification step runs. Official
// Node.js 26.13.1 hangs inside an AppContainer on any child with piped stdio, a fork or
// `node --test` (libuv#5181, fixed in libuv 1.53, which no official Node.js carries yet), so the
// runtime package carries a build of 26.13.1 plus that fix at `runtime/step-node/node.exe`. It is
// offered to the steps only when its bytes match the pin compiled into this server; without a
// verified one a step runs exactly as it did before, and the log says so. Closed values only: never
// a path.

import { lstatSync, readdirSync, type Stats } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { sha256FileAsync, sha256FileSync } from "../file-sha256.js";
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
  | { readonly outcome: "absent" }
  | { readonly outcome: "mismatch"; readonly mismatch: StepNodeMismatch };

/**
 * Which check a step Node.js missed, so a customer's log tells a stale package from a rewritten
 * file (#4496); closed values, never a path.
 */
export type StepNodeMismatch =
  "not-real-folder" | "extra-entries" | "not-ordinary-file" | "size" | "hash" | "unreadable";

/** The pin this server carries for the Windows step Node.js. */
export function windowsStepNodePin(): NpmLaneStepNodeApproval | undefined {
  return NPM_LANE_RUNTIME_APPROVALS["windows-x64"].stepNode;
}

/** The file system questions discovery asks; tests inject faults and fake stats. */
export interface StepNodeFs {
  readonly lstat: (path: string) => Stats | undefined;
  readonly readdir: (path: string) => readonly string[];
  readonly sha256: (path: string) => string;
  /** The streaming digest the asynchronous resolution uses; absent, `sha256` answers it. */
  readonly sha256Async?: (path: string) => Promise<string>;
}

const nodeStepNodeFs: StepNodeFs = {
  lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
  readdir: (path) => readdirSync(path),
  sha256: sha256FileSync,
  sha256Async: sha256FileAsync,
};

interface ResolveStepNodeInput {
  readonly supervisorPath: string | undefined;
  readonly pin: NpmLaneStepNodeApproval | undefined;
  readonly isDirectory: (path: string) => boolean;
  readonly correlationId: string | undefined;
  /** Hermetic test seam. */
  readonly fs?: StepNodeFs | undefined;
}

// A lstat of a link reports `isFile() === false`, so the link case needs no condition of its own.
// The single link count is checked on its own: a hard link shares the pinned bytes with a file the
// person can still write through another name. The bytes themselves are hashed by the caller.
function structuralMismatchOf(
  directory: string,
  executable: string,
  pin: NpmLaneStepNodeApproval,
  input: ResolveStepNodeInput,
): StepNodeMismatch | undefined {
  const fs = input.fs ?? nodeStepNodeFs;
  if (!input.isDirectory(directory)) return "not-real-folder";
  if (fs.readdir(directory).length !== 1) return "extra-entries";
  const entry = fs.lstat(executable);
  if (entry === undefined || !entry.isFile() || entry.nlink !== 1) return "not-ordinary-file";
  return entry.size === pin.sizeBytes ? undefined : "size";
}

/** A step Node.js that passed every structural check and awaits its byte comparison. */
interface PendingStepNode {
  readonly directory: string;
  readonly executable: string;
  readonly pin: NpmLaneStepNodeApproval;
}

function reportUnreadableStepNode(input: ResolveStepNodeInput, error: unknown): StepNodeResolution {
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
  return { outcome: "mismatch", mismatch: "unreadable" };
}

// Everything but the hash: the answer when it is already known, else the build to hash.
function structuralResolution(
  input: ResolveStepNodeInput,
): { readonly done: StepNodeResolution } | { readonly pending: PendingStepNode } {
  const { supervisorPath, pin } = input;
  if (supervisorPath === undefined || pin === undefined) return { done: { outcome: "absent" } };
  const directory = join(dirname(dirname(supervisorPath)), STEP_NODE_DIRECTORY_NAME);
  try {
    if ((input.fs ?? nodeStepNodeFs).lstat(directory) === undefined) {
      return { done: { outcome: "absent" } };
    }
    const executable = join(directory, STEP_NODE_FILE_NAME);
    const mismatch = structuralMismatchOf(directory, executable, pin, input);
    return mismatch === undefined
      ? { pending: { directory, executable, pin } }
      : { done: { outcome: "mismatch", mismatch } };
  } catch (error) {
    return { done: reportUnreadableStepNode(input, error) };
  }
}

// Hashed on every resolution: the folder's owner can restore every timestamp after a rewrite, so
// no metadata match proves the bytes are still the pinned build.
function hashedResolution(pending: PendingStepNode, sha256: string): StepNodeResolution {
  return sha256 === pending.pin.sha256
    ? { outcome: "patched", directory: pending.directory, executable: pending.executable }
    : { outcome: "mismatch", mismatch: "hash" };
}

/**
 * The runtime's step Node.js, verified against `pin`. It lives in `step-node/` beside the runtime's
 * `native/` folder, which holds the supervisor `supervisorPath` names. The folder is granted to the
 * step as a whole, so it must be a real folder (no link or junction) that holds exactly the one
 * pinned file; anything else is not the build the pin describes. Any failure to read it, the first
 * stat included, answers `mismatch` with a diagnostic and never aborts the verification run.
 *
 * Provenance of the pinned bytes: `.github/workflows/windows-step-node.yml` builds Node.js 26.13.1
 * from the official source tarball with `patches/node-26.13.1-libuv-5181.patch` and
 * `patches/node-26.13.1-win-crates-synchronization.patch`; the pin restates that build's receipt.
 */
export function resolveStepNode(input: ResolveStepNodeInput): StepNodeResolution {
  const structural = structuralResolution(input);
  if ("done" in structural) return structural.done;
  try {
    const fs = input.fs ?? nodeStepNodeFs;
    return hashedResolution(structural.pending, fs.sha256(structural.pending.executable));
  } catch (error) {
    return reportUnreadableStepNode(input, error);
  }
}

/**
 * `resolveStepNode` for a request path: the same checks, with the bytes streamed so the server's
 * event loop keeps serving while the build is hashed. Never cached: every call hashes the file.
 */
export async function resolveStepNodeAsync(
  input: ResolveStepNodeInput,
): Promise<StepNodeResolution> {
  const structural = structuralResolution(input);
  if ("done" in structural) return structural.done;
  try {
    const fs = input.fs ?? nodeStepNodeFs;
    const digest =
      fs.sha256Async ?? ((path: string): Promise<string> => Promise.resolve(fs.sha256(path)));
    return hashedResolution(structural.pending, await digest(structural.pending.executable));
  } catch (error) {
    return reportUnreadableStepNode(input, error);
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

/** The file and pin questions a private step Node.js copy asks; tests inject all of them. */
export interface StepNodeCopyPorts {
  readonly pin: () => NpmLaneStepNodeApproval | undefined;
  /** A new empty folder only this run can name, outside every workspace. */
  readonly makeDirectory: () => Promise<string>;
  readonly copyFile: (from: string, to: string) => Promise<void>;
  readonly sizeOf: (path: string) => Promise<number>;
  readonly sha256: (path: string) => Promise<string>;
  readonly removeDirectory: (path: string) => Promise<void>;
}

export const nodeStepNodeCopyPorts: StepNodeCopyPorts = {
  pin: windowsStepNodePin,
  makeDirectory: () => mkdtemp(join(tmpdir(), "keiko-step-node-")),
  copyFile: (from, to) => copyFile(from, to),
  sizeOf: async (path) => (await stat(path)).size,
  sha256: sha256FileAsync,
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
};

/** The step Node.js a run executes: its own private copy, or none when the copy is not the pin. */
export interface PrivateStepNode {
  readonly stepNode: WindowsStepNode | undefined;
  readonly outcome: "copied" | "no-pin" | "size" | "hash" | "copy-failed";
  /** The error behind `copy-failed`, for the caller's diagnostic; never logged here. */
  readonly failure?: unknown;
  readonly dispose: () => Promise<void>;
}

/**
 * The install's step Node.js was attested when the run was admitted, which may be long before the
 * run holds its workspace (the exclusive queue). The run therefore executes a PRIVATE copy made
 * after the queue and compared with the pin AFTER it was copied: a package replaced while the run
 * waited, or rewritten while it ran, is never what the confined step launches. A copy that is not
 * the pinned build yields no step Node.js, exactly as an install that did not match the pin does.
 */
export async function privateStepNode(
  installed: WindowsStepNode,
  ports: StepNodeCopyPorts,
): Promise<PrivateStepNode> {
  const pin = ports.pin();
  const none = (outcome: PrivateStepNode["outcome"]): PrivateStepNode => ({
    stepNode: undefined,
    outcome,
    dispose: () => Promise.resolve(),
  });
  if (pin === undefined) return none("no-pin");
  let directory: string | undefined;
  try {
    directory = await ports.makeDirectory();
    const executable = join(directory, STEP_NODE_FILE_NAME);
    await ports.copyFile(installed.executable, executable);
    const failed = await copyMismatch(ports, executable, pin);
    if (failed === undefined) {
      const made = directory;
      return {
        stepNode: { directory, executable, record: installed.record },
        outcome: "copied",
        dispose: () => ports.removeDirectory(made),
      };
    }
    await ports.removeDirectory(directory);
    return none(failed);
  } catch (error) {
    if (directory !== undefined) await ports.removeDirectory(directory).catch(() => undefined);
    return { ...none("copy-failed"), failure: error };
  }
}

async function copyMismatch(
  ports: StepNodeCopyPorts,
  executable: string,
  pin: NpmLaneStepNodeApproval,
): Promise<"size" | "hash" | undefined> {
  if ((await ports.sizeOf(executable)) !== pin.sizeBytes) return "size";
  return (await ports.sha256(executable)) === pin.sha256 ? undefined : "hash";
}
