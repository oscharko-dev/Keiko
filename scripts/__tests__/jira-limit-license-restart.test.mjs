import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = [];
let remaining = 0;
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_node, [script, action, directory]) => {
    spawned.push({ script: script.split("/").at(-1), action, directory });
    if (action === "start") remaining = 10_700;
    return { status: 0 };
  }),
}));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  basicAuth: () => "Basic fixture",
  labRequest: vi.fn(async () => ({
    status: 200,
    value: { valid: true, expired: false, expiryDate: Date.now() + remaining * 1000 },
  })),
}));
// The restart's new edges (evidence capture, the front wait) have their own tests in
// jira-lab-health.test.mjs; here they are inert so the restart sequence itself stays under test.
const INERT = { capture: async () => undefined, waitFront: async () => undefined };
const { renewLicenseWindow } =
  await import("../testing/jira-chat-lab/requirements/license-window.mjs");

let directory;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-license-restart-"));
  spawned.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // The window is computed from the clock; a frozen clock keeps a loaded runner from losing a second.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-09T09:00:00.000Z") });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("the owned laboratory renewal", () => {
  it("restarts only this session's directory once and reports the window before and after", async () => {
    remaining = 600;
    const result = await renewLicenseWindow({}, directory, 5400, INERT);
    expect(spawned).toEqual([
      { script: "session.mjs", action: "stop", directory },
      { script: "session.mjs", action: "start", directory },
    ]);
    expect(result).toMatchObject({ restarted: true, remainingBefore: 600 });
    expect(result.remainingAfter).toBeGreaterThanOrEqual(5400);
  });

  it("does not restart when the window already suffices", async () => {
    remaining = 6000;
    const result = await renewLicenseWindow({}, directory, 5400, INERT);
    expect(spawned).toEqual([]);
    expect(result.restarted).toBe(false);
  });
});
