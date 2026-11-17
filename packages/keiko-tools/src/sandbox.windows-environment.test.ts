import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChildEnv,
  buildSandboxEnv,
  collectCredentialEnvValues,
  collectSensitiveEnvValues,
} from "./sandbox.js";
import { DEFAULT_ENV_ALLOWLIST, DEFAULT_SANDBOX_POLICY } from "./types.js";

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});
afterEach(() => vi.restoreAllMocks());

describe("Windows copied command environments", () => {
  it("copies Windows spelling under only the existing allowlisted names", () => {
    const parent = {
      Path: String.raw`C:\Program Files\Git\cmd`,
      systemroot: String.raw`C:\Windows`,
      pathext: ".EXE;.CMD",
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      Home: "private-home-canary",
      github_token: "private-token-canary",
      Secret: "private-secret-canary",
    };
    expect(buildSandboxEnv({ ...parent }, DEFAULT_ENV_ALLOWLIST)).toEqual({
      PATH: parent.Path,
      SystemRoot: parent.systemroot,
      PATHEXT: parent.pathext,
      COMSPEC: parent.ComSpec,
    });
    expect(Object.keys(parent)).toContain("Path");
    expect(Object.keys(parent)).not.toContain("PATH");
  });

  it.each(["darwin", "linux"] as const)("keeps names case-sensitive on %s", (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    expect(buildSandboxEnv({ Path: "alternate", PATH: "canonical" }, ["PATH"])).toEqual({
      PATH: "canonical",
    });
    expect(buildSandboxEnv({ Path: "alternate" }, ["PATH"])).toEqual({});
  });

  it.each([
    { Path: "shadow-value", PATH: "first-value" },
    { PATH: "first-value", Path: "shadow-value" },
  ])("uses Node's first lexicographic alias regardless of insertion order", (parent) => {
    expect(buildSandboxEnv(parent, ["Path"])).toEqual({ Path: "first-value" });
  });

  it("does not fall back past an undefined first alias", () => {
    expect(buildSandboxEnv({ PATH: undefined, Path: "shadow-value" }, ["PATH"])).toEqual({});
  });

  it("keeps unforwarded alias and secret values in the output scrub set", () => {
    expect(
      collectSensitiveEnvValues({ Path: "public-path-value", SeCrEt: "private-secret-canary" }, [
        "PATH",
      ]),
    ).toEqual(["private-secret-canary"]);
    expect(
      collectSensitiveEnvValues({ PATH: "public-path-value", Path: "shadow-canary" }, ["Path"]),
    ).toEqual(["shadow-canary"]);
  });

  it("scrubs every casing of an explicitly declared credential even if allowlisted later", () => {
    const parent = { gh_token: "private-lower-token", GH_TOKEN: "private-upper-token" };
    expect(collectCredentialEnvValues(parent, ["GH_TOKEN"])).toEqual([
      "private-upper-token",
      "private-lower-token",
    ]);
    expect(
      buildChildEnv(parent, { ...DEFAULT_SANDBOX_POLICY, credentialEnvAllowlist: ["GH_TOKEN"] }),
    ).toMatchObject({ GH_TOKEN: "private-upper-token" });
  });

  it("forwards a differently cased credential only under its explicit lane and still scrubs it", () => {
    const parent = { gh_token: "private-lower-token" };
    expect(buildChildEnv(parent, DEFAULT_SANDBOX_POLICY)).toEqual({});
    expect(
      buildChildEnv(parent, { ...DEFAULT_SANDBOX_POLICY, credentialEnvAllowlist: ["GH_TOKEN"] }),
    ).toEqual({ GH_TOKEN: "private-lower-token" });
    expect(collectCredentialEnvValues(parent, ["GH_TOKEN"])).toEqual(["private-lower-token"]);
    expect(
      buildChildEnv(
        { gh_token: "short" },
        {
          ...DEFAULT_SANDBOX_POLICY,
          credentialEnvAllowlist: ["GH_TOKEN"],
        },
      ),
    ).toEqual({});
  });

  it("pinned values override every inherited casing without duplicate Windows names", () => {
    const env = buildChildEnv(
      { Path: "inherited-path" },
      { ...DEFAULT_SANDBOX_POLICY, pinnedEnv: { Path: "pinned-path" } },
    );
    expect(env).toEqual({ Path: "pinned-path" });
  });
});
