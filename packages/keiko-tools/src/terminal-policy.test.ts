// ADR-0018 D3 — per-rule allowlist + flag-policy tests. Each command in TERMINAL_COMMAND_RULES has
// at least one allowed invocation; each command with a denied-flag or denied-subcommand policy has
// at least one rejection test. The set is mutation-robust: a one-line weakening of the policy
// constant (drop a deny flag, drop a subcommand, broaden node positional acceptance) must fail at
// least one assertion in this file.

import { describe, expect, it } from "vitest";
import { TERMINAL_COMMAND_RULES, isTerminalCommandAllowed } from "./terminal-policy.js";

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

  it("denies wc --files0-from because it can read an unbounded path list", () => {
    expect(isTerminalCommandAllowed("wc", ["--files0-from", "/tmp/list"]).allowed).toBe(false);
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

  it("denies npm outdated", () => {
    expect(isTerminalCommandAllowed("npm", ["outdated"]).allowed).toBe(false);
  });

  it("denies npm --version", () => {
    expect(isTerminalCommandAllowed("npm", ["--version"]).allowed).toBe(false);
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

  it("denies git -C dir status (value-flag with an allowed subcommand)", () => {
    expect(isTerminalCommandAllowed("git", ["-C", "/tmp", "status"]).allowed).toBe(false);
  });

  it("denies git -C / status because terminal policy forbids cwd-shifting", () => {
    expect(isTerminalCommandAllowed("git", ["-C", "/", "status"]).allowed).toBe(false);
  });

  // A2 — git branch positional gate
  it("denies git branch -D (branch deletion)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-D", "old"]).allowed).toBe(false);
  });

  it("denies git branch newbranch (positional = creation)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "newbranch"]).allowed).toBe(false);
  });

  it("denies git branch -c old new (copy flag)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-c", "old", "new"]).allowed).toBe(false);
  });

  it("denies git branch -C old new (force-copy flag)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-C", "old", "new"]).allowed).toBe(false);
  });

  it("denies git branch -f main HEAD~5 (force flag)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-f", "main", "HEAD~5"]).allowed).toBe(false);
  });

  it("allows git branch with no args (listing)", () => {
    expect(isTerminalCommandAllowed("git", ["branch"]).allowed).toBe(true);
  });

  it("allows git branch -v (verbose listing)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "-v"]).allowed).toBe(true);
  });

  it("allows git branch --list (explicit list flag)", () => {
    expect(isTerminalCommandAllowed("git", ["branch", "--list"]).allowed).toBe(true);
  });

  // A1 — git remote positional gate
  it("denies git remote --delete (remote mutation flag via Layer-1 CommandRule)", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "--delete", "origin"]).allowed).toBe(false);
  });

  it("denies git remote remove origin (mutation subcommand)", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "remove", "origin"]).allowed).toBe(false);
  });

  it("denies git remote add x https://example.com (add subcommand)", () => {
    expect(
      isTerminalCommandAllowed("git", ["remote", "add", "x", "https://example.com"]).allowed,
    ).toBe(false);
  });

  it("denies git remote set-url origin https://... (set-url mutation)", () => {
    expect(
      isTerminalCommandAllowed("git", ["remote", "set-url", "origin", "https://x.com"]).allowed,
    ).toBe(false);
  });

  it("denies git remote update (update subcommand)", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "update"]).allowed).toBe(false);
  });

  it("allows git remote (no args)", () => {
    expect(isTerminalCommandAllowed("git", ["remote"]).allowed).toBe(true);
  });

  it("allows git remote -v (verbose flag)", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "-v"]).allowed).toBe(true);
  });

  it("denies git remote show origin", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "show", "origin"]).allowed).toBe(false);
  });

  it("denies git remote show (no remote name)", () => {
    expect(isTerminalCommandAllowed("git", ["remote", "show"]).allowed).toBe(false);
  });

  // A5 — git global flag denial
  it("denies git -c http.proxy=... log (config injection)", () => {
    expect(isTerminalCommandAllowed("git", ["-c", "http.proxy=evil", "log"]).allowed).toBe(false);
  });

  it("denies git --git-dir=/tmp/x status (git-dir injection)", () => {
    expect(isTerminalCommandAllowed("git", ["--git-dir=/tmp/x", "status"]).allowed).toBe(false);
  });

  it("denies git --work-tree=/tmp status (work-tree injection)", () => {
    expect(isTerminalCommandAllowed("git", ["--work-tree=/tmp", "status"]).allowed).toBe(false);
  });

  it("denies git --namespace=ns log (namespace injection)", () => {
    expect(isTerminalCommandAllowed("git", ["--namespace=ns", "log"]).allowed).toBe(false);
  });

  it("denies git --exec-path=/tmp log (exec-path injection)", () => {
    expect(isTerminalCommandAllowed("git", ["--exec-path=/tmp", "log"]).allowed).toBe(false);
  });

  it("allows git log --all (non-denied flag, no global flags)", () => {
    expect(isTerminalCommandAllowed("git", ["log", "--all"]).allowed).toBe(true);
  });
});

describe("isTerminalCommandAllowed — path-bearing write flags and unsafe diff output", () => {
  it("denies tree -o", () => {
    expect(isTerminalCommandAllowed("tree", ["-o", "/tmp/tree.txt"]).allowed).toBe(false);
  });

  it("denies find -fprint0", () => {
    expect(isTerminalCommandAllowed("find", [".", "-fprint0", "/tmp/out"]).allowed).toBe(false);
  });

  it("denies find -fls", () => {
    expect(isTerminalCommandAllowed("find", [".", "-fls", "/tmp/out"]).allowed).toBe(false);
  });

  it("denies git diff --ext-diff", () => {
    expect(isTerminalCommandAllowed("git", ["diff", "--ext-diff"]).allowed).toBe(false);
  });

  it("denies git diff --output", () => {
    expect(isTerminalCommandAllowed("git", ["diff", "--output", "/tmp/diff.patch"]).allowed).toBe(
      false,
    );
  });
});

describe("TERMINAL_COMMAND_RULES — A6 derivation invariant", () => {
  it("has no duplicate executable names (A6: sorted derivation is sound)", () => {
    const names = TERMINAL_COMMAND_RULES.map((r) => r.executable);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("sorted derivation matches the expected sorted list (A6: no silent drift)", () => {
    const derived = [...TERMINAL_COMMAND_RULES.map((r) => r.executable)].sort();
    expect(derived).toEqual([
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
    ]);
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
