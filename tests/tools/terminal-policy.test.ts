// ADR-0018 D3 — per-rule allowlist + flag-policy tests. Each command in TERMINAL_COMMAND_RULES has
// at least one allowed invocation; each command with a denied-flag or denied-subcommand policy has
// at least one rejection test. The set is mutation-robust: a one-line weakening of the policy
// constant (drop a deny flag, drop a subcommand, broaden node positional acceptance) must fail at
// least one assertion in this file.

import { describe, expect, it } from "vitest";
import {
  TERMINAL_COMMAND_RULES,
  isTerminalCommandAllowed,
} from "../../src/tools/terminal-policy.js";

describe("TERMINAL_COMMAND_RULES", () => {
  it("contains exactly the 13 commands ADR-0018 D3 documents", () => {
    const names = TERMINAL_COMMAND_RULES.map((rule) => rule.executable).sort();
    expect(names).toEqual(
      [
        "cat",
        "echo",
        "find",
        "git",
        "grep",
        "head",
        "ls",
        "node",
        "npm",
        "pwd",
        "tail",
        "tree",
        "wc",
      ].sort(),
    );
  });

  it("denies every executable not in the allowlist", () => {
    const decision = isTerminalCommandAllowed("rm", ["-rf", "/"]);
    expect(decision.allowed).toBe(false);
  });

  it("denies an empty executable", () => {
    expect(isTerminalCommandAllowed("", []).allowed).toBe(false);
  });
});

describe("isTerminalCommandAllowed — read-only inspection commands", () => {
  it("allows ls with flags and paths", () => {
    expect(isTerminalCommandAllowed("ls", ["-la", "src"]).allowed).toBe(true);
  });

  it("allows cat with a path", () => {
    expect(isTerminalCommandAllowed("cat", ["README.md"]).allowed).toBe(true);
  });

  it("allows head with -n and a path", () => {
    expect(isTerminalCommandAllowed("head", ["-n", "10", "file"]).allowed).toBe(true);
  });

  it("allows tail with -n and a path", () => {
    expect(isTerminalCommandAllowed("tail", ["-n", "5", "file"]).allowed).toBe(true);
  });

  it("allows wc with -l", () => {
    expect(isTerminalCommandAllowed("wc", ["-l", "file"]).allowed).toBe(true);
  });

  it("allows grep with flags and pattern", () => {
    expect(isTerminalCommandAllowed("grep", ["-rn", "foo", "src"]).allowed).toBe(true);
  });

  it("allows tree with -L", () => {
    expect(isTerminalCommandAllowed("tree", ["-L", "2"]).allowed).toBe(true);
  });

  it("allows pwd with no args", () => {
    expect(isTerminalCommandAllowed("pwd", []).allowed).toBe(true);
  });

  it("allows echo with any args", () => {
    expect(isTerminalCommandAllowed("echo", ["hello", "world"]).allowed).toBe(true);
  });
});

describe("isTerminalCommandAllowed — find (flag-policy denials)", () => {
  it("allows find with -name and -type and -maxdepth", () => {
    expect(
      isTerminalCommandAllowed("find", [".", "-name", "*.ts", "-type", "f", "-maxdepth", "3"])
        .allowed,
    ).toBe(true);
  });

  it("denies find -exec", () => {
    expect(isTerminalCommandAllowed("find", [".", "-exec", "rm", "{}", ";"]).allowed).toBe(false);
  });

  it("denies find -execdir", () => {
    expect(isTerminalCommandAllowed("find", [".", "-execdir", "rm", "{}", ";"]).allowed).toBe(
      false,
    );
  });

  it("denies find -ok", () => {
    expect(isTerminalCommandAllowed("find", [".", "-ok", "rm", "{}", ";"]).allowed).toBe(false);
  });

  it("denies find -okdir", () => {
    expect(isTerminalCommandAllowed("find", [".", "-okdir", "rm", "{}", ";"]).allowed).toBe(false);
  });

  it("denies find -delete", () => {
    expect(isTerminalCommandAllowed("find", [".", "-delete"]).allowed).toBe(false);
  });

  it("denies find -fprint", () => {
    expect(isTerminalCommandAllowed("find", [".", "-fprint", "/tmp/x"]).allowed).toBe(false);
  });

  it("denies find -fprintf", () => {
    expect(isTerminalCommandAllowed("find", [".", "-fprintf", "/tmp/x", "%p"]).allowed).toBe(false);
  });
});

describe("isTerminalCommandAllowed — node (positional denial)", () => {
  it("allows node --version", () => {
    expect(isTerminalCommandAllowed("node", ["--version"]).allowed).toBe(true);
  });

  it("allows node -v", () => {
    expect(isTerminalCommandAllowed("node", ["-v"]).allowed).toBe(true);
  });

  it("denies node -e <code>", () => {
    expect(isTerminalCommandAllowed("node", ["-e", "console.log(1)"]).allowed).toBe(false);
  });

  it("denies node <file>", () => {
    expect(isTerminalCommandAllowed("node", ["script.js"]).allowed).toBe(false);
  });

  it("denies node --eval <code>", () => {
    expect(isTerminalCommandAllowed("node", ["--eval", "1+1"]).allowed).toBe(false);
  });

  it("denies node --inspect", () => {
    expect(isTerminalCommandAllowed("node", ["--inspect"]).allowed).toBe(false);
  });
});

describe("isTerminalCommandAllowed — npm (subcommand allowlist)", () => {
  it("allows npm ls", () => {
    expect(isTerminalCommandAllowed("npm", ["ls", "--depth=0"]).allowed).toBe(true);
  });

  it("allows npm outdated", () => {
    expect(isTerminalCommandAllowed("npm", ["outdated"]).allowed).toBe(true);
  });

  it("allows npm --version", () => {
    expect(isTerminalCommandAllowed("npm", ["--version"]).allowed).toBe(true);
  });

  it("denies npm install", () => {
    expect(isTerminalCommandAllowed("npm", ["install", "lodash"]).allowed).toBe(false);
  });

  it("denies npm run", () => {
    expect(isTerminalCommandAllowed("npm", ["run", "build"]).allowed).toBe(false);
  });

  it("denies npm exec", () => {
    expect(isTerminalCommandAllowed("npm", ["exec", "anything"]).allowed).toBe(false);
  });

  it("denies npm publish", () => {
    expect(isTerminalCommandAllowed("npm", ["publish"]).allowed).toBe(false);
  });

  it("denies npm -c <shell-call>", () => {
    expect(isTerminalCommandAllowed("npm", ["ls", "-c", "echo x"]).allowed).toBe(false);
  });

  it("denies npm --call=<x>", () => {
    expect(isTerminalCommandAllowed("npm", ["ls", "--call=echo x"]).allowed).toBe(false);
  });
});

describe("isTerminalCommandAllowed — git (subcommand allowlist + value-flag safety)", () => {
  it("allows git status", () => {
    expect(isTerminalCommandAllowed("git", ["status"]).allowed).toBe(true);
  });

  it("allows git log", () => {
    expect(isTerminalCommandAllowed("git", ["log", "--oneline", "-n", "5"]).allowed).toBe(true);
  });

  it("allows git diff", () => {
    expect(isTerminalCommandAllowed("git", ["diff", "HEAD~1"]).allowed).toBe(true);
  });

  it("allows git branch (read-only listing)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-a"]).allowed).toBe(true);
  });

  it("allows git remote -v", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "-v"]).allowed).toBe(true);
  });

  it("allows git rev-parse HEAD", () => {
    expect(isTerminalCommandAllowed("git", ["rev-parse", "HEAD"]).allowed).toBe(true);
  });

  it("allows git blame path", () => {
    expect(isTerminalCommandAllowed("git", ["blame", "src/index.ts"]).allowed).toBe(true);
  });

  it("allows git ls-files", () => {
    expect(isTerminalCommandAllowed("git", ["ls-files"]).allowed).toBe(true);
  });

  it("allows git show", () => {
    expect(isTerminalCommandAllowed("git", ["show", "HEAD"]).allowed).toBe(true);
  });

  it("denies git push", () => {
    expect(isTerminalCommandAllowed("git", ["push", "origin", "dev"]).allowed).toBe(false);
  });

  it("denies git commit", () => {
    expect(isTerminalCommandAllowed("git", ["commit", "-m", "x"]).allowed).toBe(false);
  });

  it("denies git checkout", () => {
    expect(isTerminalCommandAllowed("git", ["checkout", "main"]).allowed).toBe(false);
  });

  it("denies git reset", () => {
    expect(isTerminalCommandAllowed("git", ["reset", "--hard"]).allowed).toBe(false);
  });

  it("denies git fetch", () => {
    expect(isTerminalCommandAllowed("git", ["fetch"]).allowed).toBe(false);
  });

  it("denies git pull", () => {
    expect(isTerminalCommandAllowed("git", ["pull"]).allowed).toBe(false);
  });

  it("denies git add", () => {
    expect(isTerminalCommandAllowed("git", ["add", "."]).allowed).toBe(false);
  });

  it("denies a value-flag value masquerading as the subcommand (-C <push>)", () => {
    // `git -C dir push` resolves to subcommand `push` (denied) because -C is a value-flag.
    expect(isTerminalCommandAllowed("git", ["-C", "/tmp", "push"]).allowed).toBe(false);
  });

  it("allows git -C dir status (value-flag with an allowed subcommand)", () => {
    expect(isTerminalCommandAllowed("git", ["-C", "/tmp", "status"]).allowed).toBe(true);
  });

  it("denies git branch -D (branch deletion)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-D", "old"]).allowed).toBe(false);
  });

  it("denies git remote --delete (remote mutation)", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "--delete", "origin"]).allowed).toBe(false);
  });
});

describe("isTerminalCommandAllowed — bare-executable safety", () => {
  it("denies a path-qualified executable", () => {
    expect(isTerminalCommandAllowed("./ls", []).allowed).toBe(false);
    expect(isTerminalCommandAllowed("/bin/ls", []).allowed).toBe(false);
  });

  it("denies an executable containing a backslash", () => {
    expect(isTerminalCommandAllowed("ls\\foo", []).allowed).toBe(false);
  });
});
