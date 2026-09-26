import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLiveJourneyEnv } from "./coding-issue-journey-live-runners.js";

const roots: string[] = [];
const previousRoot = process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT;
const previousIssue = process.env.KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT;
  else process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT = previousRoot;
  if (previousIssue === undefined)
    delete process.env.KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE;
  else process.env.KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE = previousIssue;
});

describe("live journey environment", () => {
  it("uses the canonical controlled-repository identity rendered by production", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-live-root-"));
    roots.push(root);
    const repository = join(root, "repository");
    const alias = join(root, "repository-alias");
    mkdirSync(repository);
    symlinkSync(repository, alias);
    process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT = alias;
    process.env.KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE = "#1";

    expect(resolveLiveJourneyEnv()).toEqual({
      repositoryRoot: realpathSync(repository),
      issueRef: "#1",
    });
  });
});
