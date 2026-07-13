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

  it("initializes packaged paths, process guards, IO, and exit handling", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    delete process.env.KEIKO_CLI_BIN_PATH;
    delete process.env.KEIKO_UI_STATIC_ROOT;

    await import("../src/cli/index.js");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });

    expect(installProcessGuards).toHaveBeenCalledOnce();
    expect(runCli).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith("stdout");
    expect(stderr).toHaveBeenCalledWith("stderr");
    expect(process.env.KEIKO_CLI_BIN_PATH).toMatch(/\/src\/cli\/index\.js$/u);
    expect(process.env.KEIKO_UI_STATIC_ROOT).toMatch(/\/src\/ui\/static$/u);
  });
});
