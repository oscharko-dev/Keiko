// Regression coverage for the ONE `owner/repo` resolver (see github-repository.mjs's header
// comment): `scripts/release-publish.mjs` and `scripts/check-release-alignment.mjs` both call
// `resolveGithubRepository` and must observe the exact same precedence — a GitHub Actions
// `GITHUB_REPOSITORY` env var first, falling back to the `origin` git remote for a local operator
// run. This suite proves every branch of that precedence and of the remote-URL parser directly,
// rather than only through one of its two callers.

import { describe, expect, it } from "vitest";

import { resolveGithubRepository } from "../lib/github-repository.mjs";

function ok(stdout) {
  return { status: 0, stdout };
}

function failed(stderr = "boom") {
  return { status: 1, stderr, stdout: "" };
}

// Captures every call made to the seam so a test can assert the exact command shape, and can
// assert the seam was never invoked at all (AGENTS.md section 7's fixture rule).
function gitRemote(result) {
  const runGit = (args) => {
    runGit.calls.push(args);
    return result;
  };
  runGit.calls = [];
  return runGit;
}

describe("resolveGithubRepository", () => {
  it("returns GITHUB_REPOSITORY directly when it is a valid owner/repo string", () => {
    const runGit = gitRemote(ok("https://github.com/oscharko-dev/Keiko\n"));
    const result = resolveGithubRepository({
      env: { GITHUB_REPOSITORY: "oscharko-dev/Keiko" },
      runGit,
    });
    expect(result).toBe("oscharko-dev/Keiko");
    expect(runGit.calls).toEqual([]);
  });

  it("falls through to the git remote when GITHUB_REPOSITORY is not a string", () => {
    const runGit = gitRemote(ok("https://github.com/oscharko-dev/Keiko.git\n"));
    const result = resolveGithubRepository({ env: { GITHUB_REPOSITORY: 42 }, runGit });
    expect(result).toBe("oscharko-dev/Keiko");
    expect(runGit.calls).toEqual([["remote", "get-url", "origin"]]);
  });

  it("falls through to the git remote when GITHUB_REPOSITORY has no slash", () => {
    const runGit = gitRemote(ok("https://github.com/oscharko-dev/Keiko.git\n"));
    const result = resolveGithubRepository({
      env: { GITHUB_REPOSITORY: "not-a-repo-slug" },
      runGit,
    });
    expect(result).toBe("oscharko-dev/Keiko");
    expect(runGit.calls).toEqual([["remote", "get-url", "origin"]]);
  });

  it.each([
    ["an https remote without a .git suffix", "https://github.com/oscharko-dev/Keiko"],
    ["an https remote with a .git suffix", "https://github.com/oscharko-dev/Keiko.git"],
    ["an ssh remote without a .git suffix", "git@github.com:oscharko-dev/Keiko"],
    ["an ssh remote with a .git suffix", "git@github.com:oscharko-dev/Keiko.git"],
    [
      "a remote with surrounding whitespace and a trailing newline",
      "  https://github.com/oscharko-dev/Keiko.git\n",
    ],
  ])("parses %s", (_label, remoteUrl) => {
    const runGit = gitRemote(ok(remoteUrl));
    const result = resolveGithubRepository({ env: {}, runGit });
    expect(result).toBe("oscharko-dev/Keiko");
  });

  it.each([
    ["a non-GitHub https remote", "https://gitlab.example/x/y.git"],
    ["an ssh remote on another host", "git@gitlab.example:x/y.git"],
    ["an empty remote", ""],
  ])("returns undefined for %s", (_label, remoteUrl) => {
    const runGit = gitRemote(ok(remoteUrl));
    const result = resolveGithubRepository({ env: {}, runGit });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the git remote read fails with a non-zero status", () => {
    const runGit = gitRemote(failed());
    const result = resolveGithubRepository({ env: {}, runGit });
    expect(result).toBeUndefined();
    expect(runGit.calls).toEqual([["remote", "get-url", "origin"]]);
  });

  it("returns undefined when runGit itself returns undefined", () => {
    const runGit = gitRemote(undefined);
    const result = resolveGithubRepository({ env: {}, runGit });
    expect(result).toBeUndefined();
  });
});
