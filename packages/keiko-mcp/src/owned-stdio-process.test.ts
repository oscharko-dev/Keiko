import { ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import spawn from "cross-spawn";
import { runOwnedStdio } from "./owned-stdio-process.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
});

interface ProviderFixture {
  readonly child: ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
  readonly lifetime: AbortController;
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly errors: PassThrough;
  readonly stopOwner: (code: number) => never;
  readonly completed: Promise<number>;
}

function provider(): ProviderFixture {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(child);
  const stopOwner = vi.fn((_: number): never => {
    throw new Error("synthetic native owner exit");
  });
  const lifetime = new AbortController();
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const completed = runOwnedStdio({
    command: "C:\\Provider\\node.exe",
    args: [],
    environment: {},
    input,
    output,
    errors,
    signal: lifetime.signal,
    stopOwner,
  });
  // The injected process-exit sentinel must always have a rejection observer.
  void completed.catch(() => undefined);
  return { child, lifetime, input, output, errors, stopOwner, completed };
}

it("drains a native provider's final response and preserves its exit status", async () => {
  const io = provider();
  let response = "";
  io.output.on("data", (bytes: Buffer) => {
    response += bytes.toString();
  });
  expect(() => io.child.emit("exit", 7)).not.toThrow();
  expect(io.stopOwner).not.toHaveBeenCalled();
  io.child.stdout.end("synthetic final response\n");
  io.child.emit("close", 7);
  await expect(io.completed).rejects.toThrow("synthetic native owner exit");
  expect(response).toBe("synthetic final response\n");
  expect(io.stopOwner).toHaveBeenCalledExactlyOnceWith(7);
  expect(io.input.listenerCount("end")).toBe(0);
});

it("bounds draining when a native descendant retains the output pipe", () => {
  vi.useFakeTimers();
  const io = provider();
  expect(() => io.child.emit("exit", 7)).not.toThrow();
  expect(() => vi.advanceTimersByTime(150)).toThrow("synthetic native owner exit");
  expect(io.stopOwner).toHaveBeenCalledExactlyOnceWith(7);
});

it.each(["abort", "input-end", "output-error"])(
  "still stops the native owner immediately on %s",
  (event) => {
    const io = provider();
    expect(() => {
      if (event === "abort") {
        const stop = getEventListeners(io.lifetime.signal, "abort").at(0) as () => void;
        stop();
      }
      if (event === "input-end") io.input.emit("end");
      if (event === "output-error") io.output.emit("error", new Error("synthetic pipe failure"));
    }).toThrow("synthetic native owner exit");
    expect(io.stopOwner).toHaveBeenCalledOnce();
  },
);
