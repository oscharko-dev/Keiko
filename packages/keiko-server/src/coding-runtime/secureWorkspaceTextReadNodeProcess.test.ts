/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/unbound-method */
import { spawn as spawnChild, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createNodeSecureWorkspaceReadProcessFactory,
  type SecureWorkspaceReadNodeChild,
} from "./secureWorkspaceTextReadNodeProcess.js";
import { encodeSecureWorkspaceNativeRequest } from "./secureWorkspaceTextReadProtocol.js";
import type { PortableSecureWorkspaceReadBinding } from "./secureWorkspaceTextReadPortable.js";

const artifact = {
  target: "darwin-arm64",
  installRelativePath: "runtime/native/keiko-secure-workspace-read",
  sha256: "a".repeat(64),
  protocol: "KSR1/KSS1",
  sourceCommit: "b".repeat(40),
  sourceTreeSha256: "c".repeat(64),
  signed: true,
} as const;

const binding: PortableSecureWorkspaceReadBinding = {
  artifact,
  executable:
    "/Applications/Keiko.app/Contents/Resources/runtime/native/keiko-secure-workspace-read",
  helperSizeBytes: 1024,
  resourceRoot: "/Applications/Keiko.app/Contents/Resources",
};

function fakeChild() {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const child: SecureWorkspaceReadNodeChild = {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    on: events.on.bind(events),
    once: events.once.bind(events),
  };
  return {
    child,
    close: (code: number | null): void => {
      events.emit("close", code);
    },
    stdout,
  };
}

describe("Node secure workspace-read process adapter", () => {
  it("spawns the closed executable with fixed empty launch authority", async () => {
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn,
    });
    const process = factory.create(artifact);
    const run = process.run({
      stdin: Buffer.from("KSR1"),
      signal: new AbortController().signal,
    });

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      binding.executable,
      [],
      expect.objectContaining({
        cwd: "/Applications/Keiko.app/Contents/Resources/runtime",
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    fake.stdout.write("KSS1");
    fake.close(0);
    await expect(run).resolves.toEqual(Buffer.from("KSS1"));
  });

  it("kills and waits for close before settling cancellation", async () => {
    const fake = fakeChild();
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn: () => fake.child,
    });
    const controller = new AbortController();
    const run = factory
      .create(artifact)
      .run({ stdin: Buffer.from("KSR1"), signal: controller.signal });
    controller.abort();

    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
    let settled = false;
    void run.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.close(null);
    await expect(run).rejects.toThrow("secure-workspace-read-aborted");
  });

  // #2475 regression (Linux-deterministic, macOS pipe buffering masks it): a helper that exits
  // before reading its request surfaces EPIPE on the stdin stream; without the adapter's error
  // listener that asynchronous stream error is an uncaught exception in the server process. The
  // run itself must settle through the close path.
  it("registers a stdin error listener so an early helper exit cannot crash the process", async () => {
    const stdinEvents: string[] = [];
    const fake = fakeChild();
    const stdin = fake.child.stdin;
    const observed: SecureWorkspaceReadNodeChild = {
      ...fake.child,
      stdin: {
        end: (data?: Uint8Array): unknown => stdin.end(data),
        on: (event, listener): unknown => {
          stdinEvents.push(event);
          return stdin.on(event, listener);
        },
      },
    };
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn: () => observed,
    });
    const run = factory.create(artifact).run({
      stdin: Buffer.from("KSR1"),
      signal: new AbortController().signal,
    });
    expect(stdinEvents).toContain("error");
    fake.close(1);
    await expect(run).rejects.toThrow("secure-workspace-read-process-failed");
  });

  it("rejects any artifact other than the closed portable binding", () => {
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn: () => fakeChild().child,
    });
    expect(() => factory.create({ ...artifact, sha256: "d".repeat(64) })).toThrow(
      "secure-workspace-read-artifact-mismatch",
    );
  });
});

describe("secure helper snapshot identity", () => {
  it("refuses a richer protocol substituted after binding a legacy helper", () => {
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/verified/runtime",
      spawn: vi.fn(),
    });
    expect(() => factory.create({ ...artifact, snapshotProtocol: "KSR2/KSS2" })).toThrow(
      "secure-workspace-read-artifact-mismatch",
    );
  });

  it("refuses a larger read cap substituted after binding a legacy helper", () => {
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding: { ...binding, artifact: { ...artifact, byteCap: 65_536 } },
      safeCwd: "/verified/runtime",
      spawn: vi.fn(),
    });
    expect(() => factory.create(artifact)).toThrow("secure-workspace-read-artifact-mismatch");
  });
});

it("refuses native capability substitution after binding a legacy helper", () => {
  const factory = createNodeSecureWorkspaceReadProcessFactory({
    binding,
    safeCwd: "/verified/runtime",
    spawn: vi.fn(),
  });
  const upgraded = { ...artifact };
  Reflect.set(upgraded, "nativeProtocol", "KSR3/KSS3");
  expect(() => factory.create(upgraded)).toThrow("secure-workspace-read-artifact-mismatch");
});

it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "reaps the actual paused native helper before settling cancellation",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "native-io-reap-")));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "a.bin"), Buffer.from([0, 255]));
      const executable = join(root, "paused-read");
      execFileSync("cc", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        process.platform === "linux" ? "-D_GNU_SOURCE" : "-D_DARWIN_C_SOURCE",
        "-O2",
        "-DKSR_TEST_PAUSE_AFTER_FINAL_OPEN",
        fileURLToPath(
          new URL(
            "../../../../native/secure-workspace-read/secure_workspace_read.c",
            import.meta.url,
          ),
        ),
        "-o",
        executable,
      ]);
      const candidate = { ...artifact, nativeProtocol: "KSR3/KSS3" as const };
      let ready: (() => void) | undefined;
      const opened = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let closed = false;
      let pid: number | undefined;
      const factory = createNodeSecureWorkspaceReadProcessFactory({
        binding: { ...binding, artifact: candidate, executable },
        safeCwd: root,
        spawn: (command, args, options) => {
          const child = spawnChild(command, [...args], {
            ...options,
            stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
          });
          pid = child.pid;
          child.stdio[3]?.on("data", () => ready?.());
          child.once("close", () => {
            closed = true;
          });
          return {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            kill: child.kill.bind(child),
            on: child.on.bind(child),
            once: child.once.bind(child),
          };
        },
      });
      const controller = new AbortController();
      const running = factory.create(candidate).run({
        signal: controller.signal,
        stdin: encodeSecureWorkspaceNativeRequest({
          root: workspace,
          relativePath: "a.bin",
          operation: "read",
        }),
      });
      const rejected = expect(running).rejects.toThrow("secure-workspace-read-aborted");
      await opened;
      expect(closed).toBe(false);
      controller.abort();
      await rejected;
      expect(closed).toBe(true);
      const ownedPid = pid;
      if (ownedPid === undefined) throw new Error("helper-test-pid-missing");
      expect(() => process.kill(ownedPid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
