import type {
  WorkspaceDescriptorUtf8Read,
  WorkspaceFileReader,
  WorkspaceFs,
  WorkspaceHardLinkPolicy,
} from "./fs.js";

export interface StructuralExecutionControl {
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal | undefined;
}

export type StructuralExecutionStopReason = "aborted" | "timeout";

export class StructuralExecutionStoppedError extends Error {
  public constructor(public readonly reason: StructuralExecutionStopReason) {
    super(`structural execution ${reason}`);
    this.name = "StructuralExecutionStoppedError";
  }
}

export function createStructuralExecutionControl(
  elapsedMsMax: number,
  nowMs: () => number = Date.now,
  signal?: AbortSignal,
  deadlineAtMs?: number,
): StructuralExecutionControl {
  const startedAtMs = nowMs();
  return {
    nowMs,
    deadlineAtMs: Math.min(
      startedAtMs + Math.max(0, elapsedMsMax),
      deadlineAtMs ?? Number.POSITIVE_INFINITY,
    ),
    ...(signal === undefined ? {} : { signal }),
  };
}

export function structuralExecutionStopped(control: StructuralExecutionControl): boolean {
  return structuralExecutionStopReason(control) !== undefined;
}

export function structuralExecutionStopReason(
  control: StructuralExecutionControl,
): StructuralExecutionStopReason | undefined {
  if (control.signal?.aborted === true) return "aborted";
  if (Number.isNaN(control.deadlineAtMs)) return "timeout";
  return control.nowMs() >= control.deadlineAtMs ? "timeout" : undefined;
}

export function assertStructuralExecutionActive(control: StructuralExecutionControl): void {
  const reason = structuralExecutionStopReason(control);
  if (reason !== undefined) throw new StructuralExecutionStoppedError(reason);
}

interface StructuralExecutionRace {
  readonly stopped: Promise<never>;
  stopReason(): StructuralExecutionStopReason | undefined;
  dispose(): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function armStructuralDeadline(remainingMs: number, onTimeout: () => void): () => void {
  let unelapsedMs = remainingMs;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    const delayMs = Math.min(unelapsedMs, MAX_TIMER_DELAY_MS);
    timer = setTimeout(
      () => {
        unelapsedMs -= delayMs;
        if (unelapsedMs <= 0) onTimeout();
        else schedule();
      },
      Math.max(0, delayMs),
    );
    timer.unref();
  };
  schedule();
  return (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

function armStructuralExecutionRace(control: StructuralExecutionControl): StructuralExecutionRace {
  let stoppedReason: StructuralExecutionStopReason | undefined;
  let rejectStopped: (error: StructuralExecutionStoppedError) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const stop = (reason: StructuralExecutionStopReason): void => {
    stoppedReason ??= reason;
    rejectStopped(new StructuralExecutionStoppedError(reason));
  };
  const onAbort = (): void => {
    stop("aborted");
  };
  control.signal?.addEventListener("abort", onAbort, { once: true });
  const remainingMs = control.deadlineAtMs - control.nowMs();
  const disposeDeadline = Number.isFinite(remainingMs)
    ? armStructuralDeadline(remainingMs, () => {
        stop("timeout");
      })
    : undefined;
  const initialReason = structuralExecutionStopReason(control);
  if (initialReason !== undefined) stop(initialReason);
  return {
    stopped,
    stopReason: () => stoppedReason,
    dispose: (): void => {
      disposeDeadline?.();
      control.signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function raceStructuralExecution<T>(
  work: Promise<T>,
  control: StructuralExecutionControl,
  discardStoppedResult?: (result: T) => Promise<void>,
): Promise<T> {
  const race = armStructuralExecutionRace(control);
  let discarded = false;
  const discard = async (result: T): Promise<void> => {
    if (discarded || discardStoppedResult === undefined) return;
    discarded = true;
    await discardStoppedResult(result);
  };
  const observedWork = work.then(async (result) => {
    if (race.stopReason() !== undefined) await discard(result);
    return result;
  });
  try {
    const result = await Promise.race([observedWork, race.stopped]);
    const reason = structuralExecutionStopReason(control);
    if (reason !== undefined) {
      await discard(result);
      throw new StructuralExecutionStoppedError(reason);
    }
    return result;
  } catch (error) {
    const reason = race.stopReason() ?? structuralExecutionStopReason(control);
    if (reason !== undefined) throw new StructuralExecutionStoppedError(reason);
    throw error;
  } finally {
    race.dispose();
  }
}

const executionSources = new WeakMap<WorkspaceFs, WorkspaceFs>();

function executionSource(fs: WorkspaceFs): WorkspaceFs {
  return executionSources.get(fs) ?? fs;
}

export function sameStructuralExecutionFs(left: WorkspaceFs, right: WorkspaceFs): boolean {
  return executionSource(left) === executionSource(right);
}

function controlledReader(
  reader: WorkspaceFileReader,
  control: StructuralExecutionControl,
): WorkspaceFileReader {
  return {
    close: (): Promise<void> => reader.close(),
    readRange: (startByte, length): Promise<Uint8Array> => {
      assertStructuralExecutionActive(control);
      return raceStructuralExecution(reader.readRange(startByte, length), control);
    },
  };
}

function optionalSynchronousReadOperations(
  fs: WorkspaceFs,
  control: StructuralExecutionControl,
): Partial<WorkspaceFs> {
  const readDescriptor = fs.readFileUtf8SameDescriptor;
  const readPrefix = fs.readFileUtf8Prefix;
  return {
    ...(readDescriptor === undefined
      ? {}
      : {
          readFileUtf8SameDescriptor: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
          ): WorkspaceDescriptorUtf8Read => {
            assertStructuralExecutionActive(control);
            return readDescriptor.call(fs, path, maxBytes, hardLinkPolicy);
          },
        }),
    ...(readPrefix === undefined
      ? {}
      : {
          readFileUtf8Prefix: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
          ): string => {
            assertStructuralExecutionActive(control);
            return readPrefix.call(fs, path, maxBytes, hardLinkPolicy);
          },
        }),
  };
}

function optionalAsynchronousReadOperations(
  fs: WorkspaceFs,
  control: StructuralExecutionControl,
): Partial<WorkspaceFs> {
  const readBytes = fs.readFileBytes;
  const readRange = fs.readFileRange;
  return {
    ...(readBytes === undefined
      ? {}
      : {
          readFileBytes: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
          ): Promise<Uint8Array> => {
            assertStructuralExecutionActive(control);
            return raceStructuralExecution(
              readBytes.call(fs, path, maxBytes, hardLinkPolicy),
              control,
            );
          },
        }),
    ...(readRange === undefined
      ? {}
      : {
          readFileRange: (
            path: string,
            startByte: number,
            length: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
          ): Promise<Uint8Array> => {
            assertStructuralExecutionActive(control);
            return raceStructuralExecution(
              readRange.call(fs, path, startByte, length, hardLinkPolicy),
              control,
            );
          },
        }),
  };
}

function optionalWorkspaceOperations(
  fs: WorkspaceFs,
  control: StructuralExecutionControl,
): Partial<WorkspaceFs> {
  const canonicalRoot = fs.canonicalWorkspaceRoot;
  const openReader = fs.openFileReader;
  return {
    ...(canonicalRoot === undefined
      ? {}
      : {
          canonicalWorkspaceRoot: (root: string): string => {
            assertStructuralExecutionActive(control);
            return canonicalRoot.call(fs, root);
          },
        }),
    ...(openReader === undefined
      ? {}
      : {
          openFileReader: async (
            path: string,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
          ): Promise<WorkspaceFileReader> => {
            assertStructuralExecutionActive(control);
            const reader = await raceStructuralExecution(
              openReader.call(fs, path, hardLinkPolicy),
              control,
              (late) => late.close(),
            );
            return controlledReader(reader, control);
          },
        }),
  };
}

/**
 * Exposes the read-only workspace surface while checking the shared request control immediately
 * before every physical operation. Write capabilities are deliberately not forwarded into
 * structural retrieval. Resource cleanup is exempt so an expired request can still close a
 * descriptor that it opened while active.
 */
export function executionControlledWorkspaceFs(
  fs: WorkspaceFs,
  control: StructuralExecutionControl,
): WorkspaceFs {
  const controlled: WorkspaceFs = {
    readFileUtf8: (path): string => {
      assertStructuralExecutionActive(control);
      return fs.readFileUtf8(path);
    },
    stat: (path) => {
      assertStructuralExecutionActive(control);
      return fs.stat(path);
    },
    readDir: (path, maxEntries) => {
      assertStructuralExecutionActive(control);
      return fs.readDir(path, maxEntries);
    },
    realPath: (path): string => {
      assertStructuralExecutionActive(control);
      return fs.realPath(path);
    },
    exists: (path): boolean => {
      assertStructuralExecutionActive(control);
      return fs.exists(path);
    },
    ...optionalSynchronousReadOperations(fs, control),
    ...optionalAsynchronousReadOperations(fs, control),
    ...optionalWorkspaceOperations(fs, control),
  };
  executionSources.set(controlled, executionSource(fs));
  return controlled;
}
