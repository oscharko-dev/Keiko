import { describe, expect, it } from "vitest";
import { buildSandboxEnv, collectSensitiveEnvValues, isCommandAllowed } from "./sandbox.js";
import { DEFAULT_COMMAND_RULES, DEFAULT_ENV_ALLOWLIST, type CommandRule } from "./types.js";

const NODE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "node" },
  ...DEFAULT_COMMAND_RULES,
]);

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
  it("allows an explicitly-allowlisted executable with no subcommand restriction", () => {
    expect(isCommandAllowed(NODE_COMMAND_RULES, "node", ["-e", "1"]).allowed).toBe(true);
  });

  it("denies raw interpreters and package runners by default", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "node", ["-e", "1"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npx", ["eslint", "."]).allowed).toBe(false);
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

  it("rejects an executable containing a NUL byte (F11)", () => {
    // "node\0evil" would basename-match "node" without the explicit hasNul guard; this pins it.
    const withNul = "node" + String.fromCharCode(0) + "evil";
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, withNul, ["-e", "1"]).allowed).toBe(false);
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

  it("allows only read-only npm subcommands by default", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["audit"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["ls"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["list"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["outdated"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["view", "keiko"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["info", "keiko"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["help"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["ping"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["publish"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["login"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["run", "test"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["ci"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["install"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["config"]).allowed).toBe(false);
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

describe("isCommandAllowed — S-H2 value-flag bypass + transitive shell", () => {
  it("denies `npm --prefix /x publish` (value-flag bypass: /x is not the subcommand)", () => {
    expect(
      isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["--prefix", "/x", "publish"]).allowed,
    ).toBe(false);
  });

  it("denies `npm --loglevel x publish` (value flag with a value)", () => {
    expect(
      isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["--loglevel", "x", "publish"]).allowed,
    ).toBe(false);
  });

  it("denies `npm --registry https://evil publish`", () => {
    expect(
      isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["--registry", "https://evil", "publish"])
        .allowed,
    ).toBe(false);
  });

  it("denies `npm -w pkg publish` (short value flag)", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["-w", "pkg", "publish"]).allowed).toBe(
      false,
    );
  });

  it("denies `npm exec -- rm -rf /` (exec spawns a transitive shell)", () => {
    expect(
      isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["exec", "--", "rm", "-rf", "/"]).allowed,
    ).toBe(false);
  });

  it("denies `npm x ...` (alias of exec)", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["x", "cowsay"]).allowed).toBe(false);
  });

  it("denies a stray first non-flag token that is not a known npm subcommand", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["/x"]).allowed).toBe(false);
  });

  it('denies `npx -c "echo x"` (transitive shell via --call)', () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npx", ["-c", "echo x"]).allowed).toBe(false);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npx", ["--call", "echo x"]).allowed).toBe(
      false,
    );
  });

  it('denies `npm -c "echo x"` (transitive shell via --call on npm too)', () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["-c", "echo x"]).allowed).toBe(false);
  });

  it("denies `git -C sub push` (value flag -C masks the subcommand)", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["-C", "sub", "push"]).allowed).toBe(
      false,
    );
  });

  it("positive controls still pass: npm audit, npm view, git status", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["audit"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npm", ["view", "keiko"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["status"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["-C", "sub", "status"]).allowed).toBe(
      true,
    );
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "npx", ["eslint", "."]).allowed).toBe(false);
  });
});

describe("isCommandAllowed — git external-command injection (diff.external RCE)", () => {
  const deniedInvocations: readonly { readonly label: string; readonly args: readonly string[] }[] =
    [
      {
        label: "-c diff.external=<cmd> diff",
        args: ["-c", "diff.external=touch /tmp/x", "diff", "f.txt"],
      },
      {
        label: "-c diff.external=<cmd> log -p --ext-diff",
        args: ["-c", "diff.external=x", "log", "-p", "--ext-diff"],
      },
      {
        label: "--config-env diff.external=<env> diff",
        args: ["--config-env=diff.external=GIT_EXTERNAL_DIFF", "diff", "f.txt"],
      },
      { label: "--ext-diff show HEAD", args: ["--ext-diff", "show", "HEAD"] },
      { label: "--textconv show", args: ["--textconv", "show", "HEAD:f"] },
      { label: "--exec-path=/evil status", args: ["--exec-path=/tmp/evil", "status"] },
      { label: "-c=foo diff (flag=value form)", args: ["-c=foo", "diff"] },
      { label: "--no-index diff /etc/passwd", args: ["--no-index", "diff", "/etc/passwd", "f"] },
    ];

  for (const { label, args } of deniedInvocations) {
    it(`denies git ${label}`, () => {
      expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", args).allowed).toBe(false);
    });
  }

  it("still allows read-only git (status, diff HEAD~1, and -C dir status)", () => {
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["status"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["diff", "HEAD~1"]).allowed).toBe(true);
    expect(isCommandAllowed(DEFAULT_COMMAND_RULES, "git", ["-C", "sub", "status"]).allowed).toBe(
      true,
    );
  });
});
