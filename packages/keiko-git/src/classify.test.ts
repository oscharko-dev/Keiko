import { describe, expect, it } from "vitest";
import { classifyGitFailure } from "./classify.js";
import type { GitProcessResult } from "./types.js";

function result(overrides: Partial<GitProcessResult>): GitProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    ...overrides,
  };
}

describe("classifyGitFailure", () => {
  it("maps exit 127 to git-missing before anything else", () => {
    expect(classifyGitFailure(result({ exitCode: 127, stderr: "not a git repository" }))).toBe(
      "git-missing",
    );
  });

  it("maps a timed-out run to timeout even when output looks like another failure", () => {
    expect(
      classifyGitFailure(result({ timedOut: true, truncated: true, stderr: "fatal: unfinished" })),
    ).toBe("timeout");
  });

  it("classifies dubious-ownership refusals as unsafe-repository", () => {
    expect(
      classifyGitFailure(
        result({ stderr: "fatal: detected dubious ownership in repository at '/x'" }),
      ),
    ).toBe("unsafe-repository");
    expect(
      classifyGitFailure(result({ stderr: "add safe.directory /x to allow this repository" })),
    ).toBe("unsafe-repository");
  });

  it("classifies not-a-repository from either stream, case-insensitively", () => {
    expect(
      classifyGitFailure(
        result({ stderr: "fatal: not a git repository (or any of the parent directories): .git" }),
      ),
    ).toBe("not-a-repository");
    expect(classifyGitFailure(result({ stdout: "Not a Git repository" }))).toBe("not-a-repository");
  });

  it("prefers unsafe-repository over not-a-repository when both phrases appear", () => {
    expect(
      classifyGitFailure(
        result({ stderr: "detected dubious ownership; not a git repository fallback text" }),
      ),
    ).toBe("unsafe-repository");
  });

  it("falls back to git-error for anything unrecognized", () => {
    expect(classifyGitFailure(result({ stderr: "fatal: ambiguous argument" }))).toBe("git-error");
    expect(classifyGitFailure(result({ exitCode: null, signal: "SIGTERM" }))).toBe("git-error");
  });
});
