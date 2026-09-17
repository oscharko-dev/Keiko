import { afterEach, describe, expect, it, vi } from "vitest";

const installProcessGuards = vi.fn();
const runCli = vi.fn(
  (
    _args: readonly string[],
    io: { readonly err: (text: string) => void; readonly out: (text: string) => void },
  ): number => {
    io.out("stdout");
    io.err("stderr");
    return 0;
  },
);

vi.mock("@oscharko-dev/keiko-cli", () => ({ installProcessGuards, runCli }));

describe("root CLI entrypoint", () => {
  afterEach(() => vi.restoreAllMocks());

  it("initializes packaged paths, process guards, IO, and natural exit handling", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const previousCliBinPath = process.env.KEIKO_CLI_BIN_PATH;
    const previousUiStaticRoot = process.env.KEIKO_UI_STATIC_ROOT;
    const previousAuditor = process.env.KEIKO_LOCAL_STATE_AUDITOR;
    process.env.KEIKO_CLI_BIN_PATH = "/tmp/stale-keiko/dist/cli/index.js";
    process.env.KEIKO_UI_STATIC_ROOT = "/tmp/stale-keiko/dist/ui/static";
    process.env.KEIKO_LOCAL_STATE_AUDITOR = "/tmp/stale-keiko/local-state-audit.mjs";

    try {
      await import("../src/cli/index.js");
      await Promise.resolve();

      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      expect(installProcessGuards).toHaveBeenCalledOnce();
      expect(runCli).toHaveBeenCalledOnce();
      expect(stdout).toHaveBeenCalledWith("stdout");
      expect(stderr).toHaveBeenCalledWith("stderr");
      expect(process.env.KEIKO_CLI_BIN_PATH).toMatch(/\/src\/cli\/index\.js$/u);
      expect(process.env.KEIKO_UI_STATIC_ROOT).toMatch(/\/src\/ui\/static$/u);
      expect(process.env.KEIKO_LOCAL_STATE_AUDITOR).toMatch(
        /\/scripts\/lib\/local-state-audit\.mjs$/u,
      );
    } finally {
      process.exitCode = previousExitCode;
      restoreEnv("KEIKO_CLI_BIN_PATH", previousCliBinPath);
      restoreEnv("KEIKO_UI_STATIC_ROOT", previousUiStaticRoot);
      restoreEnv("KEIKO_LOCAL_STATE_AUDITOR", previousAuditor);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}
