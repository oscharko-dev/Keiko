import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostNpmInvocation } from "../lib/host-npm-invocation.mjs";

const roots = [];

function temporary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("hostNpmInvocation", () => {
  function npmFixture() {
    const root = temporary("keiko-host-npm-");
    const cliDirectory = join(root, "node_modules", "npm", "bin");
    mkdirSync(cliDirectory, { recursive: true });
    const cli = join(cliDirectory, "npm-cli.js");
    writeFileSync(cli, "process.exit(0);\n", { mode: 0o755 });
    return { root, cli, executable: join(root, "npm.cmd") };
  }

  it("preserves the resolved POSIX executable", () => {
    expect(hostNpmInvocation("/trusted/npm", { platform: "linux" })).toEqual({
      command: "/trusted/npm",
      args: [],
    });
  });

  it("refuses a missing CLI instead of falling back to a shell", () => {
    const { executable, cli } = npmFixture();
    unlinkSync(cli);
    expect(() => hostNpmInvocation(executable, { platform: "win32" })).toThrow(
      "trusted host npm CLI is unavailable",
    );
  });

  it("refuses a CLI inside the workspace", () => {
    const { root, executable } = npmFixture();
    expect(() => hostNpmInvocation(executable, { platform: "win32", workspaceRoot: root })).toThrow(
      "trusted host npm CLI is unavailable",
    );
  });

  it("refuses a CLI directory redirected outside the selected npm installation", () => {
    const { root, executable } = npmFixture();
    const outside = temporary("keiko-host-npm-outside-");
    const modules = join(root, "node_modules");
    const target = join(outside, "node_modules");
    renameSync(modules, target);
    symlinkSync(target, modules, process.platform === "win32" ? "junction" : "dir");
    expect(() => hostNpmInvocation(executable, { platform: "win32" })).toThrow(
      "trusted host npm CLI is unavailable",
    );
  });
});
