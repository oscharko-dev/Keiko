import { describe, expect, it } from "vitest";
import {
  admitRepositoryUrl,
  interpolateEnvironment,
  isInterpolated,
  isOwnServerOrigin,
  RefusalTally,
  repositoryResolutionEnvironment,
} from "./repositoryRelayTargets.js";

describe("repositoryResolutionEnvironment (#4522)", () => {
  const names = (env: Record<string, string>): string[] =>
    Object.keys(repositoryResolutionEnvironment(env)).sort();

  it("keeps ordinary names a repository file may read", () => {
    expect(names({ PATH: "/bin", NEXUS_TOKEN: "x", OPENAIKEY: "x", MY_HFX_TOKEN: "x" })).toEqual([
      "MY_HFX_TOKEN",
      "NEXUS_TOKEN",
      "OPENAIKEY",
      "PATH",
    ]);
  });

  it.each([
    "KEIKO_GATEWAY_API_KEY",
    "keiko_anything",
    "OPENAI_API_KEY",
    "my_anthropic_key",
    "AZURE_OPENAI_KEY",
    "HF_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "SOME_GATEWAY",
    "GATEWAY",
    "LITELLM_MASTER_KEY",
    "KEIKO_TOKEN",
    "ſecret_AWS_X",
  ])("withholds %s from a repository file", (name) => {
    expect(names({ [name]: "x", PLAIN: "y" })).toEqual(["PLAIN"]);
  });
});

describe("repository URLs and the refusal tally (#4522)", () => {
  it("counts reasons, several at a time", () => {
    const tally = new RefusalTally();
    tally.add("url-missing");
    tally.add("profile-inactive", 3);
    tally.add("profile-inactive");
    expect(tally.toCounts()).toEqual({ "url-missing": 1, "profile-inactive": 4 });
  });

  it("recognises interpolation and Keiko's own origin on loopback spellings", () => {
    expect(isInterpolated("https://${env.X}/")).toBe(true);
    expect(isInterpolated("https://repo.example/")).toBe(false);
    const own = "http://127.0.0.1:41999";
    expect(isOwnServerOrigin(new URL("http://localhost:41999/x"), own)).toBe(true);
    expect(isOwnServerOrigin(new URL("http://localhost:42000/x"), own)).toBe(false);
    expect(isOwnServerOrigin(new URL("https://repo.example/x"), own)).toBe(false);
    expect(isOwnServerOrigin(new URL("http://localhost:41999/x"), undefined)).toBe(false);
  });

  it("admits a web URL, normalised, and refuses user info, other schemes and the own origin", () => {
    const own = "http://127.0.0.1:41999";
    const admitted = admitRepositoryUrl("https://repo.example/maven", own);
    expect(admitted.ok && admitted.url.href).toBe("https://repo.example/maven/");
    expect(admitRepositoryUrl("https://u:p@repo.example/", own)).toMatchObject({ ok: false });
    expect(admitRepositoryUrl("ftp://repo.example/", own)).toMatchObject({ ok: false });
    expect(admitRepositoryUrl("not a url", own)).toMatchObject({ ok: false });
    expect(admitRepositoryUrl(`${own}/api/`, own)).toMatchObject({ ok: false });
  });

  it("fills an environment placeholder and refuses any other interpolation", () => {
    const form = /^env\.([A-Za-z_]\w*)$/u;
    expect(interpolateEnvironment("a-${env.X}-b", { X: "1" }, form)).toEqual({
      ok: true,
      value: "a-1-b",
    });
    expect(interpolateEnvironment("${env.NOPE}", {}, form)).toMatchObject({ ok: false });
    expect(interpolateEnvironment("${other}", {}, form)).toMatchObject({ ok: false });
    expect(interpolateEnvironment("plain", {}, form)).toEqual({ ok: true, value: "plain" });
  });
});
