import { describe, expect, it } from "vitest";
import { gitEnv, networkGitEnv } from "./env.js";

describe("gitEnv", () => {
  it("pins the C locale so parsed git messages are always English", () => {
    expect(gitEnv().LC_ALL).toBe("C");
  });

  it("isolates user configuration completely", () => {
    const env = gitEnv();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    if (process.platform !== "win32") {
      expect(env.HOME).toBe("/nonexistent");
      expect(env.XDG_CONFIG_HOME).toBe("/nonexistent");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    }
  });

  it("never inherits ambient variables beyond PATH and platform system roots", () => {
    const env = gitEnv();
    expect(env.LANG).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
  });
});

describe("networkGitEnv", () => {
  it("pins the C locale even when the host locale is German", () => {
    const env = networkGitEnv({
      PATH: "/usr/bin",
      LANG: "de_DE.UTF-8",
      LC_ALL: "de_DE.UTF-8",
      LC_CTYPE: "de_DE.UTF-8",
    });
    // A localized `fatal:`/`error:` line would defeat every phrase-based outcome classifier
    // downstream (sync, publish, PR, merge) — the locale must never leak through.
    expect(env.LC_ALL).toBe("C");
    expect(env.LANG).toBeUndefined();
    expect(env.LC_CTYPE).toBeUndefined();
  });

  it("keeps credential-relevant account state and drops everything else", () => {
    const env = networkGitEnv({
      PATH: "/usr/bin",
      HOME: "/Users/demo",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      AWS_SECRET_ACCESS_KEY: "leak-me",
      GIT_DIR: "/elsewhere/.git",
      GIT_SSH_COMMAND: "ssh -oStrictHostKeyChecking=no",
    });
    expect(env.HOME).toBe("/Users/demo");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    // Caller-provided GIT_SSH_COMMAND must not override the fail-closed SSH policy.
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
  });

  it("disables every interactive credential path", () => {
    const env = networkGitEnv({ PATH: "/usr/bin" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_ASKPASS).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
  });

  it("ignores empty passthrough values", () => {
    const env = networkGitEnv({ PATH: "/usr/bin", HOME: "" });
    expect(env.HOME).toBeUndefined();
  });
});
