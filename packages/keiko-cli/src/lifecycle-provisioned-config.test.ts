import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { runLifecycleCli } from "./lifecycle.js";

// `keiko start --provisioned-config PATH` (ADR-0121 D9): the administrator's configuration must be
// in place BEFORE the UI process is spawned, because that process reads it at boot, and it must
// never be written under a Keiko that is already running with its configuration in memory.

const TEST_LAUNCH_ID = "ab".repeat(16);
const CONFIG = JSON.stringify({ providers: [{ modelId: "chat-model", apiKey: "sk-test" }] });
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-lifecycle-provisioned-"));
  roots.push(root);
  writeFileSync(join(root, "team.config.json"), CONFIG);
  return root;
}

interface Started {
  readonly code: number;
  readonly out: string;
  readonly outcomes: string[];
}

async function start(
  root: string,
  args: readonly string[],
  deps: Partial<Parameters<typeof runLifecycleCli>[4]>,
): Promise<Started> {
  let out = "";
  const events: SecurityLogEvent[] = [];
  const code = await runLifecycleCli(
    "start",
    args,
    {
      out: (text): void => {
        out += text;
      },
      err: (): void => undefined,
    },
    {},
    {
      cwd: root,
      isPortAvailable: () => Promise.resolve(true),
      sleep: () => Promise.resolve(),
      platform: () => "linux",
      openExternal: vi.fn(),
      securityLogSink: { write: (event): void => void events.push(event) },
      ...deps,
    },
  );
  const outcomes = events
    .filter((event) => event.op === "cli.lifecycle.provisioned-config")
    .map((event) => String(event.extra?.outcome));
  return { code, out, outcomes };
}

describe("keiko start --provisioned-config", () => {
  it("adopts the configuration before the UI process is spawned", async () => {
    const root = makeRoot();
    const configPath = join(root, ".keiko", "ui", "keiko.config.json");
    let configAtSpawn: string | undefined;

    const result = await start(root, ["--provisioned-config", "team.config.json"], {
      spawnFn: () => {
        configAtSpawn = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
        throw new Error("stop after the configuration was observed");
      },
    });

    expect(configAtSpawn).toBe(CONFIG);
    expect(result.outcomes).toEqual(["adopted"]);
    expect(result.out).toContain("Keiko uses the configuration that came with this folder.");
  });

  it("adopts nothing when the port is taken: the start ends before any state is written", async () => {
    const root = makeRoot();

    const result = await start(root, ["--provisioned-config", "team.config.json"], {
      isPortAvailable: () => Promise.resolve(false),
      spawnFn: vi.fn(),
    });

    expect(result.code).toBe(1);
    expect(result.outcomes).toEqual([]);
    expect(existsSync(join(root, ".keiko", "ui"))).toBe(false);
  });

  it("does not write under a running Keiko and says how the new configuration takes effect", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".keiko"), { recursive: true });
    writeFileSync(join(root, ".keiko", "ui.pid"), `12345\n${TEST_LAUNCH_ID}\n`, "utf8");
    const spawnFn = vi.fn();

    const result = await start(root, ["--no-open", "--provisioned-config", "team.config.json"], {
      spawnFn,
      fetchImpl: () =>
        Promise.resolve(
          Response.json({ status: "ok", version: SDK_VERSION, launchId: TEST_LAUNCH_ID }),
        ),
      isProcessAlive: () => true,
      killProcess: vi.fn(),
      verifyLaunchIdentity: () => true,
    });

    expect(result.code).toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual(["deferred-running"]);
    expect(existsSync(join(root, ".keiko", "ui", "keiko.config.json"))).toBe(false);
    expect(result.out).toContain("already running");
    expect(result.out).toContain("Stop Keiko and start it again to use the new one.");
  });

  it("leaves a start without the flag untouched", async () => {
    const root = makeRoot();

    const result = await start(root, [], {
      spawnFn: () => {
        throw new Error("stop at the spawn");
      },
    });

    expect(result.outcomes).toEqual([]);
    expect(existsSync(join(root, ".keiko", "ui", "keiko.config.json"))).toBe(false);
  });

  it("refuses the flag without a value as a usage error", async () => {
    const result = await start(makeRoot(), ["--provisioned-config"], { spawnFn: vi.fn() });

    expect(result.code).toBe(2);
  });
});
