import { describe, expect, it } from "vitest";

import type { UiHandlerDeps } from "../deps.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import { isGitHubIssueReaderAuthorized } from "./githubIssueReaderAuthorization.js";

const ROOT = "/workspace/authorized-project";

function depsWith(
  read: (
    repositoryId: string,
  ) => ReturnType<UiHandlerDeps["store"]["readGitHubIssueReaderAuthorization"]>,
): Pick<UiHandlerDeps, "store"> {
  return { store: { readGitHubIssueReaderAuthorization: read } } as unknown as Pick<
    UiHandlerDeps,
    "store"
  >;
}

const granted = depsWith((repositoryId) =>
  repositoryId === deriveRepositoryId(ROOT)
    ? { repositoryId, authorized: true, revision: 1 }
    : undefined,
);

describe("isGitHubIssueReaderAuthorized (#3385)", () => {
  it("authorizes only the repository that carries an explicit grant", () => {
    expect(isGitHubIssueReaderAuthorized(granted, ROOT)).toBe(true);
    expect(isGitHubIssueReaderAuthorized(granted, "/workspace/other-project")).toBe(false);
  });

  // Every one of these is a distinct way the caller can fail to name a repository. Each must answer
  // false on its own, because a single missing guard here would authorize a GitHub read that no
  // human ever granted.
  it("fails closed for every absent or unusable repository root", () => {
    expect(isGitHubIssueReaderAuthorized(granted, undefined)).toBe(false);
    expect(isGitHubIssueReaderAuthorized(granted, "")).toBe(false);
  });

  it("fails closed when the stored row exists but withholds authorization", () => {
    const revoked = depsWith((repositoryId) => ({ repositoryId, authorized: false, revision: 2 }));
    expect(isGitHubIssueReaderAuthorized(revoked, ROOT)).toBe(false);
  });

  it("fails closed when the store has no row at all", () => {
    const empty = depsWith(() => undefined);
    expect(isGitHubIssueReaderAuthorized(empty, ROOT)).toBe(false);
  });
});
