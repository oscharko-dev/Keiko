import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UiHandlerDeps } from "../deps.js";
import { createInMemoryUiStore } from "../store/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import {
  handleGetGitHubIssueReaderAuthorization,
  handlePutGitHubIssueReaderAuthorization,
} from "./githubAuthorizationRoutes.js";
import type { RouteContext } from "../routes.js";

// `createProject` verifies the path exists, so these are real directories rather than literals.
let ROOT = "";
let LAUNCH_ROOT = "";
let NEVER_OPENED = "";
const temporaryRoots: string[] = [];

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gh-auth-")));
  temporaryRoots.push(base);
  ROOT = mkdtempSync(join(base, "selected-"));
  LAUNCH_ROOT = mkdtempSync(join(base, "launch-"));
  NEVER_OPENED = mkdtempSync(join(base, "never-opened-"));
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ctxWith(body: unknown, repositoryPath?: string): RouteContext {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const url = new URL("http://127.0.0.1/api/coding-workbench/github-authorization");
  if (repositoryPath !== undefined) url.searchParams.set("repositoryPath", repositoryPath);
  return {
    correlationId: "corr-3385",
    req: Readable.from([Buffer.from(raw)]) as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: {},
    url,
  };
}

// The launch path is deliberately a DIFFERENT repository from the one under test, so any handler
// that falls back to `preferredProjectPath` fails these cases instead of passing by coincidence.
function depsFor(store: ReturnType<typeof createInMemoryUiStore>): UiHandlerDeps {
  store.createProject(ROOT, "selected");
  store.createProject(LAUNCH_ROOT, "launch");
  return { store, preferredProjectPath: LAUNCH_ROOT } as unknown as UiHandlerDeps;
}

function grant(authorized: boolean, expectedRevision: number, repositoryPath?: string): unknown {
  return { repositoryPath: repositoryPath ?? ROOT, authorized, expectedRevision };
}

describe("GitHub issue reader authorization routes (#3385)", () => {
  it("reports the default deny state before any grant exists", () => {
    const store = createInMemoryUiStore();
    const result = handleGetGitHubIssueReaderAuthorization(
      ctxWith(undefined, ROOT),
      depsFor(store),
    );

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

    const granted = await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(true, 0)), deps);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ authorized: true, revision: 1 });
    expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(ROOT))?.authorized).toBe(
      true,
    );

    const revoked = await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(false, 1)), deps);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ authorized: false, revision: 2 });
    store.close();
  });

  it("refuses a stale grant with a conflict rather than overwriting a newer revocation", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);
    await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(true, 0)), deps);
    await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(false, 1)), deps);

    const stale = await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(true, 1)), deps);

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
      { ...(grant(true, 0) as object), repositoryId: "repository-attacker" },
      { ...(grant(true, 0) as object), extra: "field" },
      { repositoryPath: ROOT, authorized: "true", expectedRevision: 0 },
      { repositoryPath: ROOT, authorized: true, expectedRevision: -1 },
      { repositoryPath: ROOT, authorized: true },
      { authorized: true, expectedRevision: 0 },
      { repositoryPath: "", authorized: true, expectedRevision: 0 },
      {},
    ]) {
      const result = await handlePutGitHubIssueReaderAuthorization(ctxWith(body), deps);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(ROOT))).toBeUndefined();
    store.close();
  });

  // The finding this answers: the writer used to resolve the repository from the launch snapshot,
  // so launching in A and switching to B stored B's grant against A. The launch path here is a
  // different repository throughout, and the grant must still land on the one named.
  it("stores the grant against the named repository, not the launch project", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);

    const result = await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(true, 0)), deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ repositoryId: deriveRepositoryId(ROOT) });
    expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(ROOT))?.authorized).toBe(
      true,
    );
    expect(
      store.readGitHubIssueReaderAuthorization(deriveRepositoryId(LAUNCH_ROOT)),
    ).toBeUndefined();
    store.close();
  });

  it("refuses a repository the user has not opened", async () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);

    const result = await handlePutGitHubIssueReaderAuthorization(
      ctxWith(grant(true, 0, NEVER_OPENED)),
      deps,
    );

    expect(result.status).toBe(409);
    expect(
      store.readGitHubIssueReaderAuthorization(deriveRepositoryId(NEVER_OPENED)),
    ).toBeUndefined();
    store.close();
  });

  it("fails closed with a conflict when no repository is named", () => {
    const store = createInMemoryUiStore();
    const deps = depsFor(store);

    expect(handleGetGitHubIssueReaderAuthorization(ctxWith(undefined), deps).status).toBe(409);
    expect(
      handleGetGitHubIssueReaderAuthorization(ctxWith(undefined, NEVER_OPENED), deps).status,
    ).toBe(409);
    store.close();
  });
});
