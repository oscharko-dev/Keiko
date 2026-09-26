import { describe, expect, it } from "vitest";

import { resolveReleaseOwnerAllowlist } from "../lib/release-owner-allowlist.mjs";

const VARIABLE_ENDPOINT = [
  "api",
  "repos/owner/repo/actions/variables/KEIKO_RELEASE_OWNER_GITHUB_LOGINS",
];

describe("resolveReleaseOwnerAllowlist", () => {
  it("prefers the environment-provided allowlist without touching gh", () => {
    const resolved = resolveReleaseOwnerAllowlist({
      configured: "owner-login",
      repository: "owner/repo",
      runGh: () => {
        throw new Error("gh must not run when the environment answers");
      },
    });
    expect(resolved).toBe("owner-login");
  });

  it("falls back to the repository variable the workflow reads", () => {
    let seen;
    const resolved = resolveReleaseOwnerAllowlist({
      configured: "   ",
      repository: "owner/repo",
      runGh: (args) => {
        seen = args;
        return { status: 0, stdout: JSON.stringify({ value: "owner-login" }) };
      },
    });
    expect(seen).toEqual(VARIABLE_ENDPOINT);
    expect(resolved).toBe("owner-login");
  });

  it("does not resolve over a failed gh call", () => {
    expect(
      resolveReleaseOwnerAllowlist({
        configured: undefined,
        repository: "owner/repo",
        runGh: () => ({ status: 1, stdout: "" }),
      }),
    ).toBeUndefined();
    expect(
      resolveReleaseOwnerAllowlist({
        configured: undefined,
        repository: "owner/repo",
        runGh: () => ({ status: 0, stdout: "", error: new Error("spawn gh ENOENT") }),
      }),
    ).toBeUndefined();
    // The optional chaining on the result anticipates a seam returning nothing at all.
    expect(
      resolveReleaseOwnerAllowlist({
        configured: undefined,
        repository: "owner/repo",
        runGh: () => undefined,
      }),
    ).toBeUndefined();
  });

  it("does not resolve over a malformed or empty variable payload", () => {
    // A refusal, never a crash: the caller decides whether an unresolved allowlist is fatal.
    expect(
      resolveReleaseOwnerAllowlist({
        configured: undefined,
        repository: "owner/repo",
        runGh: () => ({ status: 0, stdout: "not json at all" }),
      }),
    ).toBeUndefined();
    expect(
      resolveReleaseOwnerAllowlist({
        configured: undefined,
        repository: "owner/repo",
        runGh: () => ({ status: 0, stdout: JSON.stringify({ value: "   " }) }),
      }),
    ).toBeUndefined();
    expect(
      resolveReleaseOwnerAllowlist({
        configured: undefined,
        repository: "owner/repo",
        runGh: () => ({ status: 0, stdout: JSON.stringify({ name: "no value key" }) }),
      }),
    ).toBeUndefined();
  });
});
