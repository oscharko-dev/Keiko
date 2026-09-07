import { describe, expect, it } from "vitest";
import { buildGitCiFailureArgv } from "./git-ci-failure-argv.js";

const source = { repository: "owner/repo", id: 123, attempt: 2 };
describe("closed CI diagnostic GET vocabulary", () => {
  it("pins annotations and jobs to observed numeric source identities", () => {
    expect(buildGitCiFailureArgv("annotations", source, 2)).toContain(
      "/repos/owner/repo/check-runs/123/annotations?per_page=50&page=2",
    );
    expect(buildGitCiFailureArgv("jobs", source, 1)).toContain(
      "/repos/owner/repo/actions/runs/123/attempts/2/jobs?per_page=50&page=1",
    );
    expect(buildGitCiFailureArgv("check-run", source)).toContain(
      "/repos/owner/repo/check-runs/123",
    );
    expect(buildGitCiFailureArgv("workflow-run", source)).toContain(
      "/repos/owner/repo/actions/runs/123",
    );
  });
  it.each([
    "https://evil.test/owner/repo",
    "owner/../repo",
    "owner/repo?host=evil",
    "owner/repo/extra",
  ])("rejects arbitrary repository operands %s", (repository) => {
    expect(() => buildGitCiFailureArgv("annotations", { ...source, repository })).toThrow(
      TypeError,
    );
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid source identities %i",
    (id) => {
      expect(() => buildGitCiFailureArgv("check-run", { ...source, id })).toThrow(TypeError);
    },
  );
  it("admits no mutations, URLs, pagination escape or model-selected raw operands", () => {
    expect(() => buildGitCiFailureArgv("rerun" as "jobs", source)).toThrow(TypeError);
    expect(() => buildGitCiFailureArgv("jobs", source, 3)).toThrow(TypeError);
    expect(() => buildGitCiFailureArgv("jobs", { ...source, attempt: 0 })).toThrow(TypeError);
    const argv = buildGitCiFailureArgv("annotations", source);
    expect(argv.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
    expect(argv).not.toContain("--paginate");
    expect(argv).not.toContain("--verbose");
    expect(argv.join(" ")).not.toMatch(/raw_details.*url/u);
  });
});
