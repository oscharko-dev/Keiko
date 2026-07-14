import type {
  DebugRuntimeDirectoryIdentity,
  Layer2DebugCapsulePlan,
  PosixDebugEndpointPlan,
} from "./debugCapsulePlan.js";
import { lstat, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { getuid } from "node:process";
import { createDapFrameReader, writeDapFrame, type DapByteSource } from "./dapFrameCodec.js";
import { isSafeDapSocketBasename } from "./debugLaunchSecurityPredicates.js";

export interface DapPrivateEndpointConnection {
  readonly source: DapByteSource;
  readonly sendFrame: (body: string) => void;
  close(): Promise<void>;
  destroy(): void;
}

export interface DapPrivateEndpointDeps {
  readonly platform: NodeJS.Platform;
  readonly inspectDirectory: (path: string) => Promise<{
    readonly mode: string;
    readonly owner: string;
    readonly device?: number | undefined;
    readonly inode?: number | undefined;
    readonly modeBits?: number | undefined;
    readonly ownerUid?: number | undefined;
  }>;
  readonly inspectSocket: (
    path: string,
  ) => Promise<{ readonly type: string; readonly owner: string; readonly symlink: boolean }>;
  readonly realpath: (path: string) => Promise<string>;
  readonly connect: (path: string) => Promise<DapPrivateEndpointConnection>;
  readonly connectWindowsPipe?:
    ((pipeName: string) => Promise<DapPrivateEndpointConnection>) | undefined;
  readonly wait: (attempt: number) => Promise<void>;
  readonly maxAttempts: number;
}

export class DapPrivateEndpointError extends Error {
  public readonly code: "PRIVATE_ENDPOINT_INVALID" | "PRIVATE_ENDPOINT_UNSUPPORTED";
  public constructor(code: "PRIVATE_ENDPOINT_INVALID" | "PRIVATE_ENDPOINT_UNSUPPORTED") {
    super(code);
    this.name = "DapPrivateEndpointError";
    this.code = code;
  }
}

export function createNodeDapPrivateEndpointDeps(): DapPrivateEndpointDeps {
  return {
    platform: process.platform,
    inspectDirectory: async (path): ReturnType<DapPrivateEndpointDeps["inspectDirectory"]> => {
      const stats = await lstat(path);
      return {
        mode: fileMode(stats.mode),
        owner: ownerClass(stats.uid),
        device: stats.dev,
        inode: stats.ino,
        modeBits: stats.mode,
        ownerUid: stats.uid,
      };
    },
    inspectSocket: async (
      path,
    ): Promise<{ readonly type: string; readonly owner: string; readonly symlink: boolean }> => {
      const stats = await lstat(path);
      return {
        type: stats.isSocket() ? "socket" : "other",
        owner: ownerClass(stats.uid),
        symlink: stats.isSymbolicLink(),
      };
    },
    realpath,
    connect: connectNodeSocket,
    wait: (attempt) => waitForAttempt(attempt),
    maxAttempts: 100,
  };
}

function fileMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function ownerClass(uid: number): string {
  const readUid = getuid as () => number;
  return classifyEndpointOwner(uid, readUid());
}

export function classifyEndpointOwner(uid: number, currentUid: number): string {
  return uid === currentUid ? "currentUser" : "other";
}

function waitForAttempt(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(100, attempt * 5)).unref();
  });
}

async function connectNodeSocket(path: string): Promise<DapPrivateEndpointConnection> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return nodeSocketConnection(socket);
}

function nodeSocketConnection(socket: Socket): DapPrivateEndpointConnection {
  return {
    source: createDapFrameReader(socket),
    sendFrame: (body): void => {
      writeDapFrame(socket, body);
    },
    close: () => closeDapPrivateEndpointSocket(socket),
    destroy: (): void => {
      socket.destroy();
    },
  };
}

export function closeDapPrivateEndpointSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => socket.destroy(), 250);
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.end();
  });
}

export async function connectPrivateDapEndpoint(
  plan: Layer2DebugCapsulePlan,
  deps: DapPrivateEndpointDeps,
): Promise<DapPrivateEndpointConnection> {
  if (plan.endpoint.kind === "windowsPipe") {
    if (deps.platform !== "win32" || deps.connectWindowsPipe === undefined) {
      throw new DapPrivateEndpointError("PRIVATE_ENDPOINT_UNSUPPORTED");
    }
    return deps.connectWindowsPipe(plan.endpoint.pipeName);
  }
  if (deps.platform === "win32") {
    throw new DapPrivateEndpointError("PRIVATE_ENDPOINT_UNSUPPORTED");
  }
  const endpoint = plan.endpoint;
  assertPosixEndpointPlan(plan, endpoint);
  await waitForSafeSocket(endpoint.hostRuntimeDirectory, endpoint.hostSocketPath, deps);
  await assertCurrentRuntimeDirectory(endpoint, plan.spawnEnvelope.runtimeDirectoryIdentity, deps);
  return deps.connect(endpoint.hostSocketPath);
}

async function assertCurrentRuntimeDirectory(
  endpoint: PosixDebugEndpointPlan,
  identity: DebugRuntimeDirectoryIdentity,
  deps: DapPrivateEndpointDeps,
): Promise<void> {
  const [directory, realPath] = await Promise.all([
    deps.inspectDirectory(endpoint.hostRuntimeDirectory),
    deps.realpath(endpoint.hostRuntimeDirectory),
  ]);
  const current =
    realPath === endpoint.hostRuntimeDirectory &&
    realPath === identity.realPath &&
    endpoint.runtimeIdentity === identity.identityDigest &&
    directory.device === identity.device &&
    directory.inode === identity.inode &&
    directory.modeBits === identity.mode &&
    directory.ownerUid === identity.ownerUid;
  if (!current) throw new DapPrivateEndpointError("PRIVATE_ENDPOINT_INVALID");
}

function assertPosixEndpointPlan(
  plan: Layer2DebugCapsulePlan,
  endpoint: PosixDebugEndpointPlan,
): void {
  const mount = plan.capsule.runtimeMount;
  const contained =
    dirname(endpoint.hostSocketPath) === endpoint.hostRuntimeDirectory &&
    dirname(endpoint.capsuleSocketPath) === endpoint.capsuleRuntimeDirectory;
  const safe =
    isSafeDapSocketBasename(basename(endpoint.hostSocketPath)) &&
    isSafeDapSocketBasename(basename(endpoint.capsuleSocketPath));
  const runtimeMount = mount as unknown as Readonly<Record<string, unknown>>;
  const bound =
    mount.hostPath === endpoint.hostRuntimeDirectory &&
    mount.capsulePath === endpoint.capsuleRuntimeDirectory &&
    runtimeMount.mode === "0700" &&
    runtimeMount.writable === true &&
    plan.capsule.runtimeIdentityDigest === plan.runtimeIdentityDigest;
  const bounded =
    Buffer.byteLength(endpoint.hostSocketPath) <= 100 &&
    Buffer.byteLength(endpoint.capsuleSocketPath) <= 100;
  if (![contained, safe, bound, bounded].every(Boolean)) {
    throw new DapPrivateEndpointError("PRIVATE_ENDPOINT_INVALID");
  }
}

async function waitForSafeSocket(
  runtimeDirectory: string,
  socketPath: string,
  deps: DapPrivateEndpointDeps,
): Promise<void> {
  const maximum =
    Number.isSafeInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : 1;
  const attempts = Array.from({ length: maximum }, (_value, index) => index + 1);
  for (const attempt of attempts) {
    try {
      await validateSocket(runtimeDirectory, socketPath, deps);
      return;
    } catch (error: unknown) {
      if (attempt === maximum) throw closedEndpointError(error);
      await deps.wait(attempt);
    }
  }
}

function closedEndpointError(error: unknown): DapPrivateEndpointError {
  return error instanceof DapPrivateEndpointError
    ? error
    : new DapPrivateEndpointError("PRIVATE_ENDPOINT_INVALID");
}

async function validateSocket(
  runtimeDirectory: string,
  socketPath: string,
  deps: DapPrivateEndpointDeps,
): Promise<void> {
  const [directory, socket, realDirectory, realSocket] = await Promise.all([
    deps.inspectDirectory(runtimeDirectory),
    deps.inspectSocket(socketPath),
    deps.realpath(runtimeDirectory),
    deps.realpath(socketPath),
  ]);
  if (
    directory.mode !== "0700" ||
    directory.owner !== "currentUser" ||
    socket.type !== "socket" ||
    socket.owner !== "currentUser" ||
    socket.symlink ||
    realDirectory !== runtimeDirectory ||
    realSocket !== socketPath
  ) {
    throw new DapPrivateEndpointError("PRIVATE_ENDPOINT_INVALID");
  }
}
