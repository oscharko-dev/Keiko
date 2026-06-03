// Shared tool-test fixtures: a temp workspace, a fake spawn that scripts child behaviour, and a
// recording WorkspaceWriter. No real processes or secrets for the unit paths; the integration
// tests use the real node:child_process spawn via nodeSpawnFn.

import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { SpawnFn, SpawnOptions } from "./exec.js";
import type { WorkspaceWriter } from "./writer.js";

export function makeWorkspace(): { root: string; info: WorkspaceInfo } {
  const root = mkdtempSync(join(tmpdir(), "keiko-tools-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
  const info: WorkspaceInfo = {
    root,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return { root, info };
}

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

// A fake spawn returning a controllable child. Records every invocation so a denied-command test
// can assert the spawn was NEVER called.
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

export interface WriterRecorder {
  readonly writer: WorkspaceWriter;
  readonly writes: () => readonly { path: string; content: string }[];
  readonly removes: () => readonly string[];
}

// A recording writer; failOn (absolute path) throws to exercise rollback.
export function recordingWriter(failOn?: string): WriterRecorder {
  const writes: { path: string; content: string }[] = [];
  const removes: string[] = [];
  return {
    writes: () => writes,
    removes: () => removes,
    writer: {
      writeFileUtf8: (absPath, content): void => {
        if (absPath === failOn) {
          throw new Error("disk full");
        }
        writes.push({ path: absPath, content });
      },
      mkdirp: (): void => {
        // No-op: the recording writer keeps everything in memory.
      },
      remove: (absPath): void => {
        removes.push(absPath);
      },
      rename: (): void => {
        // No-op: the patch workflow does not exercise rename in these tests.
      },
    },
  };
}
