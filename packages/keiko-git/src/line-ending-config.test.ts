// Line-ending config forwarding for the config-isolated local reads: the pure allowlist parser and
// a hermetic end-to-end proof that a CRLF checkout committed through `core.autocrlf=true` in the
// user's global scope reads clean through the real default local runner.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineEndingConfigArgs } from "./line-ending-config.js";
import { createLocalGitProcessRunner } from "./runner.js";

const entry = (key: string, value: string): string => `${key}\n${value}\0`;

describe("lineEndingConfigArgs", () => {
  it("forwards the closed line-ending vocabulary in canonical form", () => {
    expect(
      lineEndingConfigArgs(entry("core.autocrlf", "TRUE") + entry("core.eol", "crlf")),
    ).toEqual(["-c", "core.autocrlf=true", "-c", "core.eol=crlf"]);
  });

  it("lets the last (highest precedence) entry win and drops a key whose last value is invalid", () => {
    expect(
      lineEndingConfigArgs(entry("core.autocrlf", "true") + entry("core.autocrlf", "input")),
    ).toEqual(["-c", "core.autocrlf=input"]);
    expect(
      lineEndingConfigArgs(entry("core.autocrlf", "true") + entry("core.autocrlf", "bogus")),
    ).toEqual([]);
  });

  it("never forwards a hostile value or an executable key", () => {
    const hostile =
      entry("core.autocrlf", "!sh -c evil") +
      entry("core.eol", "lf\n-c core.fsmonitor=evil") +
      entry("core.fsmonitor", "evil") +
      entry("core.hookspath", "/tmp/x") +
      entry("credential.helper", "evil") +
      "no-separator\0";
    expect(lineEndingConfigArgs(hostile)).toEqual([]);
    expect(lineEndingConfigArgs("")).toEqual([]);
  });

  it("fails closed on an oversized listing", () => {
    const many = Array.from({ length: 65 }, () => entry("core.eol", "lf")).join("");
    expect(lineEndingConfigArgs(many)).toEqual([]);
  });
});

describe("local status read with the user's core.autocrlf=true", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-eol-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function git(env: NodeJS.ProcessEnv, ...args: string[]): string {
    return execFileSync("git", args, { cwd: join(root, "repo"), env, encoding: "utf8" });
  }

  it("reports a CRLF working-tree file clean, as the user's own git does", async () => {
    const home = join(root, "home");
    mkdirSync(home);
    const globalConfig = join(home, ".gitconfig");
    writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n");
    const userEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      SystemRoot: process.env.SystemRoot ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    };
    mkdirSync(join(root, "repo"));
    git(userEnv, "init", "-q");
    git(userEnv, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "repo", "a.txt"), "one\r\ntwo\r\n");
    git(userEnv, "add", "a.txt");
    git(userEnv, "commit", "-q", "-m", "init");
    expect(git(userEnv, "status", "--short")).toBe("");

    const runner = createLocalGitProcessRunner(() => userEnv);
    const result = await runner(["-C", join(root, "repo"), "status", "--porcelain=v1", "-z"], {
      cwd: root,
      timeoutMs: 30_000,
      maxBytes: 1024 * 1024,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
