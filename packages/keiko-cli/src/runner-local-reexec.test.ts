import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type RunCliDeps } from "./runner.js";
import { makeCapturedIo } from "./test-support/cli-io.js";

vi.mock("./lifecycle.js", () => ({ runLifecycleCli: vi.fn(() => 0) }));

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-runner-reexec-"));
  tempRoots.push(root);
  return root;
}

function seedLocalPackage(root: string): {
  readonly cliEntry: string;
  readonly staticRoot: string;
} {
  const packageRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
  const cliEntry = join(packageRoot, "dist", "cli", "index.js");
  const staticRoot = join(packageRoot, "dist", "ui", "static");
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"version":"0.2.12"}\n', "utf8");
  writeFileSync(cliEntry, "#!/usr/bin/env node\n", "utf8");
  writeFileSync(join(staticRoot, "index.html"), "<html></html>\n", "utf8");
  return { cliEntry, staticRoot };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runCli local package re-exec", () => {
  it("re-runs start through the local package install when the active launcher is stale", () => {
    const root = makeRoot();
    const localPackage = seedLocalPackage(root);
    const c = makeCapturedIo();
    const spawnSync = vi.fn<NonNullable<RunCliDeps["spawnSync"]>>(() => ({
      output: [null, Buffer.alloc(0), Buffer.alloc(0)],
      pid: 123,
      signal: null,
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    }));

    const code = runCli(
      ["start", "--port", "1984"],
      c.io,
      {},
      {
        argv: [
          process.execPath,
          String.raw`D:\Softwareentwicklung\Projekte\Keiko\dist\cli\index.js`,
        ],
        cwd: root,
        spawnSync,
      },
    );

    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [localPackage.cliEntry, "start", "--port", "1984"],
      expect.objectContaining({
        cwd: root,
        stdio: "inherit",
        windowsHide: false,
      }),
    );
    const env = spawnSync.mock.calls[0]?.[2].env;
    expect(env).toMatchObject({
      KEIKO_CLI_BIN_PATH: localPackage.cliEntry,
      KEIKO_LOCAL_PACKAGE_REEXEC: "1",
      KEIKO_UI_STATIC_ROOT: localPackage.staticRoot,
    });
    expect(c.err()).toContain("re-running the local package install");
  });

  it("does not re-run again after the local package marker is present", async () => {
    const root = makeRoot();
    seedLocalPackage(root);
    const c = makeCapturedIo();
    const spawnSync = vi.fn<NonNullable<RunCliDeps["spawnSync"]>>();

    const code = await runCli(
      ["start", "--port", "1984"],
      c.io,
      { KEIKO_LOCAL_PACKAGE_REEXEC: "1" },
      {
        argv: [process.execPath, "/opt/stale-keiko/dist/cli/index.js"],
        cwd: root,
        spawnSync,
      },
    );

    expect(code).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
