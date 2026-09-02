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
  it("imports the MSVC environment itself when INCLUDE and LIB are absent (#3084)", () => {
    // The workflow persists no MSVC environment: outside a Developer Command Prompt the
    // builder must resolve the toolchain via the shared lib instead of shipping a bare PATH.
    let resolved = 0;
    const environment = buildCompilerEnvironment("windows-x64", { PATH: "C:\\old" }, (base) => {
      resolved += 1;
      return {
        ...base,
        PATH: "C:\\VS\\bin;C:\\old",
        INCLUDE: "C:\\VS\\include",
        LIB: "C:\\VS\\lib",
        LIBPATH: "C:\\VS\\libpath",
      };
    });
    expect(resolved).toBe(1);
    expect(environment).toEqual({
      PATH: "C:\\VS\\bin;C:\\old",
      INCLUDE: "C:\\VS\\include",
      LIB: "C:\\VS\\lib",
      LIBPATH: "C:\\VS\\libpath",
    });
  });

  it("uses a Developer Command Prompt environment without resolving (#3084)", () => {
    let resolved = 0;
    const environment = buildCompilerEnvironment(
      "windows-x64",
      { PATH: "C:\\MSVC\\bin", INCLUDE: "C:\\inc", LIB: "C:\\lib" },
      () => {
        resolved += 1;
        return {};
      },
    );
    expect(resolved).toBe(0);
    expect(environment).toEqual({
      PATH: "C:\\MSVC\\bin",
      INCLUDE: "C:\\inc",
      LIB: "C:\\lib",
    });
  });

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
      buildCompilerEnvironment(
        "windows-x64",
        {
          PATH: "C:\\MSVC\\bin",
          INCLUDE: undefined,
          LIB: undefined,
          LIBPATH: undefined,
        },
        (environment) => environment,
      ),
    ).toEqual({ PATH: "C:\\MSVC\\bin" });
  });

  it.each(["bad\rvalue", "bad\nvalue", "bad\0value"])(
    "fails closed on a forwarded control character in %j",
    (value) => {
      expect(() =>
        buildCompilerEnvironment(
          "windows-x64",
          { PATH: "C:\\trusted", INCLUDE: value },
          (environment) => environment,
        ),
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
        resolveMsvcEnvImpl: (environment) => environment,
        resolveCompilerImpl: () => "C:\\MSVC\\bin\\cl.exe",
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
      resolveCompilerImpl: (envPath, tool) => `C:\\MSVC\\bin\\${tool}`,
    });

    expect(status).toBe(0);
    // Absolute path, never a bare name: options.env.PATH is not reliably searched on Windows.
    expect(invocation.command).toBe("C:\\MSVC\\bin\\cl.exe");
    expect(invocation.args).toEqual(
      expect.arrayContaining(["/MT", "/link", "/DEPENDENTLOADFLAG:0x800"]),
    );
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
