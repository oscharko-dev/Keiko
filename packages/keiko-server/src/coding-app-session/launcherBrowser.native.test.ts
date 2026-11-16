import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { nativeBrowserCommand, resolveLauncherBrowser } from "./launcherBrowser.js";
import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "./launcherSessionPairingPort.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const env = {
  [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: "synthetic-opener-secret-with-at-least-32-characters",
  KEIKO_UI_PORT: "1983",
};

it.each([
  {},
  { ...env, NODE_ENV: "test" },
  { ...env, KEIKO_UI_PORT: "1983junk" },
  { ...env, KEIKO_UI_PORT: "0" },
  { ...env, KEIKO_UI_PORT: "65536" },
  { ...env, [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: "short" },
])("requires trusted launcher configuration", (input) => {
  expect(resolveLauncherBrowser(input)).toBeUndefined();
  expect(execFile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("keeps all platform targets fixed and rejects unsupported combinations", () => {
  for (const target of ["default", "chrome", "firefox", "edge", "safari"] as const) {
    expect(nativeBrowserCommand(target, "http://localhost:1983", "darwin")?.command).toBe(
      "/usr/bin/open",
    );
    expect(nativeBrowserCommand(target, "http://localhost:1983", "freebsd")).toBeUndefined();
  }
  expect(nativeBrowserCommand("safari", "http://localhost:1983", "win32")).toBeUndefined();
});

it("bounds the OS opener and excludes provider and launcher secrets from its environment", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.stubEnv("KEIKO_TEST_PROVIDER_SECRET", "synthetic-provider-secret");
  try {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(null);
      return undefined as never;
    });
    expect(await resolveLauncherBrowser(env)?.open("firefox", "http://localhost:1983")).toBe(
      "opened",
    );
    const options = vi.mocked(execFile).mock.calls[0]?.[2];
    expect(options).toMatchObject({ shell: false, timeout: 5_000, maxBuffer: 1024 });
    expect(JSON.stringify(options)).not.toContain("synthetic-provider-secret");
    expect(JSON.stringify(options)).not.toContain(env[SESSION_PAIRING_LAUNCHER_SECRET_ENV]);
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(new Error("PRIVATE_NATIVE_ARGUMENT"));
      return undefined as never;
    });
    await expect(
      resolveLauncherBrowser(env)?.open("chrome", "http://localhost:1983"),
    ).rejects.toThrow("Browser launcher failed");
  } finally {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
  }
});

it("detaches a Linux browser after spawn without killing its window on handoff timeout", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  try {
    const pending = resolveLauncherBrowser(env)?.open("firefox", "http://localhost:1983");
    child.emit("spawn");
    expect(await pending).toBe("opened");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
  } finally {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  }
});
