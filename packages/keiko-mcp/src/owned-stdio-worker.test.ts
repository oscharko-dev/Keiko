import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { runOwnedStdio } from "./owned-stdio-process.js";
import { runOwnedStdioWorker, workerRuntime } from "./owned-stdio-worker.js";

vi.mock("./owned-stdio-process.js", async (original) => ({
  ...(await original<typeof import("./owned-stdio-process.js")>()),
  runOwnedStdio: vi.fn(),
}));
const execute = vi.mocked(runOwnedStdio);
function runtime(): Parameters<typeof runOwnedStdioWorker>[0] & {
  args: string[];
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  unobserve: ReturnType<typeof vi.fn>;
  stop: () => void;
} {
  const unobserve = vi.fn();
  const stopOwner = vi.fn((_: number): never => {
    throw new Error("synthetic owner exit");
  });
  let stop: (() => void) | undefined;
  return {
    args: ["/synthetic/provider", "literal argument"],
    environment: {},
    platform: "linux",
    input: new PassThrough(),
    output: new PassThrough(),
    errors: new PassThrough(),
    observeStop: (listener: () => void): (() => void) => {
      stop = listener;
      return unobserve;
    },
    stopOwner,
    unobserve,
    stop: (): void => {
      stop?.();
    },
  };
}
beforeEach(() => {
  execute.mockReset().mockResolvedValue(0);
});

it.each(["unsupported-platform", "missing-command", "invalid-environment"])(
  "refuses %s before provider execution",
  async (failure) => {
    const io = runtime();
    if (failure === "unsupported-platform") io.platform = "freebsd";
    if (failure === "missing-command") io.args = [];
    if (failure === "invalid-environment") io.environment = { KEIKO_MCP_STDIO_ENV_0: "invalid" };
    if (failure === "invalid-environment")
      await expect(runOwnedStdioWorker(io)).rejects.toThrow("Local MCP process startup failed");
    else expect(await runOwnedStdioWorker(io)).toBe(78);
    expect(execute).not.toHaveBeenCalled();
    expect(io.unobserve).toHaveBeenCalledOnce();
  },
);

it("forwards literal arguments and aborts the owned execution lifetime", async () => {
  const io = runtime();
  execute.mockImplementation((options) => {
    io.stop();
    expect(options.signal.aborted).toBe(true);
    return Promise.resolve(7);
  });
  expect(await runOwnedStdioWorker(io)).toBe(7);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ command: "/synthetic/provider", args: ["literal argument"] }),
  );
  expect(io.unobserve).toHaveBeenCalledOnce();
});

it("requires the native-job launch path on Windows", async () => {
  const io = runtime();
  io.platform = "win32";
  expect(await runOwnedStdioWorker(io)).toBe(78);
  io.args = ["--native-job", "C:\\Provider\\node.exe", "literal argument"];
  expect(await runOwnedStdioWorker(io)).toBe(0);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ command: "C:\\Provider\\node.exe", stopOwner: io.stopOwner }),
  );
});

it("contains startup failures without reflecting provider data", async () => {
  const io = runtime();
  execute.mockRejectedValue(new Error("synthetic private startup data"));
  await expect(runOwnedStdioWorker(io)).rejects.toThrow("Local MCP process startup failed");
  expect(io.unobserve).toHaveBeenCalledOnce();
});

it("observes and removes both process stop signals through the real adapter", () => {
  const io = workerRuntime(process);
  const before = process.listenerCount("SIGTERM");
  const stop = vi.fn();
  const unobserve = io.observeStop(stop);
  expect(process.listenerCount("SIGTERM")).toBe(before + 1);
  const listeners = process.listeners("SIGTERM");
  expect(listeners).toContain(stop);
  stop();
  unobserve();
  expect(process.listenerCount("SIGTERM")).toBe(before);
});
