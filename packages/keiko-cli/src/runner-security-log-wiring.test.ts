import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { runDetachedWindowsAlert } from "./portable-launch-notifier.js";
import type { CliIo } from "./runner.js";
import { createCliSecurityLogSink } from "./security-log.js";
import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
  writeInstallLayoutOverrideEvidence,
} from "./install-layout.js";

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
type ActivityAwareCommand = (
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps?: { readonly activityLogSinkFactory?: CliSecurityLogSinkFactory | undefined },
) => number | Promise<number>;
type SecurityAwareLifecycleCommand = (
  command: "start" | "stop" | "status" | "restart",
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps?: SecurityAwareCommandDeps,
) => Promise<number>;
type ServerModule = Pick<typeof import("@oscharko-dev/keiko-server"), "createFileServerLogSink">;
type PersistedServerLogEvent = Parameters<
  ReturnType<ServerModule["createFileServerLogSink"]>["write"]
>[0];

const commandMocks = vi.hoisted(() => ({
  loadServer: vi.fn<() => Promise<ServerModule>>(),
  audit: vi.fn<ActivityAwareCommand>(),
  launcher: vi.fn<SecurityAwareCommand>(),
  lifecycle: vi.fn<SecurityAwareLifecycleCommand>(),
  portable: vi.fn<SecurityAwareCommand>(),
  repair: vi.fn<SecurityAwareCommand>(),
  support: vi.fn<ActivityAwareCommand>(),
  ui: vi.fn<ActivityAwareCommand>(),
  uninstall: vi.fn<SecurityAwareCommand>(),
}));

vi.mock("./lazy-modules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lazy-modules.js")>();
  return { ...actual, loadServer: commandMocks.loadServer };
});
vi.mock("./portable.js", () => ({ runPortableCli: commandMocks.portable }));
vi.mock("./audit.js", () => ({ runAuditCli: commandMocks.audit }));
vi.mock("./launcher.js", () => ({ runLauncherCli: commandMocks.launcher }));
vi.mock("./lifecycle.js", () => ({ runLifecycleCli: commandMocks.lifecycle }));
vi.mock("./repair.js", () => ({ runRepairCli: commandMocks.repair }));
vi.mock("./support.js", () => ({ runSupportCli: commandMocks.support }));
vi.mock("./ui.js", () => ({ runUiCli: commandMocks.ui }));
vi.mock("./uninstall.js", () => ({ runUninstallCli: commandMocks.uninstall }));

import { runCli } from "./runner.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform");

function io(): CliIo {
  return { out: (): void => undefined, err: (): void => undefined };
}

function commandSecurityFactory(
  call: Parameters<SecurityAwareCommand> | undefined,
): CliSecurityLogSinkFactory | undefined {
  return call?.[3]?.securityLogSinkFactory;
}

function commandActivityFactory(
  call: Parameters<ActivityAwareCommand> | undefined,
): CliSecurityLogSinkFactory | undefined {
  return call?.[3]?.activityLogSinkFactory;
}

function lifecycleSecurityFactory(
  call: Parameters<SecurityAwareLifecycleCommand> | undefined,
): CliSecurityLogSinkFactory | undefined {
  return call?.[4]?.securityLogSinkFactory;
}

function capturedSecurityFactories(): {
  readonly repair: CliSecurityLogSinkFactory | undefined;
  readonly uninstall: CliSecurityLogSinkFactory | undefined;
  readonly portable: CliSecurityLogSinkFactory | undefined;
  readonly launcher: CliSecurityLogSinkFactory | undefined;
  readonly start: CliSecurityLogSinkFactory | undefined;
  readonly restart: CliSecurityLogSinkFactory | undefined;
} {
  return {
    repair: commandSecurityFactory(commandMocks.repair.mock.calls[0]),
    uninstall: commandSecurityFactory(commandMocks.uninstall.mock.calls[0]),
    portable: commandSecurityFactory(commandMocks.portable.mock.calls[0]),
    launcher: commandSecurityFactory(commandMocks.launcher.mock.calls[0]),
    start: lifecycleSecurityFactory(commandMocks.lifecycle.mock.calls[0]),
    restart: lifecycleSecurityFactory(commandMocks.lifecycle.mock.calls[1]),
  };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  commandMocks.loadServer.mockReset();
  commandMocks.audit.mockReset().mockResolvedValue(46);
  commandMocks.launcher.mockReset().mockReturnValue(44);
  commandMocks.lifecycle.mockReset().mockResolvedValue(45);
  commandMocks.portable.mockReset().mockResolvedValue(43);
  commandMocks.repair.mockReset().mockReturnValue(41);
  commandMocks.support.mockReset().mockResolvedValue(47);
  commandMocks.ui.mockReset().mockResolvedValue(48);
  commandMocks.uninstall.mockReset().mockResolvedValue(42);
});

afterEach(() => {
  if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("Windows CLI security-log production wiring", () => {
  it("persists layout evidence for every install-layout consumer outside read-only targets", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const written: PersistedServerLogEvent[] = [];
    const createFileServerLogSink = vi.fn<ServerModule["createFileServerLogSink"]>(() => ({
      write: (event): void => {
        written.push(event);
      },
    }));
    commandMocks.loadServer.mockResolvedValue({ createFileServerLogSink });
    commandMocks.repair.mockImplementation((_args, _io, env, deps) => {
      writeInstallLayoutOverrideEvidence(deps?.securityLogSinkFactory?.("/state"), env);
      return 41;
    });
    commandMocks.audit.mockImplementation((_args, _io, env, deps) => {
      writeInstallLayoutOverrideEvidence(deps?.activityLogSinkFactory?.("/control"), env);
      return 46;
    });
    for (const command of [commandMocks.launcher, commandMocks.portable, commandMocks.uninstall]) {
      command.mockImplementation((_args, _io, env, deps) => {
        writeInstallLayoutOverrideEvidence(deps?.securityLogSinkFactory?.("/state"), env);
        return 41;
      });
    }
    for (const command of [commandMocks.support, commandMocks.ui]) {
      command.mockImplementation((_args, _io, env, deps) => {
        writeInstallLayoutOverrideEvidence(deps?.activityLogSinkFactory?.("/state"), env);
        return 41;
      });
    }
    const evidenceEnv = (): EnvSource => ({
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    });

    await expect(
      Promise.resolve(runCli(["audit", "local-state"], io(), evidenceEnv())),
    ).resolves.toBe(46);
    await expect(Promise.resolve(runCli(["repair"], io(), evidenceEnv()))).resolves.toBe(41);
    await expect(
      Promise.resolve(runCli(["launcher", "install"], io(), evidenceEnv())),
    ).resolves.toBe(41);
    await expect(
      Promise.resolve(runCli(["uninstall", "--launchers"], io(), evidenceEnv())),
    ).resolves.toBe(41);
    await expect(Promise.resolve(runCli(["portable", "setup"], io(), evidenceEnv()))).resolves.toBe(
      41,
    );
    await expect(Promise.resolve(runCli(["support", "export"], io(), evidenceEnv()))).resolves.toBe(
      41,
    );
    await expect(Promise.resolve(runCli(["ui"], io(), evidenceEnv()))).resolves.toBe(41);

    const auditFactory = commandActivityFactory(commandMocks.audit.mock.calls[0]);
    expect(typeof auditFactory).toBe("function");
    expect(commandMocks.audit).toHaveBeenCalledWith(
      ["local-state"],
      expect.anything(),
      expect.anything(),
      {
        activityLogSinkFactory: auditFactory,
      },
    );
    expect(commandMocks.loadServer).toHaveBeenCalledTimes(7);
    expect(createFileServerLogSink).toHaveBeenCalledTimes(7);
    expect(written).toHaveLength(7);
    expect(written.every(({ op }) => op === "cli.install-layout.normalized")).toBe(true);
  });

  it("supplies a deferred sink to every Windows security command without loading the server graph", async () => {
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

    const factories = capturedSecurityFactories();
    for (const factory of [
      factories.repair,
      factories.uninstall,
      factories.portable,
      factories.launcher,
      factories.start,
      factories.restart,
    ]) {
      expect(typeof factory).toBe("function");
    }
    expect(commandMocks.repair).toHaveBeenCalledWith(["--dry-run"], commandIo, env, {
      securityLogSinkFactory: factories.repair,
    });
    expect(commandMocks.uninstall).toHaveBeenCalledWith(["--dry-run"], commandIo, env, {
      securityLogSinkFactory: factories.uninstall,
    });
    expect(commandMocks.portable).toHaveBeenCalledWith(["resolve-root"], commandIo, env, {
      securityLogSinkFactory: factories.portable,
    });
    expect(commandMocks.launcher).toHaveBeenCalledWith(["install", "--dry-run"], commandIo, env, {
      securityLogSinkFactory: factories.launcher,
    });
    expect(commandMocks.lifecycle).toHaveBeenNthCalledWith(1, "start", ["--open"], commandIo, env, {
      securityLogSinkFactory: factories.start,
    });
    expect(commandMocks.lifecycle).toHaveBeenNthCalledWith(
      2,
      "restart",
      ["--open"],
      commandIo,
      env,
      { securityLogSinkFactory: factories.restart },
    );
    expect(commandMocks.loadServer).not.toHaveBeenCalled();
  });

  it("loads and flushes the file sink only after a security event is emitted", async () => {
    const written: unknown[] = [];
    const createFileServerLogSink = vi.fn<ServerModule["createFileServerLogSink"]>(() => ({
      write: (event): void => {
        written.push(event);
      },
    }));
    commandMocks.loadServer.mockResolvedValue({ createFileServerLogSink });
    commandMocks.repair.mockImplementation((_args, _io, _env, deps) => {
      deps?.securityLogSinkFactory?.(String.raw`C:\Keiko\state`).write({
        category: "security",
        op: "security.windows-system-root.refused",
        correlationId: "correlation-1",
      });
      return 41;
    });

    await expect(Promise.resolve(runCli(["repair", "--dry-run"], io(), {}))).resolves.toBe(41);

    expect(commandMocks.loadServer).toHaveBeenCalledTimes(1);
    expect(createFileServerLogSink).toHaveBeenCalledWith(String.raw`C:\Keiko\state`);
    expect(written).toEqual([
      expect.objectContaining({
        op: "security.windows-system-root.refused",
        correlationId: "correlation-1",
      }),
    ]);
  });

  it("keeps normalization and later command events on one invocation correlation", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const stateDir = String.raw`C:\Keiko\state`;
    const written: PersistedServerLogEvent[] = [];
    commandMocks.loadServer.mockResolvedValue({
      createFileServerLogSink: () => ({
        write: (event): void => {
          written.push(event);
        },
      }),
    });
    commandMocks.lifecycle.mockImplementation((_command, _args, _io, env, deps) => {
      writeInstallLayoutOverrideEvidence(deps?.securityLogSinkFactory?.(stateDir), env);
      createCliSecurityLogSink(stateDir, deps?.securityLogSinkFactory)?.write({
        category: "security",
        op: "security.windows-lifecycle-opener.system-root-refused",
      });
      return Promise.resolve(45);
    });
    const env: EnvSource = {
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
    };

    await expect(Promise.resolve(runCli(["start", "--open"], io(), env))).resolves.toBe(45);

    expect(written.map(({ op }) => op)).toEqual([
      "cli.install-layout.normalized",
      "security.windows-lifecycle-opener.system-root-refused",
    ]);
    expect(written.every((event) => event.correlationId === correlationId)).toBe(true);
  });

  it("persists a detached Windows alert error emitted after the command has settled", async () => {
    const stateDir = String.raw`C:\Keiko\state`;
    const written: PersistedServerLogEvent[] = [];
    let emitChildError: ((error: Error) => void) | undefined;
    let resolveWritten: (() => void) | undefined;
    const eventWritten = new Promise<void>((resolve) => {
      resolveWritten = resolve;
    });
    const createFileServerLogSink = vi.fn<ServerModule["createFileServerLogSink"]>(() => ({
      write: (event): void => {
        written.push(event);
        resolveWritten?.();
      },
    }));
    commandMocks.loadServer.mockResolvedValue({ createFileServerLogSink });
    commandMocks.portable.mockImplementation((_args, _io, _env, deps) => {
      const securityLogSink = createCliSecurityLogSink(stateDir, deps?.securityLogSinkFactory);
      runDetachedWindowsAlert(
        "Keiko could not start",
        { SystemRoot: String.raw`C:\Windows` },
        (_command, _spawnArgs, _options) => ({
          on: (_event, listener): void => {
            emitChildError = listener;
          },
          unref: (): void => undefined,
        }),
        () => undefined,
        () => true,
        securityLogSink,
        () => true,
      );
      return 43;
    });

    await expect(Promise.resolve(runCli(["portable", "launch"], io(), {}))).resolves.toBe(43);
    expect(commandMocks.loadServer).not.toHaveBeenCalled();

    await Promise.resolve().then(() => {
      if (emitChildError === undefined) throw new TypeError("missing child error listener");
      emitChildError(new Error(String.raw`spawn failed under C:\Users\Sensitive\Keiko`));
    });
    expect(commandMocks.loadServer).toHaveBeenCalledTimes(1);
    await eventWritten;

    expect(createFileServerLogSink).toHaveBeenCalledWith(stateDir);
    expect(written).toEqual([
      expect.objectContaining({
        category: "diagnostic",
        op: "portable.windows-alert.spawn-failed",
        errorKind: "unavailable",
        extra: {
          completeness: "complete",
          loss: "none",
          surface: "portable-failure-alert",
          failureKind: "Error",
        },
      }),
    ]);
    expect(written[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(written)).not.toContain("Sensitive");
    expect(JSON.stringify(written)).not.toContain("spawn failed");
  });

  it("keeps a recovery command available when the deferred server log module cannot load", async () => {
    commandMocks.loadServer.mockRejectedValue(
      new Error(String.raw`module load failed under C:\Users\Sensitive\Keiko`),
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
    const commandIo = io();
    commandMocks.repair.mockImplementation((_args, _io, _env, deps) => {
      deps?.securityLogSinkFactory?.(String.raw`C:\Keiko\state`).write({
        category: "security",
        op: "security.windows-system-root.refused",
      });
      return 41;
    });

    await expect(Promise.resolve(runCli(["repair", "--dry-run"], commandIo, {}))).resolves.toBe(41);

    expect(commandMocks.loadServer).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(emitWarning.mock.calls)).toContain(
      "KEIKO_CLI_SECURITY_LOG_SINK_UNAVAILABLE",
    );
    expect(JSON.stringify(emitWarning.mock.calls)).toContain("errorKind=Error");
    expect(JSON.stringify(emitWarning.mock.calls)).not.toContain("module load failed");
    expect(JSON.stringify(emitWarning.mock.calls)).not.toContain("Sensitive");
  });

  it("fails a read-only audit closed when deferred activity evidence cannot persist", async () => {
    commandMocks.loadServer.mockRejectedValue(new Error("module load failed"));
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
    const err = vi.fn<(text: string) => void>();
    commandMocks.audit.mockImplementation((_args, _io, _env, deps) => {
      deps?.activityLogSinkFactory?.("/control").write({
        category: "diagnostic",
        op: "cli.audit.started",
      });
      return 46;
    });

    await expect(
      Promise.resolve(runCli(["audit", "local-state"], { out: (): void => undefined, err }, {})),
    ).resolves.toBe(1);

    expect(commandMocks.loadServer).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(
      "keiko audit: durable activity logging is unavailable; audit refused.\n",
    );
  });
});
