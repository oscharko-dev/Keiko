import * as fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessScopeKind } from "@oscharko-dev/keiko-security/process-scope";

const ownership = vi.hoisted((): { kind: ProcessScopeKind; mainThread: boolean } => ({
  kind: "local",
  mainThread: true,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});
vi.mock("@oscharko-dev/keiko-security/process-scope", async (original) => ({
  ...(await original<typeof import("@oscharko-dev/keiko-security/process-scope")>()),
  currentProcessScopeKind: (): typeof ownership.kind => ownership.kind,
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  get isMainThread(): boolean {
    return ownership.mainThread;
  },
}));

const originalPlatform = process.platform;
const launchId = "b".repeat(32);
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  ownership.kind = "local";
  ownership.mainThread = true;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

async function admission(
  platform: NodeJS.Platform,
): Promise<typeof import("./update-native-app-control.js")> {
  Object.defineProperty(process, "platform", { value: platform });
  return import("./update-native-app-control.js");
}

it.each(["linux", "win32"] as const)(
  "does not claim the private application port for an ordinary %s process",
  async (platform) => {
    const stat = vi.mocked(fs.fstatSync);
    const { currentNativeAppControl } = await admission(platform);
    await expect(currentNativeAppControl(launchId)).resolves.toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
  },
);

it.each([
  ["darwin", "local"],
  ["darwin", "outer-native"],
  ["linux", "outer-unprobed"],
  ["win32", "outer-native"],
] as const)("refuses an unowned %s process with scope %s", async (platform, kind) => {
  ownership.kind = kind;
  vi.stubEnv("KEIKO_APP_RUNTIME_OWNER", undefined);
  const stat = vi.mocked(fs.fstatSync);
  const { currentNativeAppControl } = await admission(platform);
  await expect(currentNativeAppControl(launchId)).rejects.toMatchObject({
    nativeAuthorityMayBeLive: false,
  });
  expect(stat).not.toHaveBeenCalled();
});

it.each(["darwin", "linux"] as const)(
  "refuses foreign or malformed launch identities before claiming the %s port",
  async (platform) => {
    ownership.kind = platform === "linux" ? "outer-native" : "local";
    vi.stubEnv("KEIKO_APP_RUNTIME_OWNER", "1");
    vi.stubEnv("KEIKO_UI_LAUNCH_ID", launchId);
    const stat = vi.mocked(fs.fstatSync).mockImplementation((): never => {
      throw Object.assign(new Error("fixture closed control descriptor"), { code: "EBADF" });
    });
    const { currentNativeAppControl } = await admission(platform);
    for (const supplied of ["invalid", "c".repeat(32)]) {
      await expect(currentNativeAppControl(supplied)).rejects.toMatchObject({
        nativeAuthorityMayBeLive: false,
      });
    }
    expect(stat).not.toHaveBeenCalled();
    const selected = currentNativeAppControl(launchId);
    await expect(selected).rejects.toMatchObject({ code: "EBADF" });
    expect(currentNativeAppControl(launchId)).toBe(selected);
    expect(stat).toHaveBeenCalledExactlyOnceWith(8);
  },
);

it("never lets a worker claim the main application's control descriptor", async () => {
  ownership.mainThread = false;
  vi.stubEnv("KEIKO_APP_RUNTIME_OWNER", "1");
  vi.stubEnv("KEIKO_UI_LAUNCH_ID", launchId);
  const stat = vi.mocked(fs.fstatSync);
  const { currentNativeAppControl } = await admission("darwin");
  await expect(currentNativeAppControl(launchId)).rejects.toMatchObject({
    nativeAuthorityMayBeLive: false,
  });
  expect(stat).not.toHaveBeenCalled();
});
