import { describe, expect, it } from "vitest";
import {
  GIT_REMOTE_FAILURE_REASONS,
  classifyGitFailure,
  classifyGitRemoteFailure,
} from "./classify.js";
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

describe("classifyGitRemoteFailure", () => {
  it("keeps the wall-clock timeout and the byte cap as DISTINCT reasons", () => {
    // The runner sets `truncated` for BOTH stops; only `timedOut` means the wall clock fired. A
    // classifier that reads `truncated` alone reports every over-cap run as a timeout (#2F sync/clone).
    expect(classifyGitRemoteFailure(result({ truncated: true, timedOut: true }))).toBe("timeout");
    expect(classifyGitRemoteFailure(result({ truncated: true, timedOut: false }))).toBe(
      "output-truncated",
    );
    expect(classifyGitRemoteFailure(result({ truncated: true, timedOut: undefined }))).toBe(
      "output-truncated",
    );
  });

  it("maps exit 127 to git-missing ahead of every other signal", () => {
    expect(
      classifyGitRemoteFailure(
        result({ exitCode: 127, stderr: "git executable unavailable", truncated: true }),
      ),
    ).toBe("git-missing");
  });

  it("classifies an unreachable remote as remote-unavailable, not as an auth failure", () => {
    for (const stderr of [
      "ssh: Could not resolve hostname github.com: Name or service not known\r\nfatal: Could not read from remote repository.",
      "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.",
      "ssh: connect to host github.com port 22: Operation timed out",
      "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid",
      "ssh: connect to host github.com port 22: Network is unreachable",
      "fatal: Could not read from remote repository.",
    ]) {
      expect(classifyGitRemoteFailure(result({ stderr }))).toBe("remote-unavailable");
    }
  });

  it("still classifies real credential failures as auth-failed", () => {
    for (const stderr of [
      "fatal: Authentication failed for 'https://example.com/x.git/'",
      "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      "git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.",
      "fatal: unable to access 'https://example.com/x.git/': The requested URL returned error: 401",
    ]) {
      expect(classifyGitRemoteFailure(result({ stderr }))).toBe("auth-failed");
    }
  });

  it("separates authorization denials from authentication failures", () => {
    expect(
      classifyGitRemoteFailure(
        result({ stderr: "remote: Permission to owner/repo.git denied to user." }),
      ),
    ).toBe("permission-denied");
    expect(
      classifyGitRemoteFailure(
        result({
          stderr: "fatal: unable to access 'https://x/': The requested URL returned error: 403",
        }),
      ),
    ).toBe("permission-denied");
  });

  it("classifies a missing repository distinctly from a credential failure", () => {
    for (const stderr of [
      "ERROR: Repository not found.\r\nfatal: Could not read from remote repository.",
      "remote: The project you were looking for could not be found or you don't have permission to view it.",
      "fatal: 'up' does not appear to be a git repository",
    ]) {
      expect(classifyGitRemoteFailure(result({ stderr }))).toBe("repository-not-found");
    }
  });

  it("keeps host-trust and ownership refusals ahead of the credential phrases", () => {
    expect(
      classifyGitRemoteFailure(
        result({
          stderr: "Host key verification failed.\nfatal: Could not read from remote repository.",
        }),
      ),
    ).toBe("untrusted-host-key");
    expect(
      classifyGitRemoteFailure(
        result({ stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" }),
      ),
    ).toBe("untrusted-host-key");
    expect(
      classifyGitRemoteFailure(
        result({ stderr: "fatal: detected dubious ownership in repository at '/x'" }),
      ),
    ).toBe("unsafe-repository");
  });

  it("classifies a local not-a-repository refusal without reaching the remote vocabulary", () => {
    expect(
      classifyGitRemoteFailure(
        result({ stderr: "fatal: not a git repository (or any of the parent directories): .git" }),
      ),
    ).toBe("not-a-repository");
  });

  it("falls back to git-error for an unrecognized failure and reports success for exit 0", () => {
    expect(classifyGitRemoteFailure(result({ stderr: "fatal: ambiguous argument" }))).toBe(
      "git-error",
    );
    expect(classifyGitRemoteFailure(result({ exitCode: 0 }))).toBe("none");
  });

  it("exposes every reason in GIT_REMOTE_FAILURE_REASONS", () => {
    expect(new Set(GIT_REMOTE_FAILURE_REASONS).size).toBe(GIT_REMOTE_FAILURE_REASONS.length);
    expect(GIT_REMOTE_FAILURE_REASONS).toContain("remote-unavailable");
    expect(GIT_REMOTE_FAILURE_REASONS).toContain("output-truncated");
  });
});
