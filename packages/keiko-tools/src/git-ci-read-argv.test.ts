import { describe, expect, it } from "vitest";
import { buildGitCiReadArgv, GIT_CI_READ_KINDS } from "./git-ci-read-argv.js";

const TARGET = {
  ownerAndRepo: "owner/repo",
  prExternalId: "17",
  baseBranchName: "release/next",
  headSha: "a".repeat(40),
};
describe("closed exact-revision CI read argv", () => {
  it("pins the provider host, GET and finite explicit page numbers for every surface", () => {
    for (const kind of GIT_CI_READ_KINDS) {
      const argv = buildGitCiReadArgv(kind, TARGET, 2);
      expect(argv.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
      expect(argv).not.toContain("--paginate");
      expect(argv).not.toContain("--input");
      expect(argv.join(" ")).not.toContain("authorization");
      expect(argv[5]).toMatch(/^\/repos\/owner\/repo\//u);
    }
  });
  it("retains list totals and binds check/status endpoints to the full immutable head", () => {
    const checks = buildGitCiReadArgv("check-runs", TARGET, 3);
    expect(checks[5]).toBe(
      `/repos/owner/repo/commits/${TARGET.headSha}/check-runs?filter=all&per_page=100&page=3`,
    );
    expect(checks.at(-1)).toContain("total:.total_count");
    const statuses = buildGitCiReadArgv("commit-statuses", TARGET, 1);
    expect(statuses[5]).toBe(
      `/repos/owner/repo/commits/${TARGET.headSha}/statuses?per_page=100&page=1`,
    );
    expect(buildGitCiReadArgv("branch-rules", TARGET, 2)[5]).toBe(
      "/repos/owner/repo/rules/branches/release%2Fnext?per_page=100&page=2",
    );
  });
  it("does not project PR bodies, provider output summaries or log URLs into these facts", () => {
    for (const kind of GIT_CI_READ_KINDS) {
      const projection = buildGitCiReadArgv(kind, TARGET, 1).at(-1);
      expect(projection).not.toMatch(/\.body|\.summary|\.text|\.logs_url|\.annotations_url/u);
    }
  });
  it("rejects malformed repository, ref, PR, revision and pagination before execution", () => {
    for (const change of [
      { ownerAndRepo: "../other" },
      { ownerAndRepo: "owner/repo?x=y" },
      { baseBranchName: "refs/heads/dev" },
      { baseBranchName: "dev~1" },
      { prExternalId: "01" },
      { prExternalId: "17\n" },
      { headSha: "abc1234" },
    ])
      expect(() => buildGitCiReadArgv("check-runs", { ...TARGET, ...change }, 1)).toThrow(
        TypeError,
      );
    for (const page of [0, -1, 6, 1.5, Infinity])
      expect(() => buildGitCiReadArgv("check-runs", TARGET, page)).toThrow(TypeError);
  });
});
