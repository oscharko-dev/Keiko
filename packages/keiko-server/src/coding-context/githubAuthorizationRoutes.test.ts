import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UiHandlerDeps } from "../deps.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../observability/index.js";
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
// A repository registered through a symlink: `LINK` is the spelling the caller names and the store
// keeps, `LINK_TARGET` is the canonical root the editor reader keys on. Same directory, two paths.
let LINK = "";
let LINK_TARGET = "";
let BASE = "";
const temporaryRoots: string[] = [];

beforeEach(() => {
  BASE = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gh-auth-")));
  temporaryRoots.push(BASE);
  ROOT = mkdtempSync(join(BASE, "selected-"));
  LAUNCH_ROOT = mkdtempSync(join(BASE, "launch-"));
  NEVER_OPENED = mkdtempSync(join(BASE, "never-opened-"));
  LINK_TARGET = mkdtempSync(join(BASE, "target-"));
  LINK = join(BASE, "link");
  symlinkSync(LINK_TARGET, LINK, "dir");
});

afterEach(() => {
  resetServerLogger();
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

  // The caller DOES name the repository — `repositoryPath` is required — because the server has no
  // reliable notion of a "current" one: the launch path is a start-up snapshot that opening another
  // repository never updates, which is how an earlier revision stored grants against the wrong
  // repository. Naming is intent; registration is authority. `repositoryId` is never accepted, so
  // the content-free identity stays server-derived, and unknown keys stay a 400.
  it("rejects a body that names a repository identity or carries unknown fields", async () => {
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

  // The blocker this answers (PR #3394): the editor reader keys its lookup on the CANONICAL root
  // (`ctx.realRoot`) — the identity `deriveRepositoryId` documents — while this writer keyed on the
  // registered spelling, which `validateProjectPath` only normalises lexically. A project opened
  // through a symlink (a checkout under macOS `/tmp`, which is `/private/tmp`) had its grant
  // written under one id and looked up under another, so the grant never took effect. Registration
  // stays lexical ("is this an opened project?"); the KEY must be the canonical one.
  describe("canonical repository identity", () => {
    function depsWithLink(store: ReturnType<typeof createInMemoryUiStore>): UiHandlerDeps {
      const deps = depsFor(store);
      store.createProject(LINK, "linked");
      return deps;
    }

    it("stores a grant made through a symlinked path under the canonical root, never the lexical one", async () => {
      const store = createInMemoryUiStore();
      const deps = depsWithLink(store);
      const canonicalId = deriveRepositoryId(realpathSync(LINK));

      const result = await handlePutGitHubIssueReaderAuthorization(
        ctxWith(grant(true, 0, LINK)),
        deps,
      );

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ repositoryId: canonicalId, authorized: true });
      expect(store.readGitHubIssueReaderAuthorization(canonicalId)).toMatchObject({
        authorized: true,
        revision: 1,
      });
      expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(LINK))).toBeUndefined();
      store.close();
    });

    it("reports the same repository identity from GET as PUT for a symlinked path", async () => {
      const store = createInMemoryUiStore();
      const deps = depsWithLink(store);

      const before = handleGetGitHubIssueReaderAuthorization(ctxWith(undefined, LINK), deps);
      const written = await handlePutGitHubIssueReaderAuthorization(
        ctxWith(grant(true, 0, LINK)),
        deps,
      );
      const after = handleGetGitHubIssueReaderAuthorization(ctxWith(undefined, LINK), deps);

      expect(before.status).toBe(200);
      expect(before.body).toEqual({
        repositoryId: deriveRepositoryId(realpathSync(LINK)),
        authorized: false,
        revision: 0,
      });
      expect(written.body).toMatchObject({ repositoryId: deriveRepositoryId(realpathSync(LINK)) });
      expect(after.body).toEqual({
        repositoryId: deriveRepositoryId(realpathSync(LINK)),
        authorized: true,
        revision: 1,
      });
      store.close();
    });

    // A registered path whose directory is gone has no canonical identity to key on. Falling back
    // to the lexical id would write a row nothing ever reads, so both verbs refuse it exactly as
    // they refuse a path that was never opened.
    it("refuses a registered repository whose directory no longer exists", async () => {
      const store = createInMemoryUiStore();
      const deps = depsFor(store);
      const gone = mkdtempSync(join(BASE, "gone-"));
      store.createProject(gone, "gone");
      rmSync(gone, { recursive: true, force: true });

      const written = await handlePutGitHubIssueReaderAuthorization(
        ctxWith(grant(true, 0, gone)),
        deps,
      );
      const read = handleGetGitHubIssueReaderAuthorization(ctxWith(undefined, gone), deps);

      expect(written.status).toBe(409);
      expect(written.body).toMatchObject({ error: { code: "UNKNOWN_REPOSITORY" } });
      expect(read.status).toBe(409);
      expect(read.body).toMatchObject({ error: { code: "UNKNOWN_REPOSITORY" } });
      expect(store.readGitHubIssueReaderAuthorization(deriveRepositoryId(gone))).toBeUndefined();
      store.close();
    });

    // ADR-0173: the change line is what a support timeline reconstructs the decision from, so it
    // must name the identity the reader will actually consult — and only that. Neither spelling of
    // the path may reach the log.
    it("logs the change under the canonical content-free identity and no path", async () => {
      const activityLog = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
      const store = createInMemoryUiStore();
      const deps = depsWithLink(store);

      await handlePutGitHubIssueReaderAuthorization(ctxWith(grant(true, 0, LINK)), deps);

      const line = activityLog.events.find(
        (event) => event.op === "coding-context.github-authorization.changed",
      );
      expect(line).toBeDefined();
      expect(line?.correlationId).toBe("corr-3385");
      expect(line?.extra).toEqual({
        repositoryId: deriveRepositoryId(realpathSync(LINK)),
        authorized: true,
        revision: 1,
      });
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(LINK);
      expect(serialized).not.toContain(realpathSync(LINK));
      store.close();
    });
  });
});
