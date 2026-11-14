import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { defaultOpenExternal } from "./lifecycle.js";

// A platform opener that starts and reports success, as `waitForExternalOpener` observes it.
function completedOpener(): EventEmitter {
  const child = Object.assign(new EventEmitter(), { unref: (): void => undefined });
  queueMicrotask(() => {
    child.emit("spawn");
    child.emit("close", 0, null);
  });
  return child;
}

async function openerSpawnOptions(platform: NodeJS.Platform): Promise<SpawnOptions> {
  spawnMock.mockImplementation(() => completedOpener());
  await defaultOpenExternal("http://127.0.0.1:1983", platform, process.env);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0]?.[2] as SpawnOptions;
}

afterEach(() => {
  spawnMock.mockReset();
});

// #4358, Windows guest: the detached PowerShell opener exited 0, started no browser process and
// `keiko start` recorded the hand-off as requested; the same program started attached with a hidden
// window opened the browser.
it("starts the Windows opener attached with a hidden window", async () => {
  const options = await openerSpawnOptions("win32");
  expect(options.detached).toBe(false);
  expect(options.windowsHide).toBe(true);
  expect(options.stdio).toBe("ignore");
  // not the caller's directory: a helper that inherits it holds that folder
  expect(options.cwd).toBeDefined();
  expect(options.cwd).not.toBe(process.cwd());
});

it.each(["linux", "darwin"] as const)("keeps the detached opener on %s", async (platform) => {
  const options = await openerSpawnOptions(platform);
  expect(options.detached).toBe(true);
  expect(options.windowsHide).toBeUndefined();
  expect(options.stdio).toBe("ignore");
});
