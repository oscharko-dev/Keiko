import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
  decodeCodingAppSessionPairingFragment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { computeLauncherPairingClaim } from "@oscharko-dev/keiko-server";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { KEIKO_START_SCRIPT } from "./init.js";
import { runLifecycleCli, type LifecycleCliDeps } from "./lifecycle.js";
import { createBrowserHandoffPoll } from "./ui-browser-handoff.js";
import { KEIKO_UI_LAUNCH_ID_ENV, writeBrowserOpenRequest } from "./state-paths.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function launchFixture(): {
  readonly root: string;
  readonly deps: LifecycleCliDeps;
  readonly spawned: SpawnOptions[];
  readonly events: SecurityLogEvent[];
  readonly openExternal: ReturnType<typeof vi.fn<(url: string) => void>>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-browser-default-"));
  directories.push(root);
  const spawned: SpawnOptions[] = [];
  const events: SecurityLogEvent[] = [];
  const openExternal = vi.fn<(url: string) => void>();
  return {
    root,
    spawned,
    events,
    openExternal,
    deps: {
      cwd: root,
      homedir: () => root,
      spawnFn: (_command, _args, options): ChildProcess => {
        spawned.push(options);
        return { pid: 424_242, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
      },
      fetchImpl: () => Promise.resolve(Response.json({ version: KEIKO_PRODUCT_VERSION })),
      isProcessAlive: () => true,
      isPortAvailable: () => Promise.resolve(true),
      openExternal,
      securityLogSinkFactory: () => ({ write: (event): void => void events.push(event) }),
    },
  };
}

const io = { out: vi.fn(), err: vi.fn() };

it.each(["start", "restart"] as const)(
  "%s opens an authenticated browser by default for existing project scripts",
  async (command) => {
    const fixture = launchFixture();
    const configPath = join(fixture.root, "gateway.json");
    // Use the actual init producer: existing generated scripts carry no browser flag.
    const args = KEIKO_START_SCRIPT.split(" ").slice(3);
    expect(
      await runLifecycleCli(command, args, io, { KEIKO_CONFIG_FILE: configPath }, fixture.deps),
    ).toBe(0);
    expect(fixture.openExternal).toHaveBeenCalledTimes(1);
    const opened = String(fixture.openExternal.mock.calls[0]?.[0]);
    const attestation = decodeCodingAppSessionPairingFragment(new URL(opened).hash);
    expect(attestation).toBeDefined();
    if (attestation === undefined) throw new TypeError("Expected launcher attestation");
    const secret = fixture.spawned[0]?.env?.[CODING_APP_SESSION_LAUNCHER_SECRET_ENV];
    expect(attestation.claim).toBe(
      computeLauncherPairingClaim(String(secret), attestation.requestId, attestation.issuedAtMs),
    );
    expect(fixture.spawned[0]?.cwd).toBe(fixture.root);
    expect(fixture.spawned[0]?.env?.KEIKO_CONFIG_FILE).toBe(configPath);
    expect(fixture.spawned[0]?.env?.KEIKO_STATE_DIR).toBe(join(fixture.root, ".keiko"));
    expectHandoff(fixture.events, "requested", true);
  },
);

it("supports an explicit headless start without opening a browser", async () => {
  const fixture = launchFixture();
  expect(await runLifecycleCli("start", ["--no-open"], io, {}, fixture.deps)).toBe(0);
  expect(fixture.spawned).toHaveLength(1);
  expect(fixture.spawned[0]?.env?.[CODING_APP_SESSION_LAUNCHER_SECRET_ENV]).toBeDefined();
  expect(fixture.openExternal).not.toHaveBeenCalled();
  expectHandoff(fixture.events, "headless", false);
});

it("asks the running launch to open a fresh paired browser without restarting it", async () => {
  const fixture = launchFixture();
  expect(await runLifecycleCli("start", [], io, {}, fixture.deps)).toBe(0);
  fixture.openExternal.mockClear();
  expect(
    await runLifecycleCli(
      "start",
      [],
      io,
      {},
      {
        ...fixture.deps,
        verifyLaunchIdentity: () => true,
      },
    ),
  ).toBe(0);
  expect(fixture.spawned).toHaveLength(1);
  expect(fixture.openExternal).not.toHaveBeenCalled();
  expect(existsSync(join(fixture.root, ".keiko", "ui.browser-open"))).toBe(true);
});

it("the running launcher consumes only a private request for its own launch and mints a fresh attestation", async () => {
  const fixture = launchFixture();
  await runLifecycleCli("start", ["--no-open"], io, {}, fixture.deps);
  const env = fixture.spawned[0]?.env ?? {};
  const stateDir = join(fixture.root, ".keiko");
  const launchId = String(env[KEIKO_UI_LAUNCH_ID_ENV]);
  const poll = createBrowserHandoffPoll({
    stateDir,
    pid: 424_242,
    env,
    baseUrl: "http://127.0.0.1:1983",
    io,
    sink: undefined,
    openExternal: fixture.openExternal,
  });
  writeBrowserOpenRequest(stateDir, 1, launchId);
  poll();
  expect(fixture.openExternal).not.toHaveBeenCalled();
  writeBrowserOpenRequest(stateDir, 424_242, launchId);
  if (process.getuid !== undefined) {
    chmodSync(join(stateDir, "ui.browser-open"), 0o644);
    poll();
    expect(fixture.openExternal).not.toHaveBeenCalled();
    chmodSync(join(stateDir, "ui.browser-open"), 0o600);
  }
  poll();
  await vi.waitFor(() => {
    expect(fixture.openExternal).toHaveBeenCalledTimes(1);
  });
  const attestation = decodeCodingAppSessionPairingFragment(
    new URL(String(fixture.openExternal.mock.calls[0]?.[0])).hash,
  );
  expect(attestation).toBeDefined();
  if (attestation === undefined) throw new TypeError("Expected a fresh launcher attestation");
  expect(attestation.claim).toBe(
    computeLauncherPairingClaim(
      String(env[CODING_APP_SESSION_LAUNCHER_SECRET_ENV]),
      attestation.requestId,
      attestation.issuedAtMs,
    ),
  );
  expect(existsSync(join(stateDir, "ui.browser-open"))).toBe(false);
  poll();
  expect(fixture.openExternal).toHaveBeenCalledTimes(1);
});

function expectHandoff(
  events: readonly SecurityLogEvent[],
  outcome: "requested" | "headless" | "failed",
  attestationProvided: boolean,
): void {
  const handoff = events.find((event) => event.op === "cli.lifecycle.browser-handoff");
  const line = formatActivityLogProofLine(handoff ?? {});
  expectActivityLogProof("cli.lifecycle.browser-handoff.outcome", line);
  expect(JSON.parse(line)).toMatchObject({ outcome, attestationProvided });
  expect(line).not.toContain("keiko-app-session");
  expect(line).not.toContain("gateway.json");
}

it("records a rejected browser opener without losing a healthy server or disclosing secrets", async () => {
  const fixture = launchFixture();
  fixture.openExternal.mockImplementation(() => {
    throw new TypeError("private browser error with sensitive contents");
  });
  expect(await runLifecycleCli("start", [], io, {}, fixture.deps)).toBe(0);
  expectHandoff(fixture.events, "failed", true);
  expect(JSON.stringify(fixture.events)).not.toContain("sensitive contents");
});

it("contains an asynchronous opener failure in the same hand-off evidence", async () => {
  const fixture = launchFixture();
  expect(
    await runLifecycleCli(
      "start",
      [],
      io,
      {},
      {
        ...fixture.deps,
        openExternal: () => Promise.reject(new TypeError("private async opener error")),
      },
    ),
  ).toBe(0);
  expectHandoff(fixture.events, "failed", true);
});
