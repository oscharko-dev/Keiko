import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCompilerEnvironment,
  runSecureWorkspaceReadBuild,
} from "../build-secure-workspace-read.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("secure workspace read compiler environment", () => {
  it("keeps the macOS compiler environment minimal", () => {
    expect(
      buildCompilerEnvironment("macos-arm64", {
        PATH: "/trusted/bin",
        INCLUDE: "ignored",
        HOME: "ignored",
      }),
    ).toEqual({ PATH: "/trusted/bin" });
  });

  it("forwards exact Windows toolchain paths and excludes injection variables", () => {
    const environment = buildCompilerEnvironment("windows-x64", {
      PATH: "C:\\MSVC\\bin;C:\\Windows\\System32",
      INCLUDE: "C:\\SDK\\include;C:\\MSVC\\include",
      LIB: "C:\\SDK\\lib;C:\\MSVC\\lib",
      LIBPATH: "C:\\MSVC\\libpath;C:\\SDK\\references",
      CL: "/DUNTRUSTED",
      _CL_: "/link untrusted.lib",
      LINK: "/INCREMENTAL",
      HOME: "C:\\Users\\ignored",
      TMP: "C:\\ignored",
      UNDEFINED_VALUE: undefined,
    });

    expect(environment).toEqual({
      PATH: "C:\\MSVC\\bin;C:\\Windows\\System32",
      INCLUDE: "C:\\SDK\\include;C:\\MSVC\\include",
      LIB: "C:\\SDK\\lib;C:\\MSVC\\lib",
      LIBPATH: "C:\\MSVC\\libpath;C:\\SDK\\references",
    });
  });

  it("omits undefined allowlisted values", () => {
    expect(
      buildCompilerEnvironment("windows-x64", {
        PATH: "C:\\MSVC\\bin",
        INCLUDE: undefined,
        LIB: undefined,
        LIBPATH: undefined,
      }),
    ).toEqual({ PATH: "C:\\MSVC\\bin" });
  });

  it.each(["bad\rvalue", "bad\nvalue", "bad\0value"])(
    "fails closed on a forwarded control character in %j",
    (value) => {
      expect(() =>
        buildCompilerEnvironment("windows-x64", { PATH: "C:\\trusted", INCLUDE: value }),
      ).toThrow("invalid compiler environment variable: INCLUDE");
    },
  );

  it("rejects an invalid environment before invoking the compiler", async () => {
    let compilerInvoked = false;
    await expect(
      runSecureWorkspaceReadBuild({
        argv: [
          "node",
          "build-secure-workspace-read.mjs",
          "windows-x64",
          join(tmpdir(), "secure-read.exe"),
        ],
        environment: { PATH: "C:\\MSVC\\bin", LIB: "bad\nvalue" },
        spawnSyncImpl: () => {
          compilerInvoked = true;
          return { status: 0 };
        },
      }),
    ).rejects.toThrow("invalid compiler environment variable: LIB");
    expect(compilerInvoked).toBe(false);
  });

  it("passes only the filtered environment to the Windows compiler invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-secure-read-build-"));
    temporaryDirectories.push(root);
    const destination = join(root, "nested", "secure-read.exe");
    let invocation;

    const status = await runSecureWorkspaceReadBuild({
      argv: ["node", "build-secure-workspace-read.mjs", "windows-x64", destination],
      environment: {
        PATH: "C:\\MSVC\\bin",
        INCLUDE: "C:\\SDK\\include;C:\\MSVC\\include",
        LIB: "C:\\SDK\\lib;C:\\MSVC\\lib",
        LIBPATH: "C:\\MSVC\\libpath",
        CL: "/DUNTRUSTED",
        LINK: "/INCREMENTAL",
        SECRET: "not-for-the-compiler",
      },
      spawnSyncImpl: (command, args, options) => {
        invocation = { args, command, options };
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(invocation.command).toBe("cl");
    expect(invocation.args).toContain("ntdll.lib");
    expect(invocation.options).toEqual({
      env: {
        PATH: "C:\\MSVC\\bin",
        INCLUDE: "C:\\SDK\\include;C:\\MSVC\\include",
        LIB: "C:\\SDK\\lib;C:\\MSVC\\lib",
        LIBPATH: "C:\\MSVC\\libpath",
      },
      stdio: "inherit",
    });
  });
});
