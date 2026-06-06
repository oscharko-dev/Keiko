// Shared verification-test fixtures: a temp workspace with a controllable package.json, a fake
// SpawnFn (reusing the recordingSpawn/makeFakeChild pattern from tests/tools/_support.ts), a fake
// ResourceMonitor whose breach can be fired deterministically, and an in-memory WorkspaceFs.

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { SpawnFn, SpawnOptions } from "@oscharko-dev/keiko-tools";
import type { WorkspaceFs, WorkspaceInfo, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import type { ResourceMonitor } from "./monitor.js";

export interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  killed: NodeJS.Signals[];
}

export function makeFakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killed = [];
  child.kill = (signal?: NodeJS.Signals): boolean => {
    child.killed.push(signal ?? "SIGTERM");
    return true;
  };
  return child;
}

export interface SpawnRecorder {
  readonly fn: SpawnFn;
  readonly calls: () => readonly {
    command: string;
    args: readonly string[];
    options: SpawnOptions;
  }[];
  readonly child: FakeChild;
}

// A fake spawn returning a controllable child, recording every invocation so a denied-command or
// skipped-step test can assert the spawn was NEVER called.
export function recordingSpawn(child: FakeChild = makeFakeChild()): SpawnRecorder {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  return {
    child,
    calls: () => calls,
    fn: (command, args, options): ChildProcess => {
      calls.push({ command, args: [...args], options });
      return child as unknown as ChildProcess;
    },
  };
}

// Closes the child on the next microtask so runCommand wires its listeners first. `scenario`
// drives the streams and exit: emit output, then a close with the given exit code/signal.
export function scriptChildClose(
  child: FakeChild,
  opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  },
): void {
  queueMicrotask(() => {
    if (opts.stdout !== undefined) {
      child.stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    }
    if (opts.stderr !== undefined) {
      child.stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    }
    child.emit("close", opts.exitCode ?? 0, opts.signal ?? null);
  });
}

export interface FakeMonitor extends ResourceMonitor {
  // Fires the most recently registered onBreach callback (simulates the RSS sampler tripping).
  readonly breach: () => void;
  readonly watched: () => readonly { pid: number | undefined; maxBytes: number | undefined }[];
  readonly stopped: () => number;
}

export function fakeMonitor(): FakeMonitor {
  const watched: { pid: number | undefined; maxBytes: number | undefined }[] = [];
  let lastBreach: (() => void) | undefined;
  let stopCount = 0;
  return {
    watched: () => watched,
    stopped: () => stopCount,
    breach: (): void => lastBreach?.(),
    watch: (pid, maxBytes, onBreach): (() => void) => {
      watched.push({ pid, maxBytes });
      lastBreach = onBreach;
      return (): void => {
        stopCount += 1;
      };
    },
  };
}

export interface TempWorkspace {
  readonly root: string;
  readonly info: WorkspaceInfo;
  readonly writeFile: (relPath: string, content: string) => void;
}

export function makeWorkspace(opts?: {
  scripts?: Record<string, string>;
  testFramework?: WorkspaceInfo["testFramework"];
  name?: string;
}): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), "keiko-verify-"));
  const pkg = { name: opts?.name ?? "demo", scripts: opts?.scripts ?? {} };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  const info: WorkspaceInfo = {
    root,
    name: pkg.name,
    version: undefined,
    testFramework: opts?.testFramework ?? "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return {
    root,
    info,
    writeFile: (relPath, content): void => {
      const abs = join(root, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    },
  };
}

// An in-memory WorkspaceFs over a fixed file map keyed by ABSOLUTE path, for tests that must not
// touch the real filesystem. Only the operations detect/plan use are implemented.
export function memoryFs(files: Record<string, string>): WorkspaceFs {
  const get = (p: string): string => {
    const value = files[p];
    if (value === undefined) {
      throw new Error(`ENOENT: ${p}`);
    }
    return value;
  };
  return {
    readFileUtf8: (absolutePath: string): string => get(absolutePath),
    stat: (absolutePath: string): WorkspaceStat => ({
      size: Buffer.byteLength(get(absolutePath), "utf8"),
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }),
    readDir: () => [],
    realPath: (absolutePath: string): string => absolutePath,
    exists: (absolutePath: string): boolean => files[absolutePath] !== undefined,
  };
}
