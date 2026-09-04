import { describe, expect, it } from "vitest";
import { createInMemoryUiStore } from "./index.js";

const REPO = "repository-0123456789abcdef";
const OTHER = "repository-fedcba9876543210";

describe("GitHub issue reader authorization store (#3385)", () => {
  it("defaults to no authorization for any repository", () => {
    const store = createInMemoryUiStore();
    expect(store.readGitHubIssueReaderAuthorization(REPO)).toBeUndefined();
    store.close();
  });

  it("grants, revokes, and increments a monotonic revision", () => {
    const store = createInMemoryUiStore();

    expect(store.updateGitHubIssueReaderAuthorization(REPO, true, 0)).toEqual({
      repositoryId: REPO,
      authorized: true,
      revision: 1,
    });
    expect(store.readGitHubIssueReaderAuthorization(REPO)).toEqual({
      repositoryId: REPO,
      authorized: true,
      revision: 1,
    });
    expect(store.updateGitHubIssueReaderAuthorization(REPO, false, 1)).toEqual({
      repositoryId: REPO,
      authorized: false,
      revision: 2,
    });
    store.close();
  });

  it("scopes authorization to one repository and never leaks it to another", () => {
    const store = createInMemoryUiStore();
    store.updateGitHubIssueReaderAuthorization(REPO, true, 0);

    expect(store.readGitHubIssueReaderAuthorization(OTHER)).toBeUndefined();
    expect(store.readGitHubIssueReaderAuthorization(REPO)?.authorized).toBe(true);
    store.close();
  });

  // The asymmetry is the point: a stale client must never re-authorize a repository whose
  // authorization someone else just withdrew, but a stale REVOKE can only ever narrow access and is
  // therefore always admitted.
  it("rejects a stale grant and always admits a stale revoke", () => {
    const store = createInMemoryUiStore();
    store.updateGitHubIssueReaderAuthorization(REPO, true, 0);
    store.updateGitHubIssueReaderAuthorization(REPO, false, 1);

    expect(store.updateGitHubIssueReaderAuthorization(REPO, true, 1)).toBeUndefined();
    expect(store.readGitHubIssueReaderAuthorization(REPO)?.authorized).toBe(false);

    expect(store.updateGitHubIssueReaderAuthorization(REPO, false, 0)).toEqual({
      repositoryId: REPO,
      authorized: false,
      revision: 3,
    });
    store.close();
  });

  it("refuses a repository id that is not the bounded content-free identity", () => {
    const store = createInMemoryUiStore();
    for (const id of [
      "",
      "../escape",
      "/absolute/path",
      "repo id with spaces",
      "git@github.com:owner/repo.git",
      "a".repeat(129),
    ]) {
      expect(store.updateGitHubIssueReaderAuthorization(id, true, 0), id).toBeUndefined();
      expect(store.readGitHubIssueReaderAuthorization(id), id).toBeUndefined();
    }
    store.close();
  });
});
