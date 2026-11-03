import { closeSync, constants, openSync, readSync, statfsSync } from "node:fs";

export type ProcessLiveness = "alive" | "dead" | "unknown";
export type ProcessScopeKind = "local" | "outer-native" | "outer-unprobed";
export type ProcessScopeObservation = "local" | "ready" | "unavailable" | "unprobed";

export interface ProcessScopePort {
  readonly pid: number;
  readonly kind: ProcessScopeKind;
  readonly probe: (pid: number) => ProcessLiveness;
  readonly observation?: () => "ready" | "unavailable";
  readonly fileOwnerUid?: (
    descriptor: number,
    dev: bigint,
    ino: bigint,
    mode: bigint,
  ) => bigint | undefined;
}

export interface ProcessScope {
  readonly bind: (port: ProcessScopePort) => void;
  readonly pid: () => number;
  readonly kind: () => ProcessScopeKind;
  readonly observation: () => ProcessScopeObservation;
  readonly liveness: (pid: number) => ProcessLiveness;
  readonly fileOwnerUid: (
    descriptor: number,
    dev: bigint,
    ino: bigint,
    mode: bigint,
  ) => bigint | undefined;
}

export function isProcessId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

/** Positive kernel metadata only; absence or a substituted filesystem cannot establish identity. */
export function readProcessNamespaceIds(): readonly number[] {
  const descriptor = openSync(
    "/proc/self/status",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    // Node opens descriptors close-on-exec. Inspect the held object through its kernel FD entry.
    if (statfsSync(`/proc/self/fd/${String(descriptor)}`).type !== 0x9fa0)
      throw new Error("process scope procfs required");
    const bytes = Buffer.alloc(16 * 1024);
    const size = readSync(descriptor, bytes, 0, bytes.length, null);
    if (size === bytes.length) throw new Error("process scope status exceeds bound");
    const content = bytes.subarray(0, size).toString("utf8");
    const pids = namespaceIds(content, "NSpid");
    const threads = namespaceIds(content, "NStgid");
    if (pids.join(" ") !== threads.join(" ") || pids.at(-1) !== process.pid)
      throw new Error("process scope coordinates do not match");
    return pids;
  } finally {
    closeSync(descriptor);
  }
}

function namespaceIds(content: string, field: string): readonly number[] {
  const lines = content.split("\n").filter((line) => line.startsWith(`${field}:`));
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) throw new Error("process scope identity absent");
  const raw = line.slice(field.length + 1).trim();
  if (!/^[1-9]\d*(?:[ \t]+[1-9]\d*)*$/u.test(raw))
    throw new Error("process scope identity invalid");
  const ids = raw.split(/[ \t]+/u).map(Number);
  if (!ids.every(isProcessId)) throw new Error("process scope identity invalid");
  return ids;
}

function localLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
      ? "dead"
      : "unknown";
  }
}

function defaultPort(): ProcessScopePort {
  const ids = process.platform === "linux" ? readProcessNamespaceIds() : [process.pid];
  const pid = ids[0];
  if (pid === undefined) throw new Error("process scope identity absent");
  const nested = ids.length !== 1;
  return {
    pid,
    kind: nested ? "outer-unprobed" : "local",
    probe: nested
      ? (target): ProcessLiveness => (target === pid ? "alive" : "unknown")
      : localLiveness,
  };
}

function observation(port: ProcessScopePort): ProcessScopeObservation {
  if (port.kind === "local") return "local";
  if (port.kind === "outer-unprobed") return "unprobed";
  try {
    return port.observation?.() === "ready" ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function liveness(port: ProcessScopePort, pid: number): ProcessLiveness {
  if (!isProcessId(pid)) return "unknown";
  try {
    const state = port.probe(pid);
    return state === "alive" || state === "dead" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

/** One coordinate per process lifetime. Binding after any identity/liveness use is refused. */
export function createProcessScope(): ProcessScope {
  let bound: ProcessScopePort | undefined;
  let used = false;
  const resolve = (): ProcessScopePort => {
    used = true;
    bound ??= defaultPort();
    return bound;
  };
  return {
    bind: (port): void => {
      if (used || bound !== undefined) throw new Error("process scope already selected");
      if (!isProcessId(port.pid) || port.kind !== "outer-native")
        throw new TypeError("process scope native identity required");
      bound = Object.freeze({
        pid: port.pid,
        kind: port.kind,
        probe: port.probe,
        ...(port.fileOwnerUid === undefined ? {} : { fileOwnerUid: port.fileOwnerUid }),
        ...(port.observation === undefined ? {} : { observation: port.observation }),
      });
    },
    pid: (): number => resolve().pid,
    kind: (): ProcessScopeKind => resolve().kind,
    observation: (): ProcessScopeObservation => observation(resolve()),
    fileOwnerUid: (descriptor, dev, ino, mode): bigint | undefined => {
      try {
        return resolve().fileOwnerUid?.(descriptor, dev, ino, mode);
      } catch {
        return undefined;
      }
    },
    liveness: (pid): ProcessLiveness => liveness(resolve(), pid),
  };
}

const scope = createProcessScope();
export const bindProcessScope = scope.bind;
export const currentProcessId = scope.pid;
export const currentProcessScopeKind = scope.kind;
export const currentProcessScopeObservation = scope.observation;
export const processLiveness = scope.liveness;
export const processFileOwnerUid = scope.fileOwnerUid;

/** Owner metadata is meaningful only in the selected process coordinate, even at overflow-UID collisions. */
export function fileDescriptorOwnerUid(
  descriptor: number,
  stat: { readonly dev: bigint; readonly ino: bigint; readonly mode: bigint; readonly uid: bigint },
): bigint | undefined {
  return scope.kind() === "local"
    ? stat.uid
    : scope.fileOwnerUid(descriptor, stat.dev, stat.ino, stat.mode);
}

/** Unknown observations retain ownership. This is the shared persistent-state probe. */
export function isProcessAlive(pid: number): boolean {
  return processLiveness(pid) !== "dead";
}
