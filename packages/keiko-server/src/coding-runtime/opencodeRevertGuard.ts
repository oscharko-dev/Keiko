import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { errorKindOf } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogErrorKindOr,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

import { NativeWriteGateTimeoutError, runNativeWorkspaceWrite } from "./nativeWriteGate.js";
import { OpenCodeV2HttpStatusError } from "./opencodeV2HttpClient.js";

/**
 * The guard around the runtime's own file writes (`session.revert.stage` and
 * `session.revert.clear`). The runtime writes whole files and Keiko can neither hand it the proven
 * contents nor make its write conditional, so the guard orders and checks instead of writing:
 *
 * - the write runs inside the workspace's native-write gate, so a save a person makes through Keiko
 *   waits for it and lands right after it (`nativeWriteGate.ts`);
 * - the files are proven byte for byte as the last step before the request;
 * - afterwards the files are read once more and the outcome is settled from them alone, with no
 *   watching and no guessing: the expected result, the proven state, or `uncertain`.
 *
 * Keiko never writes a version of a person's file back into the workspace. An edit made by a program
 * Keiko does not control inside the one HTTP round trip stays a named residual.
 */

const NO_FOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Files fingerprinted at once, so a turn that changed many files never exhausts descriptors. */
const WITNESS_BATCH = 16;
/** Attempts at reading the files after the write: a file another program holds open is retried. */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 50;

/** How a guarded runtime write ended. `done` includes a write whose answer was lost. */
export type RevertSettlement = "clean" | "response-lost";

/** Why the files could not be settled; closed, body-free. */
export const UNCERTAIN_REASONS = [
  "unexpected-content",
  "partial-write",
  "call-failed-unknown",
  "unreadable",
] as const;
export type UncertainReason = (typeof UNCERTAIN_REASONS)[number];

export type GuardedWrite<Result> =
  | { readonly kind: "changed" }
  | {
      readonly kind: "done";
      readonly settlement: RevertSettlement;
      readonly result: Result | undefined;
      /** The files' fingerprints right after the write, read inside the gate. */
      readonly landed: ReadonlyMap<string, string>;
    }
  | { readonly kind: "failed"; readonly error: unknown }
  | {
      readonly kind: "uncertain";
      readonly reason: UncertainReason;
      readonly error?: unknown;
      /** The closed kind of the last read failure, for an `unreadable` outcome. */
      readonly errorKind?: ActivityLogErrorKind;
    };

export interface GuardedWriteInput<Result> {
  readonly root: string;
  readonly files: readonly string[];
  /** The fingerprints the files must have right before the request (the proven state). */
  readonly before: ReadonlyMap<string, string>;
  /** The fingerprints a successful write leaves, where Keiko knows them (a Restore). */
  readonly after?: ReadonlyMap<string, string> | undefined;
  readonly call: () => Promise<Result>;
}

/**
 * A content-bound fingerprint of one workspace file (#3897 review): the SHA-256 of its bytes, read
 * through a descriptor that does not follow a link in the final path component (parent directories
 * are resolved as the operating system does) and is the file the metadata probe saw, or `absent`.
 * `undefined` for a path that cannot be proven: outside the portable workspace grammar, a link or
 * anything but a regular file. Size and timestamps are no witness: a same-size copy that puts the
 * old modification time back would pass them. The digest never leaves the server.
 */
export async function fileSignature(root: string, relative: string): Promise<string | undefined> {
  if (!isPortableWorkspaceRelativePath(relative)) return undefined;
  const path = join(root, ...relative.split("/"));
  const probed = lstatSync(path, { throwIfNoEntry: false });
  if (probed === undefined) return "absent";
  if (!probed.isFile()) return undefined;
  const handle = await open(path, NO_FOLLOW_READ);
  try {
    const opened = await handle.stat();
    const same = opened.isFile() && opened.ino === probed.ino && opened.dev === probed.dev;
    return same ? `sha256:${await contentDigest(handle)}` : undefined;
  } finally {
    await handle.close();
  }
}

/** Largest file the synchronous admission-time fingerprint reads (4 MiB). */
const ADMISSION_BYTES_MAX = 4_194_304;

/**
 * The fingerprint of a file as `fileSignature` reads it, synchronously, for the one moment it
 * matters: a native edit is admitted and has not run yet. `undefined` for a path that cannot be
 * proven or a file over the bound.
 */
export function fileSignatureSync(root: string, relative: string): string | undefined {
  if (!isPortableWorkspaceRelativePath(relative)) return undefined;
  const path = join(root, ...relative.split("/"));
  const probed = lstatSync(path, { throwIfNoEntry: false });
  if (probed === undefined) return "absent";
  if (!probed.isFile() || probed.size > ADMISSION_BYTES_MAX) return undefined;
  const descriptor = openSync(path, NO_FOLLOW_READ);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== probed.ino || opened.dev !== probed.dev)
      return undefined;
    return `sha256:${createHash("sha256").update(readFileSync(descriptor)).digest("hex")}`;
  } finally {
    closeSync(descriptor);
  }
}

function contentDigest(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

export async function signatures(
  root: string,
  files: readonly string[],
): Promise<readonly (string | undefined)[]> {
  const head = await Promise.all(
    files.slice(0, WITNESS_BATCH).map((file) => fileSignature(root, file)),
  );
  if (files.length <= WITNESS_BATCH) return head;
  return [...head, ...(await signatures(root, files.slice(WITNESS_BATCH)))];
}

/** The files' fingerprints, or `undefined` when one still cannot be read after a few attempts. */
async function readSettled(
  root: string,
  files: readonly string[],
): Promise<
  { readonly landed: readonly (string | undefined)[] } | { readonly failed: ActivityLogErrorKind }
> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { landed: await signatures(root, files) }; // NOSONAR typescript:S9382 -- a retry runs only after the previous attempt failed
    } catch (error) {
      if (attempt >= READ_ATTEMPTS)
        return { failed: activityLogErrorKindOr(errorKindOf(error), "unavailable") };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_MS)); // NOSONAR typescript:S9382 -- the pause separates two attempts
  }
}

/**
 * Client errors that refuse a request before it does anything. A 408, a 429 or another 4xx that can
 * arrive while the request is being processed is not on the list.
 */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 410, 412, 415, 422,
]);

/**
 * Whether a failed request is known not to have been applied: the runtime refused it with one of the
 * listed client errors, or the connection was refused before anything was sent. Every other failure (a
 * timeout, an abort, a reset, a server error) may have happened after the runtime began writing, so
 * the files, not the error, decide, and an unchanged file is still not proof.
 */
export function provenNotApplied(error: unknown): boolean {
  if (error instanceof OpenCodeV2HttpStatusError) return REFUSED_STATUSES.has(error.status);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const cause = (error as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code;
  return code === "ECONNREFUSED" || cause === "ECONNREFUSED";
}

type FileState = "before" | "after" | "neutral" | "other";

function stateOf(
  signature: string | undefined,
  before: string | undefined,
  after: string | undefined,
): FileState {
  if (signature === undefined) return "other";
  if (after === undefined) return signature === before ? "before" : "after";
  if (after === before) return signature === before ? "neutral" : "other";
  if (signature === after) return "after";
  return signature === before ? "before" : "other";
}

type Outcome<Result> =
  | { readonly failed: false; readonly result: Result }
  | { readonly failed: true; readonly error: unknown };

/**
 * Proves the files, makes the runtime's write inside the gate and settles from what the files hold.
 * `changed`: a file was not as proven right before the request, nothing was sent. `failed`: the
 * request failed and the files show no write. `done`: the files show the write, even when its
 * answer was lost. `uncertain`: they match neither state, or the request failed after changing an
 * Undo's files whose result Keiko does not know.
 */
export function guardedNativeWrite<Result>(
  input: GuardedWriteInput<Result>,
): Promise<GuardedWrite<Result>> {
  return runNativeWorkspaceWrite(input.root, () => guardedWrite(input)).catch(
    (error: unknown): GuardedWrite<Result> => {
      // The gate gave up waiting: nothing was proven or sent, so this is a failure, not a state.
      if (error instanceof NativeWriteGateTimeoutError) return { kind: "failed", error };
      throw error;
    },
  );
}

async function guardedWrite<Result>(
  input: GuardedWriteInput<Result>,
): Promise<GuardedWrite<Result>> {
  const held = await signatures(input.root, input.files);
  const unchanged = input.files.every((file, index) => {
    const proven = input.before.get(file);
    return proven !== undefined && proven !== "unverifiable" && held[index] === proven;
  });
  if (!unchanged) return { kind: "changed" };
  const outcome: Outcome<Result> = await input.call().then(
    (result) => ({ failed: false, result }),
    (error: unknown) => ({ failed: true, error }),
  );
  const read = await readSettled(input.root, input.files);
  if ("failed" in read)
    return {
      kind: "uncertain",
      reason: "unreadable",
      error: outcome.failed ? outcome.error : undefined,
      errorKind: read.failed,
    };
  return conclude(input, outcome, read.landed);
}

/**
 * A request that was answered. An answer that wrote nothing is no application: a Restore knows what
 * its files must hold, and files still at the proven state mean the write never happened, whatever
 * the reply said.
 */
function concludeAnswered<Result>(
  input: GuardedWriteInput<Result>,
  result: Result,
  missed: boolean,
  landed: ReadonlyMap<string, string>,
): GuardedWrite<Result> {
  const expectedKnown = input.files.every((file) => input.after?.has(file) === true);
  if (expectedKnown && missed) return { kind: "uncertain", reason: "unexpected-content" };
  return { kind: "done", settlement: "clean", result, landed };
}

function conclude<Result>(
  input: GuardedWriteInput<Result>,
  outcome: Outcome<Result>,
  landed: readonly (string | undefined)[],
): GuardedWrite<Result> {
  const states = new Set(
    input.files.map((file, index) =>
      stateOf(landed[index], input.before.get(file), input.after?.get(file)),
    ),
  );
  const error = outcome.failed ? outcome.error : undefined;
  if (states.has("other")) return { kind: "uncertain", reason: "unexpected-content", error };
  const reached = states.has("after");
  const missed = states.has("before");
  if (reached && missed) return { kind: "uncertain", reason: "partial-write", error };
  const map = new Map(input.files.map((file, index) => [file, landed[index] ?? "unverifiable"]));
  if (!outcome.failed) return concludeAnswered(input, outcome.result, missed, map);
  if (!reached)
    return provenNotApplied(error)
      ? { kind: "failed", error }
      : { kind: "uncertain", reason: "call-failed-unknown", error };
  // The answer was lost after the files changed. A Restore knows their final state and proved it; an
  // Undo does not know the files it staged and cannot claim the revert.
  return input.after === undefined
    ? { kind: "uncertain", reason: "call-failed-unknown", error }
    : { kind: "done", settlement: "response-lost", result: undefined, landed: map };
}
