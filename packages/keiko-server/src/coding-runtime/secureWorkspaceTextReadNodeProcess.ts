import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { secureWorkspaceReadArtifactByteCap } from "./secureWorkspaceTextReadArtifact.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";
import {
  createSecureWorkspaceReadProcessPort,
  type SecureWorkspaceReadChild,
  type SecureWorkspaceReadProcessSpawn,
  type SecureWorkspaceTextReadProcessFactory,
} from "./secureWorkspaceTextReadProcess.js";
import type { PortableSecureWorkspaceReadBinding } from "./secureWorkspaceTextReadPortable.js";

interface NodeSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, never>>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

export interface SecureWorkspaceReadNodeChild {
  readonly stdin: {
    end(data?: Uint8Array): void;
    on(event: "error", listener: (error: unknown) => void): void;
  };
  readonly stdout: {
    on(event: "data" | "error", listener: ((chunk: Uint8Array) => void) | (() => void)): void;
  };
  readonly stderr: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
  kill(signal: "SIGKILL"): boolean;
  on(event: "error" | "close", listener: (code?: number | null) => void): void;
  once(event: "close", listener: () => void): void;
}

export type SecureWorkspaceReadNodeSpawn = (
  command: string,
  args: readonly [],
  options: NodeSpawnOptions,
) => SecureWorkspaceReadNodeChild;

export interface NodeSecureWorkspaceReadProcessFactoryOptions {
  readonly binding: PortableSecureWorkspaceReadBinding;
  readonly safeCwd: string;
  readonly spawn?: SecureWorkspaceReadNodeSpawn | undefined;
}

export function createNodeSecureWorkspaceReadProcessFactory(
  options: NodeSecureWorkspaceReadProcessFactoryOptions,
): SecureWorkspaceTextReadProcessFactory {
  const spawn = nodeProcessSpawn(options.spawn ?? spawnNodeChild);
  return Object.freeze({
    create: (artifact: SecureWorkspaceTextReadArtifact) => {
      if (!sameArtifact(options.binding.artifact, artifact))
        throw new Error("secure-workspace-read-artifact-mismatch");
      return createSecureWorkspaceReadProcessPort({
        executable: options.binding.executable,
        cwd: options.safeCwd,
        spawn,
        ...(artifact.nativeProtocol === undefined
          ? {}
          : { nativeProtocol: artifact.nativeProtocol }),
        ...(artifact.snapshotProtocol === undefined
          ? {}
          : { snapshotProtocol: artifact.snapshotProtocol }),
      });
    },
  });
}

function spawnNodeChild(
  command: string,
  args: readonly [],
  options: NodeSpawnOptions,
): ChildProcessWithoutNullStreams {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function nodeProcessSpawn(spawn: SecureWorkspaceReadNodeSpawn): SecureWorkspaceReadProcessSpawn {
  return Object.freeze({
    spawn: (request: Parameters<SecureWorkspaceReadProcessSpawn["spawn"]>[0]) =>
      adaptNodeChild(spawn(request.command, [], nodeOptions(request.cwd))),
  });
}

function nodeOptions(cwd: string): NodeSpawnOptions {
  const options: NodeSpawnOptions = {
    cwd,
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  return Object.freeze(options);
}

function adaptNodeChild(child: SecureWorkspaceReadNodeChild): SecureWorkspaceReadChild {
  const reaped = new Promise<void>((resolve) => {
    child.once("close", resolve);
  });
  // A helper that dies before reading its request surfaces EPIPE on the stdin stream. Without a
  // listener that asynchronous stream error is an uncaught exception in the server process; the
  // close path already settles the one-shot run as a process failure, so the write error itself
  // carries no additional signal.
  child.stdin.on("error", () => undefined);
  return Object.freeze({
    stdin: {
      end: (data: Uint8Array): void => {
        child.stdin.end(data);
      },
    },
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event: "error" | "close", listener: (code?: number | null) => void): void => {
      child.on(event, listener);
    },
    kill: () => {
      child.kill("SIGKILL");
    },
    reap: () => reaped,
  });
}

function sameArtifact(
  expected: SecureWorkspaceTextReadArtifact,
  actual: SecureWorkspaceTextReadArtifact,
): boolean {
  return (
    expected.target === actual.target &&
    expected.installRelativePath === actual.installRelativePath &&
    expected.sha256 === actual.sha256 &&
    expected.protocol === actual.protocol &&
    expected.snapshotProtocol === actual.snapshotProtocol &&
    expected.nativeProtocol === actual.nativeProtocol &&
    secureWorkspaceReadArtifactByteCap(expected) === secureWorkspaceReadArtifactByteCap(actual) &&
    expected.sourceCommit === actual.sourceCommit &&
    expected.sourceTreeSha256 === actual.sourceTreeSha256 &&
    expected.signed === actual.signed
  );
}
