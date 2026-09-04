import { describe, expect, it } from "vitest";

import { CODING_WORKBENCH_ISSUE_NUMBER_MAX } from "./coding-workbench-runtime-api.js";
import {
  canonicalGitHubOwnerAndRepo,
  findGitHubIssueReferences,
  GITHUB_ISSUE_NUMBER_MAX,
  GITHUB_ISSUE_REFERENCE_MAX_CHARS,
  GITHUB_ISSUE_REFERENCE_REJECTIONS,
  isGitHubOwnerAndRepo,
  parseGitHubIssueNumber,
  parseGitHubIssueReference,
  sameGitHubOwnerAndRepo,
  type GitHubIssueReferenceRejection,
} from "./github-issue-reference.js";

const BOUND = "oscharko-dev/Keiko";

interface AcceptRow {
  readonly input: string;
  readonly ownerAndRepo: string;
  readonly issueNumber: number;
  readonly bound?: string | undefined;
}

interface RejectRow {
  readonly input: string;
  readonly rejection: GitHubIssueReferenceRejection;
  readonly bound?: string | undefined;
}

const ACCEPTED: readonly AcceptRow[] = [
  {
    input: "https://github.com/oscharko-dev/Keiko/issues/3385",
    ownerAndRepo: "oscharko-dev/Keiko",
    issueNumber: 3385,
  },
  {
    input: "HTTPS://GITHUB.COM/oscharko-dev/Keiko/issues/1",
    ownerAndRepo: "oscharko-dev/Keiko",
    issueNumber: 1,
  },
  {
    input: "  https://github.com/acme/widgets.js/issues/42  ",
    ownerAndRepo: "acme/widgets.js",
    issueNumber: 42,
  },
  { input: "oscharko-dev/Keiko#3385", ownerAndRepo: "oscharko-dev/Keiko", issueNumber: 3385 },
  { input: "a/b#1", ownerAndRepo: "a/b", issueNumber: 1 },
  { input: "a1-b2/c.d_e-f#7", ownerAndRepo: "a1-b2/c.d_e-f", issueNumber: 7 },
  { input: "#3385", ownerAndRepo: BOUND, issueNumber: 3385, bound: BOUND },
  { input: "3385", ownerAndRepo: BOUND, issueNumber: 3385, bound: BOUND },
  { input: " #12 ", ownerAndRepo: BOUND, issueNumber: 12, bound: BOUND },
  {
    input: `#${String(GITHUB_ISSUE_NUMBER_MAX)}`,
    ownerAndRepo: BOUND,
    issueNumber: GITHUB_ISSUE_NUMBER_MAX,
    bound: BOUND,
  },
  {
    input: `${"o".repeat(39)}/${"r".repeat(100)}#5`,
    ownerAndRepo: `${"o".repeat(39)}/${"r".repeat(100)}`,
    issueNumber: 5,
  },
];

const REJECTED: readonly RejectRow[] = [
  { input: "", rejection: "empty" },
  { input: "   \n\t ", rejection: "empty" },
  // Pull requests are served from the issues endpoint too, which is exactly why they must be
  // refused by name here rather than resolved as an issue with the same number.
  { input: "https://github.com/oscharko-dev/Keiko/pull/3394", rejection: "pull-request" },
  { input: "https://github.com/oscharko-dev/Keiko/pulls/3394", rejection: "malformed" },
  { input: "https://github.com/oscharko-dev/Keiko/discussions/1", rejection: "malformed" },
  { input: "http://github.com/oscharko-dev/Keiko/issues/1", rejection: "unsupported-host" },
  { input: "https://www.github.com/oscharko-dev/Keiko/issues/1", rejection: "unsupported-host" },
  { input: "https://github.com.evil.example/o/r/issues/1", rejection: "unsupported-host" },
  { input: "https://gitlab.com/oscharko-dev/Keiko/issues/1", rejection: "unsupported-host" },
  { input: "https://github.enterprise.example/o/r/issues/1", rejection: "unsupported-host" },
  { input: "https://github.com:443/o/r/issues/1", rejection: "unsupported-host" },
  { input: "https://user:pass@github.com/o/r/issues/1", rejection: "unsupported-host" },
  { input: "https://api.github.com/repos/o/r/issues/1", rejection: "unsupported-host" },
  { input: "https://github.com/o/r/issues/1?foo=bar", rejection: "malformed" },
  { input: "https://github.com/o/r/issues/1#issuecomment-99", rejection: "malformed" },
  { input: "https://github.com/o/r/issues/1/", rejection: "malformed" },
  { input: "https://github.com/o/r/issues", rejection: "malformed" },
  { input: "https://github.com/o/r/issues/1/comments", rejection: "malformed" },
  { input: "https://github.com//o/r/issues/1", rejection: "malformed" },
  { input: "https://github.com/o/r/../x/issues/1", rejection: "malformed" },
  { input: "https://github.com/o/../issues/1", rejection: "invalid-repository" },
  { input: "https://github.com/./r/issues/1", rejection: "invalid-repository" },
  { input: "https://github.com/o/%2e%2e/issues/1", rejection: "invalid-repository" },
  { input: "https://github.com/o/r/issues/0", rejection: "invalid-number" },
  { input: "https://github.com/o/r/issues/01", rejection: "invalid-number" },
  { input: "https://github.com/o/r/issues/-1", rejection: "invalid-number" },
  { input: "https://github.com/o/r/issues/1e3", rejection: "invalid-number" },
  { input: "https://github.com/o/r/issues/１２", rejection: "invalid-number" },
  {
    input: `https://github.com/o/r/issues/${String(GITHUB_ISSUE_NUMBER_MAX + 1)}`,
    rejection: "invalid-number",
  },
  { input: "github.com/o/r/issues/1", rejection: "malformed" },
  { input: "o/r/issues/1", rejection: "malformed" },
  { input: "o/r#1#2", rejection: "malformed" },
  { input: "#1", rejection: "repository-required" },
  { input: "1", rejection: "repository-required" },
  { input: "#0", rejection: "invalid-number", bound: BOUND },
  { input: "#", rejection: "invalid-number", bound: BOUND },
  { input: "#abc", rejection: "invalid-number", bound: BOUND },
  { input: "#1", rejection: "invalid-repository", bound: "not a repo" },
  { input: "#1", rejection: "repository-required", bound: "" },
  { input: "-o/r#1", rejection: "invalid-repository" },
  { input: "o-/r#1", rejection: "invalid-repository" },
  { input: "o_o/r#1", rejection: "invalid-repository" },
  { input: `${"o".repeat(40)}/r#1`, rejection: "invalid-repository" },
  { input: `o/${"r".repeat(101)}#1`, rejection: "invalid-repository" },
  { input: "o/..#1", rejection: "invalid-repository" },
  { input: "o/.#1", rejection: "invalid-repository" },
  { input: "o/r/x#1", rejection: "invalid-repository" },
  { input: "o/r --paginate#1", rejection: "invalid-repository" },
  { input: "o/r#1 --paginate", rejection: "invalid-number" },
  { input: "o/r#9999999999", rejection: "invalid-number" },
  { input: "o/r#１２", rejection: "invalid-number" },
  { input: "o/r# 1", rejection: "invalid-number" },
  { input: "o/r#1\nx", rejection: "malformed" },
  { input: `o/r#${"1".repeat(GITHUB_ISSUE_REFERENCE_MAX_CHARS)}`, rejection: "malformed" },
  { input: "javascript:alert(1)", rejection: "malformed" },
  { input: "issue #1", rejection: "invalid-repository" },
];

describe("parseGitHubIssueReference (#3385)", () => {
  it.each(ACCEPTED)("accepts $input", ({ input, ownerAndRepo, issueNumber, bound }) => {
    expect(parseGitHubIssueReference(input, { boundOwnerAndRepo: bound })).toEqual({
      ok: true,
      reference: { ownerAndRepo, issueNumber },
    });
  });

  it.each(REJECTED)("rejects $input as $rejection", ({ input, rejection, bound }) => {
    expect(parseGitHubIssueReference(input, { boundOwnerAndRepo: bound })).toEqual({
      ok: false,
      rejection,
    });
  });

  it("covers every rejection in the closed vocabulary with at least one row", () => {
    const seen = new Set(REJECTED.map((row) => row.rejection));
    for (const rejection of GITHUB_ISSUE_REFERENCE_REJECTIONS) expect(seen.has(rejection)).toBe(true);
    expect(seen.size).toBe(GITHUB_ISSUE_REFERENCE_REJECTIONS.length);
  });

  // A traversal is refused as written, never resolved into a neighbouring repository, and the bound
  // repository comes back exactly as the caller spelled it: the parser rewrites nothing.
  it("never rewrites the input into a different reference", () => {
    const traversal = parseGitHubIssueReference("https://github.com/o/r/../x/issues/1");
    expect(traversal.ok).toBe(false);
    const relative = parseGitHubIssueReference("#7", { boundOwnerAndRepo: "Acme/Widgets" });
    expect(relative).toEqual({
      ok: true,
      reference: { ownerAndRepo: "Acme/Widgets", issueNumber: 7 },
    });
  });

  // A pasted URL does not get to name the repository a relative reference resolves against: the
  // bound repository is what the caller (the server) resolved, and the input only supplies a number.
  it("resolves a relative reference only against the caller-supplied bound repository", () => {
    const result = parseGitHubIssueReference("#3385", { boundOwnerAndRepo: "someone-else/repo" });
    expect(result).toEqual({
      ok: true,
      reference: { ownerAndRepo: "someone-else/repo", issueNumber: 3385 },
    });
  });
});

describe("GitHub segment rules", () => {
  it("shares one owner/repo rule with every surface that used to carry its own regex", () => {
    expect(isGitHubOwnerAndRepo("oscharko-dev/Keiko")).toBe(true);
    expect(isGitHubOwnerAndRepo("oscharko-dev/Keiko --paginate")).toBe(false);
    expect(isGitHubOwnerAndRepo("oscharko-dev/..")).toBe(false);
    expect(isGitHubOwnerAndRepo("owner/repo/../../user")).toBe(false);
    expect(isGitHubOwnerAndRepo("owner")).toBe(false);
    expect(isGitHubOwnerAndRepo("/repo")).toBe(false);
    expect(isGitHubOwnerAndRepo("owner/")).toBe(false);
    expect(isGitHubOwnerAndRepo("[REDACTED]/repo")).toBe(false);
  });

  it("parses only bounded ASCII issue numbers", () => {
    expect(parseGitHubIssueNumber("1989")).toBe(1989);
    expect(parseGitHubIssueNumber(String(GITHUB_ISSUE_NUMBER_MAX))).toBe(GITHUB_ISSUE_NUMBER_MAX);
    expect(parseGitHubIssueNumber(String(GITHUB_ISSUE_NUMBER_MAX + 1))).toBeUndefined();
    expect(parseGitHubIssueNumber("0")).toBeUndefined();
    expect(parseGitHubIssueNumber("007")).toBeUndefined();
    expect(parseGitHubIssueNumber("１２")).toBeUndefined();
    expect(parseGitHubIssueNumber("12 ")).toBeUndefined();
    expect(parseGitHubIssueNumber("")).toBeUndefined();
  });

  // One bound, stated twice by necessity (the binding validator's copy lives in a module this leaf
  // cannot import without a cycle). This pin is what keeps the two from drifting apart.
  it("bounds issue numbers exactly as the issue-binding validator does", () => {
    expect(GITHUB_ISSUE_NUMBER_MAX).toBe(CODING_WORKBENCH_ISSUE_NUMBER_MAX);
  });

  it("compares repositories the way GitHub does: case-insensitively", () => {
    expect(canonicalGitHubOwnerAndRepo("Oscharko-Dev/KEIKO")).toBe("oscharko-dev/keiko");
    expect(sameGitHubOwnerAndRepo("Oscharko-Dev/KEIKO", "oscharko-dev/keiko")).toBe(true);
    expect(sameGitHubOwnerAndRepo("oscharko-dev/keiko", "oscharko-dev/keiko2")).toBe(false);
  });
});

describe("findGitHubIssueReferences", () => {
  it("finds every well-formed owner/repo#n in order, bounded by the limit", () => {
    const text = "see acme/widgets#42 and acme/widgets#7, not acme/widgets#0 nor o-/r#1; a/b#3";
    expect(findGitHubIssueReferences(text, 10)).toEqual([
      { ownerAndRepo: "acme/widgets", issueNumber: 42 },
      { ownerAndRepo: "acme/widgets", issueNumber: 7 },
      { ownerAndRepo: "a/b", issueNumber: 3 },
    ]);
    expect(findGitHubIssueReferences(text, 2)).toHaveLength(2);
    expect(findGitHubIssueReferences(text, 0)).toEqual([]);
    expect(findGitHubIssueReferences("no references here", 4)).toEqual([]);
  });

  it("does not read an issue URL or a number above the bound as a reference", () => {
    expect(
      findGitHubIssueReferences("https://github.com/acme/widgets/issues/42 acme/widgets#9999999999", 4),
    ).toEqual([]);
  });
});
