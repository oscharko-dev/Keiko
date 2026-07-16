import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
  readonly stdin: { end(data?: Uint8Array): unknown };
  readonly stdout: {
    on(event: "data" | "error", listener: ((chunk: Uint8Array) => void) | (() => void)): unknown;
  };
  readonly stderr: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown };
  kill(signal: "SIGKILL"): boolean;
  on(event: "error" | "close", listener: (code?: number | null) => void): unknown;
  once(event: "close", listener: () => void): unknown;
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
  const reaped = new Promise<void>((resolve) => child.once("close", resolve));
  return Object.freeze({
    stdin: { end: (data: Uint8Array) => child.stdin.end(data) },
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event: "error" | "close", listener: (code?: number | null) => void) =>
      child.on(event, listener),
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
    expected.sourceCommit === actual.sourceCommit &&
    expected.sourceTreeSha256 === actual.sourceTreeSha256 &&
    expected.signed === actual.signed
  );
}
