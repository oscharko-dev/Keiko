import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

const roots = [];

function temporary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("resolveHostExecutable", () => {
  it.skipIf(process.platform === "win32")(
    "returns the real absolute path from a trusted directory outside the workspace",
    () => {
      const workspace = temporary("keiko-host-executable-workspace-");
      const bin = temporary("keiko-host-executable-bin-");
      const executable = join(bin, "keiko-test-tool");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(
        resolveHostExecutable("keiko-test-tool", { env: { PATH: bin }, workspaceRoot: workspace }),
      ).toBe(realpathSync(executable));
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves a PATHEXT executable under simulated Windows trust semantics",
    () => {
      const workspace = temporary("keiko-host-executable-workspace-");
      const bin = temporary("keiko-host-executable-bin-");
      const executable = join(bin, "keiko-test-tool.exe");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(bin, 0o777);
      expect(
        resolveHostExecutable("keiko-test-tool", {
          env: { PATH: bin, PATHEXT: ".EXE" },
          platform: "win32",
          trustedRoots: [],
          workspaceRoot: workspace,
        }),
      ).toBe(realpathSync(executable));
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects executables resolved inside the workspace",
    () => {
      const workspace = temporary("keiko-host-executable-workspace-");
      const bin = join(workspace, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "keiko-test-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(() =>
        resolveHostExecutable("keiko-test-tool", { env: { PATH: bin }, workspaceRoot: workspace }),
      ).toThrow("trusted host executable is unavailable");
    },
  );

  it.skipIf(process.platform === "win32")("rejects a group-writable PATH directory", () => {
    const workspace = temporary("keiko-host-executable-workspace-");
    const bin = temporary("keiko-host-executable-bin-");
    const executable = join(bin, "keiko-test-tool");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o775);
    expect(() =>
      resolveHostExecutable("keiko-test-tool", { env: { PATH: bin }, workspaceRoot: workspace }),
    ).toThrow("trusted host executable is unavailable");
  });

  it.skipIf(process.platform === "win32")(
    "accepts a group-writable toolcache owned by a group unavailable to the caller",
    () => {
      const workspace = temporary("keiko-host-executable-workspace-");
      const bin = temporary("keiko-host-executable-bin-");
      const executable = join(bin, "keiko-test-tool");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(bin, 0o775);
      expect(
        resolveHostExecutable("keiko-test-tool", {
          env: { PATH: bin },
          groupIds: [],
          workspaceRoot: workspace,
        }),
      ).toBe(realpathSync(executable));
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts a group-writable npm symlink anchored to the running Node toolchain",
    () => {
      const workspace = temporary("keiko-host-executable-workspace-");
      const toolchain = temporary("keiko-host-executable-toolchain-");
      const bin = join(toolchain, "bin");
      const npmBin = join(toolchain, "lib", "node_modules", "npm", "bin");
      mkdirSync(bin);
      mkdirSync(npmBin, { recursive: true });
      writeFileSync(join(npmBin, "npm-cli.js"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(bin, "npm"));
      chmodSync(bin, 0o775);
      chmodSync(npmBin, 0o775);

      expect(
        resolveHostExecutable("npm", {
          env: { PATH: bin },
          trustedRoots: [toolchain],
          workspaceRoot: workspace,
        }),
      ).toBe(realpathSync(join(npmBin, "npm-cli.js")));
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a group-writable symlink that escapes its trusted runtime root",
    () => {
      const workspace = temporary("keiko-host-executable-workspace-");
      const toolchain = temporary("keiko-host-executable-toolchain-");
      const outside = temporary("keiko-host-executable-outside-");
      const bin = join(toolchain, "bin");
      mkdirSync(bin);
      writeFileSync(join(outside, "npm-cli.js"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync(join(outside, "npm-cli.js"), join(bin, "npm"));
      chmodSync(bin, 0o775);

      expect(() =>
        resolveHostExecutable("npm", {
          env: { PATH: bin },
          trustedRoots: [toolchain],
          workspaceRoot: workspace,
        }),
      ).toThrow("trusted host executable is unavailable");
    },
  );

  it("ignores relative PATH entries and rejects path-bearing command names", () => {
    const workspace = temporary("keiko-host-executable-workspace-");
    expect(() =>
      resolveHostExecutable("keiko-test-tool", {
        env: { PATH: ["relative-bin", ""].join(delimiter) },
        workspaceRoot: workspace,
      }),
    ).toThrow("trusted host executable is unavailable");
    expect(() => resolveHostExecutable("../tool", { workspaceRoot: workspace })).toThrow(
      "host executable name must be bare",
    );
  });
});
