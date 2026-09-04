import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { UiHandlerDeps } from "../deps.js";
import { createInMemoryUiStore } from "../store/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import {
  handleGetGitHubIssueReaderAuthorization,
  handlePutGitHubIssueReaderAuthorization,
} from "./githubAuthorizationRoutes.js";
import type { RouteContext } from "../routes.js";

const ROOT = "/workspace/selected-project";

function ctxWith(body: unknown): RouteContext {
  const raw = body === undefined ? "" : JSON.stringify(body);
  return {
    correlationId: "corr-3385",
    req: Readable.from([Buffer.from(raw)]) as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/coding-workbench/github-authorization"),
  };
}

function depsFor(store: ReturnType<typeof createInMemoryUiStore>, root = ROOT): UiHandlerDeps {
  return { store, preferredProjectPath: root } as unknown as UiHandlerDeps;
}

describe("GitHub issue reader authorization routes (#3385)", () => {
  it("reports the default deny state before any grant exists", () => {
    const store = createInMemoryUiStore();
    const result = handleGetGitHubIssueReaderAuthorization(ctxWith(undefined), depsFor(store));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      repositoryId: deriveRepositoryId(ROOT),
      authorized: false,
      revision: 0,
    });
    store.close();
  });

  // The finding this route answers: before it existed, the store had no reachable writer, so an
  // upgraded deployment lost GitHub reads with no way to restore them.
  it("grants and then revokes access for the selected repository", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);

    const granted = await handlePutGitHubIssueReaderAuthorization(
      ctxWith({ authorized: true, expectedRevision: 0 }),
      deps,
    );
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ authorized: true, revision: 1 });
    expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(ROOT))?.authorized).toBe(
      true,
    );

    const revoked = await handlePutGitHubIssueReaderAuthorization(
      ctxWith({ authorized: false, expectedRevision: 1 }),
      deps,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ authorized: false, revision: 2 });
    store.close();
  });

  it("refuses a stale grant with a conflict rather than overwriting a newer revocation", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);
    await handlePutGitHubIssueReaderAuthorization(
      ctxWith({ authorized: true, expectedRevision: 0 }),
      deps,
    );
    await handlePutGitHubIssueReaderAuthorization(
      ctxWith({ authorized: false, expectedRevision: 1 }),
      deps,
    );

    const stale = await handlePutGitHubIssueReaderAuthorization(
      ctxWith({ authorized: true, expectedRevision: 1 }),
      deps,
    );

    expect(stale.status).toBe(409);
    expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(ROOT))?.authorized).toBe(
      false,
    );
    store.close();
  });

  // The caller must not be able to name the repository: that would let a user grant access to a
  // repository they are not working in. The server resolves it from the selected project only.
  it("rejects a body that tries to name its own repository or carry extra fields", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);

    for (const body of [
      { authorized: true, expectedRevision: 0, repositoryId: "repository-attacker" },
      { authorized: true, expectedRevision: 0, repositoryRoot: "/elsewhere" },
      { authorized: "true", expectedRevision: 0 },
      { authorized: true, expectedRevision: -1 },
      { authorized: true },
      {},
    ]) {
      const result = await handlePutGitHubIssueReaderAuthorization(ctxWith(body), deps);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(ROOT))).toBeUndefined();
    store.close();
  });

  it("fails closed with a conflict when no repository is selected", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store, "");

    expect(handleGetGitHubIssueReaderAuthorization(ctxWith(undefined), deps).status).toBe(409);
    expect(
      (
        await handlePutGitHubIssueReaderAuthorization(
          ctxWith({ authorized: true, expectedRevision: 0 }),
          deps,
        )
      ).status,
    ).toBe(409);
    store.close();
  });
});
