import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { runLifecycleCli } from "./lifecycle.js";
import { readPidRecord, writeExclusivePidFile } from "./state-paths.js";

const roots: string[] = [];
const launchId = "a".repeat(32);
const pid = 424242;

function fixture(): { readonly root: string; readonly state: string; readonly receipt: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-lifecycle-"));
  roots.push(root);
  const state = join(root, ".keiko"),
    directory = join(state, ".keiko", "ui-runtime");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(state, "ui.pid"),
    `${String(pid)}\n${launchId}\nbrowser-open-v1\nnative-app-v1\n`,
    {
      mode: 0o600,
    },
  );
  return { root, state, receipt: join(directory, `${launchId}.receipt`) };
}

async function stop(root: string, state: string): Promise<number> {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const killProcess = vi.fn();
  const result = await runLifecycleCli(
    "stop",
    ["--state-dir", state, "--stop-timeout", "1"],
    { out: vi.fn(), err: vi.fn() },
    {},
    {
      cwd: root,
      homedir: (): string => root,
      platform: (): NodeJS.Platform => "linux",
      isProcessAlive: (): boolean => false,
      killProcess,
      verifyLaunchIdentity: (): boolean => false,
      sleep: (ms: number): Promise<void> => {
        clock += ms;
        return Promise.resolve();
      },
      securityLogSink: { write: vi.fn() },
    },
  );
  expect(killProcess).not.toHaveBeenCalled();
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native UI lifecycle terminal evidence", () => {
  it.each(["missing", "provisional", "reaped", "owned"])(
    "requires committed evidence when adopting a live native generation: %s",
    async (phase) => {
      const { root, state, receipt } = fixture();
      if (phase !== "missing")
        writeFileSync(
          receipt,
          `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\n${phase}\n`,
          {
            mode: 0o600,
          },
        );
      const spawnFn = vi.fn((): never => {
        throw new Error("An existing generation must never spawn a replacement");
      });
      const result = await runLifecycleCli(
        "start",
        ["--state-dir", state, "--no-open"],
        { out: vi.fn(), err: vi.fn() },
        {},
        {
          cwd: root,
          homedir: (): string => root,
          isProcessAlive: (): boolean => true,
          verifyLaunchIdentity: (): boolean => true,
          spawnFn,
          fetchImpl: (): Promise<Response> =>
            Promise.resolve(
              new Response(JSON.stringify({ version: KEIKO_PRODUCT_VERSION, launchId })),
            ),
          securityLogSink: { write: vi.fn() },
        },
      );
      expect(result).toBe(phase === "owned" ? 0 : 1);
      expect(spawnFn).not.toHaveBeenCalled();
      expect(readPidRecord(join(state, "ui.pid"))?.pid).toBe(pid);
    },
  );

  it("round-trips the explicit native capability through the real PID writer", () => {
    const { state } = fixture(),
      path = join(state, "ui.pid");
    writeExclusivePidFile(path, pid, launchId, true, true);
    expect(readFileSync(path, "utf8")).toBe(
      `${String(pid)}\n${launchId}\nbrowser-open-v1\nnative-app-v1\n`,
    );
    expect(readPidRecord(path)?.nativeAppRuntime).toBe(true);
  });

  it.each([
    ["missing", undefined],
    [
      "unstarted unrelated to this root",
      `keiko-ui-runtime-v1\n0\n${launchId}\n12345\nnot-started\n`,
    ],
    ["provisional", `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\nprovisional\n`],
    ["owned", `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\nowned\n`],
    ["partial", `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\nreap`],
    ["wrong root", `keiko-ui-runtime-v1\n424243\n${launchId}\n12345\nreaped\n`],
    ["wrong launch", `keiko-ui-runtime-v1\n${String(pid)}\n${"b".repeat(32)}\n12345\nreaped\n`],
    ["invalid owner", `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n0\nreaped\n`],
    ["extra data", `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\nreaped\nextra\n`],
  ])("holds tracking when the root is gone but whole-generation proof is %s", async (_, bytes) => {
    const { root, state, receipt } = fixture();
    if (bytes !== undefined) writeFileSync(receipt, bytes, { mode: 0o600 });
    expect(await stop(root, state)).toBe(1);
    expect(readPidRecord(join(state, "ui.pid"))?.nativeAppRuntime).toBe(true);
  });

  it("holds a symlinked terminal record", async () => {
    const { root, state, receipt } = fixture(),
      target = join(root, "foreign.receipt");
    writeFileSync(target, `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\nreaped\n`, {
      mode: 0o600,
    });
    symlinkSync(target, receipt);
    expect(await stop(root, state)).toBe(1);
    expect(readPidRecord(join(state, "ui.pid"))?.nativeAppRuntime).toBe(true);
  });

  it("removes tracking only for the matching complete native terminal record", async () => {
    const { root, state, receipt } = fixture();
    writeFileSync(receipt, `keiko-ui-runtime-v1\n${String(pid)}\n${launchId}\n12345\nreaped\n`, {
      mode: 0o600,
    });
    expect(await stop(root, state)).toBe(0);
    expect(readPidRecord(join(state, "ui.pid"))).toBeUndefined();
  });

  it("preserves the supported legacy PID protocol", async () => {
    const { root, state } = fixture();
    writeExclusivePidFile(join(state, "ui.pid"), pid, launchId, true);
    expect(await stop(root, state)).toBe(0);
  });
});
