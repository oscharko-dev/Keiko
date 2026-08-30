import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import type { CliIo } from "./runner.js";

type CliSecurityLogSinkFactory = (stateDir: string) => SecurityLogSink;
interface SecurityAwareCommandDeps {
  readonly securityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
}
type SecurityAwareCommand = (
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps?: SecurityAwareCommandDeps,
) => number | Promise<number>;
type SecurityAwareLifecycleCommand = (
  command: "start" | "stop" | "status" | "restart",
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps?: SecurityAwareCommandDeps,
) => Promise<number>;
type ServerModule = Pick<typeof import("@oscharko-dev/keiko-server"), "createFileServerLogSink">;

const commandMocks = vi.hoisted(() => ({
  loadServer: vi.fn<() => Promise<ServerModule>>(),
  launcher: vi.fn<SecurityAwareCommand>(),
  lifecycle: vi.fn<SecurityAwareLifecycleCommand>(),
  portable: vi.fn<SecurityAwareCommand>(),
  repair: vi.fn<SecurityAwareCommand>(),
  uninstall: vi.fn<SecurityAwareCommand>(),
}));

vi.mock("./lazy-modules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lazy-modules.js")>();
  return { ...actual, loadServer: commandMocks.loadServer };
});
vi.mock("./portable.js", () => ({ runPortableCli: commandMocks.portable }));
vi.mock("./launcher.js", () => ({ runLauncherCli: commandMocks.launcher }));
vi.mock("./lifecycle.js", () => ({ runLifecycleCli: commandMocks.lifecycle }));
vi.mock("./repair.js", () => ({ runRepairCli: commandMocks.repair }));
vi.mock("./uninstall.js", () => ({ runUninstallCli: commandMocks.uninstall }));

import { runCli } from "./runner.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform");

function io(): CliIo {
  return { out: (): void => undefined, err: (): void => undefined };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  commandMocks.loadServer.mockReset();
  commandMocks.launcher.mockReset().mockReturnValue(44);
  commandMocks.lifecycle.mockReset().mockResolvedValue(45);
  commandMocks.portable.mockReset().mockResolvedValue(43);
  commandMocks.repair.mockReset().mockReturnValue(41);
  commandMocks.uninstall.mockReset().mockResolvedValue(42);
});

afterEach(() => {
  if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("Windows CLI security-log production wiring", () => {
  it("supplies the existing file sink factory to every Windows security command", async () => {
    const createFileServerLogSink = vi.fn<ServerModule["createFileServerLogSink"]>(() => ({
      write: (): void => undefined,
    }));
    commandMocks.loadServer.mockResolvedValue({ createFileServerLogSink });
    const commandIo = io();
    const env = { KEIKO_STATE_DIR: String.raw`C:\Keiko\state` };

    await expect(Promise.resolve(runCli(["repair", "--dry-run"], commandIo, env))).resolves.toBe(
      41,
    );
    await expect(Promise.resolve(runCli(["uninstall", "--dry-run"], commandIo, env))).resolves.toBe(
      42,
    );
    await expect(
      Promise.resolve(runCli(["portable", "resolve-root"], commandIo, env)),
    ).resolves.toBe(43);
    await expect(
      Promise.resolve(runCli(["launcher", "install", "--dry-run"], commandIo, env)),
    ).resolves.toBe(44);
    await expect(Promise.resolve(runCli(["start", "--open"], commandIo, env))).resolves.toBe(45);
    await expect(Promise.resolve(runCli(["restart", "--open"], commandIo, env))).resolves.toBe(45);

    expect(commandMocks.repair).toHaveBeenCalledWith(["--dry-run"], commandIo, env, {
      securityLogSinkFactory: createFileServerLogSink,
    });
    expect(commandMocks.uninstall).toHaveBeenCalledWith(["--dry-run"], commandIo, env, {
      securityLogSinkFactory: createFileServerLogSink,
    });
    expect(commandMocks.portable).toHaveBeenCalledWith(["resolve-root"], commandIo, env, {
      securityLogSinkFactory: createFileServerLogSink,
    });
    expect(commandMocks.launcher).toHaveBeenCalledWith(["install", "--dry-run"], commandIo, env, {
      securityLogSinkFactory: createFileServerLogSink,
    });
    expect(commandMocks.lifecycle).toHaveBeenNthCalledWith(1, "start", ["--open"], commandIo, env, {
      securityLogSinkFactory: createFileServerLogSink,
    });
    expect(commandMocks.lifecycle).toHaveBeenNthCalledWith(
      2,
      "restart",
      ["--open"],
      commandIo,
      env,
      { securityLogSinkFactory: createFileServerLogSink },
    );
  });

  it("keeps every recovery command available when the server log module cannot load", async () => {
    commandMocks.loadServer.mockRejectedValue(
      new Error(String.raw`module load failed under C:\Users\Sensitive\Keiko`),
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
    const commandIo = io();

    await expect(Promise.resolve(runCli(["repair", "--dry-run"], commandIo, {}))).resolves.toBe(41);
    await expect(Promise.resolve(runCli(["uninstall", "--dry-run"], commandIo, {}))).resolves.toBe(
      42,
    );
    await expect(
      Promise.resolve(runCli(["portable", "resolve-root"], commandIo, {})),
    ).resolves.toBe(43);
    await expect(
      Promise.resolve(runCli(["launcher", "install", "--dry-run"], commandIo, {})),
    ).resolves.toBe(44);
    await expect(Promise.resolve(runCli(["start", "--open"], commandIo, {}))).resolves.toBe(45);
    await expect(Promise.resolve(runCli(["restart", "--open"], commandIo, {}))).resolves.toBe(45);

    for (const command of [
      commandMocks.repair,
      commandMocks.uninstall,
      commandMocks.portable,
      commandMocks.launcher,
    ]) {
      expect(command).toHaveBeenCalledWith(
        expect.any(Array),
        commandIo,
        {},
        { securityLogSinkFactory: undefined },
      );
    }
    expect(commandMocks.lifecycle).toHaveBeenNthCalledWith(
      1,
      "start",
      ["--open"],
      commandIo,
      {},
      {
        securityLogSinkFactory: undefined,
      },
    );
    expect(commandMocks.lifecycle).toHaveBeenNthCalledWith(
      2,
      "restart",
      ["--open"],
      commandIo,
      {},
      { securityLogSinkFactory: undefined },
    );
    expect(emitWarning).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(emitWarning.mock.calls)).toContain(
      "KEIKO_CLI_SECURITY_LOG_SINK_UNAVAILABLE",
    );
    expect(JSON.stringify(emitWarning.mock.calls)).not.toContain("Sensitive");
  });
});
