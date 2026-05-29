import { describe, expect, it } from "vitest";
import {
  buildSandboxEnv,
  collectSensitiveEnvValues,
  isCommandAllowed,
} from "../../src/tools/sandbox.js";
import { DEFAULT_COMMAND_RULES, DEFAULT_ENV_ALLOWLIST } from "../../src/tools/types.js";

describe("buildSandboxEnv", () => {
  it("copies only allowlisted names that are present", () => {
    const env = buildSandboxEnv({ PATH: "/bin", HOME: "/h", SECRET: "x" }, ["PATH", "HOME"]);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("never forwards a credential-bearing variable", () => {
    const env = buildSandboxEnv(
      { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "topsecret", GITHUB_TOKEN: "ghp_x" },
      DEFAULT_ENV_ALLOWLIST,
    );
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("skips an allowlisted name that is absent in the parent", () => {
    const env = buildSandboxEnv({ PATH: "/bin" }, ["PATH", "HOME"]);
    expect("HOME" in env).toBe(false);
  });
});

describe("collectSensitiveEnvValues", () => {
  it("returns values of non-allowlisted vars and excludes allowlisted ones", () => {
    const values = collectSensitiveEnvValues(
      { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "supersecretvalue" },
      ["PATH"],
    );
    expect(values).toContain("supersecretvalue");
    expect(values).not.toContain("/bin");
  });

  it("skips short values to avoid over-redaction", () => {
    const values = collectSensitiveEnvValues({ TINY: "ab" }, []);
    expect(values).not.toContain("ab");
  });
});

describe("isCommandAllowed — deny-by-default", () => {
  it("allows an allowlisted executable with no subcommand restriction", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "node", ["-e", "1"]).allowed).toBe(true);
  });

  it("denies an unlisted executable", () => {
    const decision = isCommandAllowed(DEFAULT_COMMAND_RULES, "rm", ["-rf", "/"]);
    expect(decision.allowed).toBe(false);
  });

  it.each(["curl", "bash", "sh", "wget", "python", "ssh"])("denies %s", (cmd) => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, cmd, []).allowed).toBe(false);
  });

  it("rejects an executable containing a path separator", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "/bin/node", []).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "./node", []).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "a\\b", []).allowed).toBe(false);
  });

  it("rejects an empty executable", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "", []).allowed).toBe(false);
  });

  it("allows a git read-only subcommand and denies a mutating one", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["status"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["diff"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["push"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["commit", "-m", "x"]).allowed).toBe(
      false,
    );
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["checkout", "main"]).allowed).toBe(
      false,
    );
  });

  it("denies git with no subcommand (allowlist mode requires one)", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", []).allowed).toBe(false);
  });

  it("denies an npm publish/mutating subcommand but allows run/test", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["publish"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["login"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["run", "test"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["ci"]).allowed).toBe(true);
  });

  it("skips leading flags when locating the subcommand", () => {
    // `git --no-pager push` must still be denied: push is the subcommand, not --no-pager.
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["--no-pager", "push"]).allowed).toBe(
      false,
    );
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["--no-pager", "status"]).allowed).toBe(
      true,
    );
  });
});
