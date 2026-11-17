import { describe, expect, it, vi } from "vitest";

import { removeWindowsGatewayServiceForUninstall } from "./uninstall-gateway-service.js";
import { makeCapturedIo } from "./test-support/cli-io.js";

const PROGRAM_FILES = "C:\\PF";

function input(
  overrides: Partial<Parameters<typeof removeWindowsGatewayServiceForUninstall>[0]> = {},
): Parameters<typeof removeWindowsGatewayServiceForUninstall>[0] {
  return {
    platform: "win32",
    env: { ProgramFiles: PROGRAM_FILES },
    stateDir: "C:\\state",
    dryRun: false,
    io: makeCapturedIo().io,
    exists: () => true,
    run: () => Promise.resolve(0),
    ...overrides,
  };
}

describe("removeWindowsGatewayServiceForUninstall", () => {
  it.each([
    ["another platform", { platform: "darwin" as const }],
    ["no Program Files folder", { env: {} }],
    ["no installed service", { exists: (): boolean => false }],
  ])("does nothing with %s", async (_label, overrides) => {
    const run = vi.fn(() => Promise.resolve(0));
    await expect(
      removeWindowsGatewayServiceForUninstall(input({ ...overrides, run })),
    ).resolves.toBe("absent");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs keiko gateway-service uninstall with the uninstall's own state directory", async () => {
    const run = vi.fn((_args: readonly string[], _io: unknown, _env: unknown) =>
      Promise.resolve(0),
    );
    await expect(removeWindowsGatewayServiceForUninstall(input({ run }))).resolves.toBe("removed");
    expect(run).toHaveBeenCalledWith(
      ["uninstall"],
      expect.anything(),
      expect.objectContaining({ KEIKO_STATE_DIR: "C:\\state", ProgramFiles: PROGRAM_FILES }),
    );
  });

  // Relocated pin of the former uninstall notice: a service that stays must be named, with the
  // command that removes it, instead of being left behind silently.
  it("names the command when the service stays installed", async () => {
    const captured = makeCapturedIo();
    await expect(
      removeWindowsGatewayServiceForUninstall(
        input({ io: captured.io, run: () => Promise.resolve(1) }),
      ),
    ).resolves.toBe("kept");
    expect(captured.out()).toContain("keiko gateway-service uninstall");
  });

  it("only announces the removal in a dry run", async () => {
    const run = vi.fn(() => Promise.resolve(0));
    const captured = makeCapturedIo();
    await expect(
      removeWindowsGatewayServiceForUninstall(input({ io: captured.io, dryRun: true, run })),
    ).resolves.toBe("would-remove");
    expect(run).not.toHaveBeenCalled();
    expect(captured.out()).toContain("would-remove: the Windows runtime gateway service");
  });
});
