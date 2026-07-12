import { describe, expect, it, vi } from "vitest";

import {
  createSecureWorkspaceReadProcessPort,
  type SecureWorkspaceReadChild,
  type SecureWorkspaceReadProcessSpawn,
  type SecureWorkspaceTextReadProcess,
} from "./secureWorkspaceTextReadProcess.js";

type Listener = (code?: number | null) => void;
type DataListener = (chunk: Uint8Array) => void;

function fakeChild(): {
  readonly child: SecureWorkspaceReadChild;
  readonly close: (code: number | null) => void;
  readonly emitStdout: (chunk: Uint8Array) => void;
  readonly emitStderr: (chunk: Uint8Array) => void;
  readonly end: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly reap: ReturnType<typeof vi.fn>;
} {
  const closeListeners: Listener[] = [];
  const errorListeners: Listener[] = [];
  const stdoutListeners: DataListener[] = [];
  const stderrListeners: DataListener[] = [];
  const end = vi.fn();
  const kill = vi.fn();
  const reap = vi.fn(() => Promise.resolve());
  return {
    child: {
      stdout: {
        on: (event, listener): void => {
          if (event === "data") stdoutListeners.push(listener);
        },
      },
      stderr: {
        on: (_event, listener): void => {
          stderrListeners.push(listener);
        },
      },
      stdin: { end },
      on: (event, listener): void => {
        if (event === "close") closeListeners.push(listener);
        else errorListeners.push(listener);
      },
      kill,
      reap,
    },
    close: (code): void => {
      for (const listener of closeListeners) listener(code);
    },
    emitStdout: (chunk): void => {
      for (const listener of stdoutListeners) listener(chunk);
    },
    emitStderr: (chunk): void => {
      for (const listener of stderrListeners) listener(chunk);
    },
    end,
    kill,
    reap,
  };
}

function processPort(
  spawn: SecureWorkspaceReadProcessSpawn["spawn"],
): SecureWorkspaceTextReadProcess {
  return createSecureWorkspaceReadProcessPort({
    executable: "/verified/runtime/native/keiko-secure-workspace-read",
    cwd: "/server-safe-cwd",
    spawn: { spawn },
  });
}

describe("secure workspace text-read supervised process", () => {
  it("uses only a fixed absolute helper, empty argv, no shell, safe cwd, and empty environment", async () => {
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const port = processPort(spawn);
    const input = Buffer.from("KSR1-root-and-path", "utf8");
    const run = port.run({ stdin: input, signal: new AbortController().signal });

    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      command: "/verified/runtime/native/keiko-secure-workspace-read",
      args: [],
      shell: false,
      cwd: "/server-safe-cwd",
      env: {},
    });
    expect(fake.end).toHaveBeenCalledExactlyOnceWith(input);
    fake.emitStdout(Buffer.from("KSS1"));
    fake.close(0);
    await expect(run).resolves.toEqual(Buffer.from("KSS1"));
    expect(fake.reap).toHaveBeenCalledOnce();
  });

  it("awaits reap before settling cancellation and never queues a killed helper", async () => {
    const fake = fakeChild();
    let releaseReap: (() => void) | undefined;
    fake.reap.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseReap = resolve;
      }),
    );
    const port = processPort(() => fake.child);
    const controller = new AbortController();
    const run = port.run({ stdin: Buffer.from("request"), signal: controller.signal });
    controller.abort();

    await Promise.resolve();
    expect(fake.kill).toHaveBeenCalledOnce();
    await expect(
      Promise.race([
        run.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("open"),
      ]),
    ).resolves.toBe("open");
    releaseReap?.();
    await expect(run).rejects.toThrow("secure-workspace-read-aborted");
  });

  it.each([
    [
      "crash",
      (fake: ReturnType<typeof fakeChild>): void => {
        fake.close(1);
      },
    ],
    [
      "truncated output",
      (fake: ReturnType<typeof fakeChild>): void => {
        fake.emitStdout(Buffer.from("KSS1\x01", "binary"));
        fake.close(0);
      },
    ],
  ])("closes and reaps a %s before exposing the bounded raw response", async (_label, emit) => {
    const fake = fakeChild();
    const port = processPort(() => fake.child);
    const run = port.run({ stdin: Buffer.from("request"), signal: new AbortController().signal });

    emit(fake);
    if (_label === "crash")
      await expect(run).rejects.toThrow("secure-workspace-read-process-failed");
    else await expect(run).resolves.toEqual(Buffer.from("KSS1\x01", "binary"));
    expect(fake.reap).toHaveBeenCalledOnce();
  });

  it("kills, reaps, and rejects on any stderr output or stdout overflow", async () => {
    const stderrFake = fakeChild();
    const stderrPort = processPort(() => stderrFake.child);
    const stderrRun = stderrPort.run({
      stdin: Buffer.from("request"),
      signal: new AbortController().signal,
    });
    stderrFake.emitStderr(Buffer.from("private OS detail", "utf8"));
    await expect(stderrRun).rejects.toThrow("secure-workspace-read-stderr");
    expect(stderrFake.kill).toHaveBeenCalledOnce();
    expect(stderrFake.reap).toHaveBeenCalledOnce();

    const overflowFake = fakeChild();
    const overflowPort = processPort(() => overflowFake.child);
    const overflowRun = overflowPort.run({
      stdin: Buffer.from("request"),
      signal: new AbortController().signal,
    });
    overflowFake.emitStdout(Buffer.alloc(65_549));
    await expect(overflowRun).rejects.toThrow("secure-workspace-read-aborted");
    expect(overflowFake.kill).toHaveBeenCalledOnce();
    expect(overflowFake.reap).toHaveBeenCalledOnce();
  });
});
