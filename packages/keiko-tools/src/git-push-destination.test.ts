import { describe, expect, it } from "vitest";
import { canonicalGitHubPushUrl } from "./git-push-destination.js";

describe("approved GitHub push transport", () => {
  it.each(["https://github.com/", "git@github.com:", "ssh://git@github.com/"])(
    "retains canonical transport %s without changing repository identity",
    (prefix) => {
      expect(canonicalGitHubPushUrl(`${prefix}Owner/Repo`)).toBe(`${prefix}Owner/Repo.git`);
      expect(canonicalGitHubPushUrl(`${prefix}Owner/Repo.git`)).toBe(`${prefix}Owner/Repo.git`);
    },
  );
  it.each([
    undefined,
    12,
    "https://github.com:8443/owner/repo",
    "https://github.com:443/owner/repo",
    "https://user@github.com/owner/repo",
    "https://github.com/owner/repo?query",
    "https://github.com/owner/repo#hash",
    "https://github.com/owner/../repo",
    "https://github.com/owner/%2e%2e",
    "https://github.com.evil.test/owner/repo",
    "ssh://git@github.com:2222/owner/repo",
    "git@github.com:owner/repo\n",
    "ext::git arbitrary",
    "file:///tmp/repository",
  ])("rejects transport ambiguity %j", (value) => {
    expect(canonicalGitHubPushUrl(value)).toBeUndefined();
  });
});
