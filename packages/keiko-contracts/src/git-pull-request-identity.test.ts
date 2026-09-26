import { describe, expect, it } from "vitest";
import {
  isGitPullRequestIdentity,
  type GitPullRequestIdentity,
} from "./git-pull-request-identity.js";

const IDENTITY: GitPullRequestIdentity = {
  number: 3387,
  externalId: "PR_kwDO123",
  url: "https://github.com/owner/repository/pull/3387",
  repository: "owner/repository",
  headRepository: "owner/repository",
  headRef: "codex/issue-3387",
  headSha: "a".repeat(40),
  baseRef: "dev",
  baseSha: "b".repeat(40),
  state: "open",
  isDraft: true,
};

describe("remote pull request identity admission", () => {
  it.each([
    IDENTITY,
    { ...IDENTITY, state: "closed", isDraft: false },
    { ...IDENTITY, headRepository: "fork-owner/repository" },
    { ...IDENTITY, headSha: "a".repeat(64), baseSha: "b".repeat(64) },
    { ...IDENTITY, repository: "OWNER/Repository" },
  ])("admits complete observations independently of delivery eligibility", (value) => {
    expect(isGitPullRequestIdentity(value)).toBe(true);
  });

  it.each([
    "http://github.com/owner/repository/pull/3387",
    "https://github.com.attacker.test/owner/repository/pull/3387",
    "https://github.com@attacker.test/owner/repository/pull/3387",
    "https://user:password@github.com/owner/repository/pull/3387",
    "https://github.com/other/repository/pull/3387",
    "https://github.com/owner/repository/pull/3388",
    "https://github.com/owner/repository/pull/03387",
    "https://github.com/owner/repository/pull/3387?token=private",
    "https://github.com/owner/repository/pull/3387#untrusted",
    "https://github.com/owner/repository/pull/../3387",
    "https://github.com/owner/repository/pull/%33%33%38%37",
    "javascript:alert(1)",
    "https://github.com/owner/repository/pull/3387\n",
  ])("rejects a noncanonical UI destination %s", (url) => {
    expect(isGitPullRequestIdentity({ ...IDENTITY, url })).toBe(false);
  });

  it.each([
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { number: Number.NaN },
    { number: Number.POSITIVE_INFINITY },
    { number: 10 ** 10 },
    { number: "3387" },
    { externalId: "" },
    { externalId: "p".repeat(256) },
    { externalId: "provider/id" },
    { externalId: "PR_123\n" },
    { repository: "owner/.." },
    { repository: "owner/repo/extra" },
    { repository: "-owner/repo" },
    { headRepository: "owner-/repo" },
    { headRef: "refs/heads/branch" },
    { baseRef: "refs/tags/dev" },
    { headRef: "branch^{commit}" },
    { baseRef: "-dev" },
    { headRef: "branch..old" },
    { headSha: "aaaaaaa" },
    { baseSha: "HEAD" },
    { headSha: "A".repeat(40) },
    { baseSha: "b".repeat(41) },
    { state: "merged" },
    { isDraft: "true" },
    { body: "private content" },
    { title: "private title" },
    { approvalToken: "private" },
  ])("rejects invalid facts or extraneous payload %j", (change) => {
    expect(isGitPullRequestIdentity({ ...IDENTITY, ...change })).toBe(false);
  });

  it.each(Object.keys(IDENTITY))("requires the own %s fact", (key) => {
    const value = Object.fromEntries(Object.entries(IDENTITY).filter(([field]) => field !== key));
    expect(isGitPullRequestIdentity(value)).toBe(false);
  });

  it.each([undefined, null, false, 1, "identity", [], [IDENTITY], {}])(
    "refuses values that are not a complete identity",
    (value) => {
      expect(isGitPullRequestIdentity(value)).toBe(false);
    },
  );
});
