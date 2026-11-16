import { describe, expect, it } from "vitest";
import { gitEnv, networkGitEnv } from "./env.js";

describe("Git Windows environment projection (#4411)", () => {
  it("retains copied Windows account and path aliases for stored credentials", () => {
    const source = {
      Path: "C:\\Git\\cmd",
      SYSTEMROOT: "C:\\Windows",
      windir: "C:\\Windows",
      UserProfile: "C:\\Users\\fixture",
      AppData: "C:\\Users\\fixture\\AppData\\Roaming",
      LocalAppData: "C:\\Users\\fixture\\AppData\\Local",
      ProgramData: "C:\\ProgramData",
      gH_TOKEN: "fixture-not-forwarded",
      GIT_CONFIG_SYSTEM: "untrusted",
    };
    const network = networkGitEnv(source, "win32");
    expect(network).toMatchObject({
      PATH: source.Path,
      SystemRoot: source.SYSTEMROOT,
      WINDIR: source.windir,
      USERPROFILE: source.UserProfile,
      APPDATA: source.AppData,
      LOCALAPPDATA: source.LocalAppData,
      PROGRAMDATA: source.ProgramData,
      GIT_ASKPASS: "NUL",
    });
    expect(network.gH_TOKEN).toBeUndefined();
    expect(network.GIT_CONFIG_SYSTEM).toBeUndefined();
    expect(gitEnv(source, "win32")).toMatchObject({
      PATH: source.Path,
      SystemRoot: source.SYSTEMROOT,
      WINDIR: source.windir,
    });
    expect(gitEnv(source, "win32").USERPROFILE).toBeUndefined();
  });

  it("uses Node's first code-unit alias even when empty or undefined", () => {
    const source = {
      Path: "shadow",
      PATH: "selected",
      SystemRoot: "shadow",
      SYSTEMROOT: "selected",
      USERPROFILE: undefined,
      UserProfile: "shadow",
    };
    expect(networkGitEnv(source, "win32")).toMatchObject({
      PATH: "selected",
      SystemRoot: "selected",
    });
    expect(networkGitEnv(source, "win32").USERPROFILE).toBeUndefined();
    expect(networkGitEnv({ PATH: "", Path: "shadow" }, "win32").PATH).toBe("");
    expect(networkGitEnv({ PATH: undefined, Path: "shadow" }, "win32").PATH).toBe("");
  });

  it.each(["darwin", "linux"] as const)(
    "keeps %s case-sensitive and credential-safe",
    (platform) => {
      const env = networkGitEnv(
        {
          PATH: "/usr/bin",
          Path: "shadow",
          HOME: "/fixture",
          home: "shadow",
          GH_TOKEN: "fixture-not-forwarded",
        },
        platform,
      );
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/fixture");
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GIT_ASKPASS).toBe("/dev/null");
    },
  );
});
