import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import {
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "./githubIssueReaderAuthorization.js";

function capturingLog(): { readonly sink: ServerLogSink; readonly events: ServerLogEvent[] } {
  const events: ServerLogEvent[] = [];
  return {
    sink: {
      write: (event: ServerLogEvent): void => {
        events.push(event);
      },
    },
    events,
  };
}

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
  //
  // The store here authorizes ANY id on purpose. Against `granted`, an empty root simply derives a
  // different id and the store returns nothing, so the assertion passed without the guard ever
  // running — it pinned the fixture, not the code. With a store that says yes to everything, only
  // the `repositoryRoot === undefined || === ""` guard can produce false.
  it("fails closed for every absent or unusable repository root", () => {
    const authorizesAnything = depsWith((repositoryId) => ({
      repositoryId,
      authorized: true,
      revision: 1,
    }));

    expect(isGitHubIssueReaderAuthorized(authorizesAnything, undefined)).toBe(false);
    expect(isGitHubIssueReaderAuthorized(authorizesAnything, "")).toBe(false);
    // The same store authorizes a real root, so the two refusals above come from the guard and not
    // from a store that refuses everything.
    expect(isGitHubIssueReaderAuthorized(authorizesAnything, ROOT)).toBe(true);
  });

  it("fails closed when the stored row exists but withholds authorization", () => {
    const revoked = depsWith((repositoryId) => ({ repositoryId, authorized: false, revision: 2 }));
    expect(isGitHubIssueReaderAuthorized(revoked, ROOT)).toBe(false);
  });

  it("fails closed when the store has no row at all", () => {
    const empty = depsWith(() => undefined);
    expect(isGitHubIssueReaderAuthorized(empty, ROOT)).toBe(false);
  });

  // ADR-0173: a denied external read must be reconstructable from the log alone. Without a decision
  // line, "no row", "grant withdrawn" and "no repository named" are indistinguishable in a support
  // timeline, and the reason the read was blocked is lost.
  it.each([
    ["authorized", granted, ROOT as string | undefined, true, 1],
    ["no-grant", depsWith(() => undefined), ROOT as string | undefined, false, undefined],
    [
      "revoked",
      depsWith((repositoryId) => ({ repositoryId, authorized: false, revision: 2 })),
      ROOT as string | undefined,
      false,
      2,
    ],
    ["repository-unresolved", granted, undefined as string | undefined, false, undefined],
    // #3385 review: a deps graph composed without persistence must deny and say so, not throw. The
    // decision stays distinct from "no grant" so a timeline can tell an ungranted repository apart
    // from a deployment whose store was never wired.
    [
      "store-unavailable",
      {} as unknown as Pick<UiHandlerDeps, "store">,
      ROOT as string | undefined,
      false,
      undefined,
    ],
  ] as const)(
    "records the %s decision on the activity log",
    (decision, deps, root, authorized, revision) => {
      const { sink, events } = capturingLog();

      expect(
        isGitHubIssueReaderAuthorized(deps, root, {
          activityLog: sink,
          correlationId: "corr-3385",
        }),
      ).toBe(authorized);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category: "security",
        op: "coding-context.github-authorization.evaluated",
        correlationId: "corr-3385",
        extra: { decision, authorized },
      });
      // The revision names WHICH stored grant was evaluated; it is present exactly when a row was
      // read, so the JSDoc's claim and the line agree.
      expect((events[0]?.extra as { revision?: number } | undefined)?.revision).toBe(revision);
    },
  );

  it("falls back to the unknown correlation id rather than omitting it", () => {
    const { sink, events } = capturingLog();

    isGitHubIssueReaderAuthorized(granted, ROOT, { activityLog: sink });

    expect(events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });

  // The line is evidence, not content: it may carry the content-free repository id, the decision and
  // the grant state, and nothing that could reveal a path, a remote, or issue text.
  it("keeps the decision line body-free", () => {
    const { sink, events } = capturingLog();

    isGitHubIssueReaderAuthorized(granted, ROOT, { activityLog: sink });

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain("workspace");
    expect(serialized).toContain(deriveRepositoryId(ROOT));
  });
});

/**
 * The comparison layer that uses this resolver is pinned at the connector and the route, but both
 * inject `codingContextGitHubRemoteResolver`, so until these cases the PRODUCTION path — reading the
 * checkout's own `origin` through `readGitRemoteUrl` — had no test at all. That path is the
 * security-relevant half: the comparison can only be as correct as the repository it is handed, and
 * a resolver that answered the wrong repository, or answered at all where it should refuse, would
 * defeat the binding while every injected-resolver case stayed green.
 *
 * These use real `git` on a real temporary checkout. `git init` and `git remote add` touch no
 * network and need no signing key, so the cases are hermetic.
 */
describe("githubRemoteOwnerAndRepoFor — the production git path (#3385)", () => {
  const roots: string[] = [];

  function checkoutWithRemote(remoteUrl: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), "keiko-remote-"));
    roots.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    if (remoteUrl !== undefined) {
      execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: root });
    }
    return root;
  }

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("resolves owner and repo from an https origin", async () => {
    const root = checkoutWithRemote("https://github.com/oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, process.env)).resolves.toBe(
      "oscharko-dev/Keiko",
    );
  });

  it("resolves owner and repo from an scp-style origin", async () => {
    const root = checkoutWithRemote("git@github.com:oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, process.env)).resolves.toBe(
      "oscharko-dev/Keiko",
    );
  });

  // Denies rather than widens: a checkout whose origin is not GitHub authorizes no GitHub
  // repository, so the caller's "no allowed repository" means "authorize nothing".
  it("refuses a non-GitHub origin", async () => {
    const root = checkoutWithRemote("https://gitlab.com/oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, process.env)).resolves.toBeUndefined();
  });

  // A look-alike host must not pass: the comparison is on the hostname, not on a substring.
  it("refuses a host that merely contains github.com", async () => {
    const root = checkoutWithRemote("https://github.com.evil.example/oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, process.env)).resolves.toBeUndefined();
  });

  it("refuses a checkout that has no origin at all", async () => {
    const root = checkoutWithRemote(undefined);

    await expect(githubRemoteOwnerAndRepoFor(root, process.env)).resolves.toBeUndefined();
  });

  it("refuses a path that is not a git checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-not-git-"));
    roots.push(root);

    await expect(githubRemoteOwnerAndRepoFor(root, process.env)).resolves.toBeUndefined();
  });

  it("refuses an absent or empty repository root without running git", async () => {
    await expect(githubRemoteOwnerAndRepoFor(undefined, process.env)).resolves.toBeUndefined();
    await expect(githubRemoteOwnerAndRepoFor("", process.env)).resolves.toBeUndefined();
  });

  // An injected resolver that throws must deny, not propagate: the read path treats "no allowed
  // repository" as "authorize nothing", and an exception here would surface as an opaque failure
  // instead of a refusal.
  it("refuses when an injected resolver throws", async () => {
    const root = checkoutWithRemote("https://github.com/oscharko-dev/Keiko.git");

    await expect(
      githubRemoteOwnerAndRepoFor(root, process.env, () => {
        throw new Error("resolver exploded");
      }),
    ).resolves.toBeUndefined();
  });
});
