import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/index.js";
import {
  githubIssueReaderRepositoryId,
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

// A REAL directory, because the grant identity is a digest of the realpath'd root and a path that
// does not resolve has no identity at all. `/workspace/authorized-project` used to stand here; it
// passed only while the reader digested the string it was given, which is the split that let a
// symlinked checkout be granted under one id and looked up under another.
const ROOT = mkdtempSync(join(tmpdir(), "keiko-granted-root-"));
// The id the production entry point derives — never restated from the formula, so a change to how
// the identity is canonicalised moves the fixture with it instead of leaving it green over a defect.
const ROOT_ID = githubIssueReaderRepositoryId(ROOT);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

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
  repositoryId === ROOT_ID ? { repositoryId, authorized: true, revision: 1 } : undefined,
);

describe("isGitHubIssueReaderAuthorized (#3385)", () => {
  // The split this identity closes, from the reader's side: the SAME checkout reached through a
  // symlink must resolve to the SAME grant. `/tmp` on macOS is itself a link to `/private/tmp`, so
  // the temp root above already is one; this makes the alias explicit and asserts both forms agree.
  it("resolves a symlinked path to the same grant as its target", () => {
    const alias = join(mkdtempSync(join(tmpdir(), "keiko-alias-")), "link");
    symlinkSync(ROOT, alias);
    try {
      expect(githubIssueReaderRepositoryId(alias)).toBe(ROOT_ID);
      expect(isGitHubIssueReaderAuthorized(granted, alias)).toBe(true);
    } finally {
      rmSync(alias, { force: true });
    }
  });

  // A root that no longer exists has no identity, and the reader says which refusal that was rather
  // than digesting the dead string and answering "no grant" for a repository nobody ever named.
  it("denies a root that does not resolve as repository-unresolved", () => {
    const { sink, events } = capturingLog();
    const gone = join(tmpdir(), "keiko-never-existed-" + String(process.pid));

    expect(isGitHubIssueReaderAuthorized(granted, gone, { activityLog: sink })).toBe(false);
    expect(events[0]?.extra).toMatchObject({
      decision: "repository-unresolved",
      authorized: false,
    });
  });

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
    expect(serialized).toContain(ROOT_ID);
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
/**
 * The only environment a real git child gets in these cases. `process.env` was the defect: on
 * GitHub Actions it carries `GITHUB_REPOSITORY=oscharko-dev/Keiko`, whose value the spawn boundary
 * scrubs out of git's output, so the very URL under test came back as `[REDACTED]` and the suite
 * was red only on CI. On a developer machine it carries the real `HOME`, whose `~/.gitconfig`
 * `insteadOf` rules rewrite the remote, so the suite was red only for people with a mirror. A
 * hermetic case names its environment.
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: home };
}

describe("githubRemoteOwnerAndRepoFor — the production git path (#3385)", () => {
  const roots: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "keiko-empty-home-"));
  roots.push(home);

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

    await expect(githubRemoteOwnerAndRepoFor(root, hermeticEnv(home))).resolves.toBe(
      "oscharko-dev/Keiko",
    );
  });

  it("resolves owner and repo from an scp-style origin", async () => {
    const root = checkoutWithRemote("git@github.com:oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, hermeticEnv(home))).resolves.toBe(
      "oscharko-dev/Keiko",
    );
  });

  // Denies rather than widens: a checkout whose origin is not GitHub authorizes no GitHub
  // repository, so the caller's "no allowed repository" means "authorize nothing".
  it("refuses a non-GitHub origin", async () => {
    const root = checkoutWithRemote("https://gitlab.com/oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, hermeticEnv(home))).resolves.toBeUndefined();
  });

  // A look-alike host must not pass: the comparison is on the hostname, not on a substring.
  it("refuses a host that merely contains github.com", async () => {
    const root = checkoutWithRemote("https://github.com.evil.example/oscharko-dev/Keiko.git");

    await expect(githubRemoteOwnerAndRepoFor(root, hermeticEnv(home))).resolves.toBeUndefined();
  });

  it("refuses a checkout that has no origin at all", async () => {
    const root = checkoutWithRemote(undefined);

    await expect(githubRemoteOwnerAndRepoFor(root, hermeticEnv(home))).resolves.toBeUndefined();
  });

  it("refuses a path that is not a git checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-not-git-"));
    roots.push(root);

    await expect(githubRemoteOwnerAndRepoFor(root, hermeticEnv(home))).resolves.toBeUndefined();
  });

  it("refuses an absent or empty repository root without running git", async () => {
    await expect(
      githubRemoteOwnerAndRepoFor(undefined, hermeticEnv(home)),
    ).resolves.toBeUndefined();
    await expect(githubRemoteOwnerAndRepoFor("", hermeticEnv(home))).resolves.toBeUndefined();
  });

  // An injected resolver that throws must deny, not propagate: the read path treats "no allowed
  // repository" as "authorize nothing", and an exception here would surface as an opaque failure
  // instead of a refusal.
  it("refuses when an injected resolver throws", async () => {
    const root = checkoutWithRemote("https://github.com/oscharko-dev/Keiko.git");

    await expect(
      githubRemoteOwnerAndRepoFor(root, hermeticEnv(home), () => {
        throw new Error("resolver exploded");
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * AGENTS.md §7 and §8: a swallowed failure loses the defect, and every changed runtime behaviour
 * leaves body-free evidence. Both `catch` blocks here used to return `undefined` in silence, and the
 * comment in front of one of them said a missing remote, a non-GitHub remote and a failed read "all
 * mean the same thing". They do not: the first two are how a checkout without a GitHub remote is
 * SUPPOSED to look, the third is a broken `git`. An operator saw one denial for all three.
 */
describe("githubRemoteOwnerAndRepoFor — emitted evidence (#3385)", () => {
  const roots: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "keiko-empty-home-"));
  roots.push(home);

  function checkoutWithRemote(remoteUrl: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), "keiko-remote-log-"));
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

  it("records a resolved remote at debug", async () => {
    const { sink, events } = capturingLog();
    const root = checkoutWithRemote("https://github.com/oscharko-dev/Keiko.git");

    await githubRemoteOwnerAndRepoFor(root, hermeticEnv(home), undefined, {
      activityLog: sink,
      correlationId: "corr-resolved",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "debug",
      category: "security",
      op: "coding-context.github-remote.evaluated",
      correlationId: "corr-resolved",
      extra: { outcome: "resolved" },
    });
  });

  // The distinction the finding asked for: a remote that is simply not GitHub is expected, so it is
  // reported as information and carries no errorKind.
  it("separates a non-GitHub remote from an operational fault", async () => {
    const { sink, events } = capturingLog();
    const root = checkoutWithRemote("https://gitlab.com/oscharko-dev/Keiko.git");

    await githubRemoteOwnerAndRepoFor(root, hermeticEnv(home), undefined, { activityLog: sink });

    expect(events[0]).toMatchObject({ level: "info", extra: { outcome: "remote-not-github" } });
    expect(events[0]?.errorKind).toBeUndefined();
  });

  // A checkout that is not a repository at all cannot be told from the case above without this.
  it("reports an unreadable remote as a warning with a classified errorKind", async () => {
    const { sink, events } = capturingLog();
    const root = mkdtempSync(join(tmpdir(), "keiko-not-git-log-"));
    roots.push(root);

    await githubRemoteOwnerAndRepoFor(root, hermeticEnv(home), undefined, { activityLog: sink });

    expect(events[0]).toMatchObject({ level: "warn", extra: { outcome: "remote-unreadable" } });
    expect(typeof events[0]?.errorKind).toBe("string");
    expect(events[0]?.errorKind).not.toBe("");
  });

  it("reports an injected resolver that throws as its own fault, still denying", async () => {
    const { sink, events } = capturingLog();

    const resolved = await githubRemoteOwnerAndRepoFor(
      "/workspace/project",
      hermeticEnv(home),
      () => {
        throw new Error("resolver exploded");
      },
      { activityLog: sink },
    );

    expect(resolved).toBeUndefined();
    expect(events[0]).toMatchObject({ level: "warn", extra: { outcome: "resolver-failed" } });
    expect(typeof events[0]?.errorKind).toBe("string");
  });

  // The mechanism that turned CI red on 56ffa39c, made deterministic: an environment value that
  // appears inside the owner name is scrubbed out of git's output, the URL arrives as
  // `https://github.com/[REDACTED].git`, and the read is refused. Before this outcome existed the
  // line said "remote-not-github", which is the opposite of what happened.
  it("names a redacted remote as its own fault instead of a non-GitHub remote", async () => {
    const { sink, events } = capturingLog();
    const root = checkoutWithRemote("https://github.com/oscharko-dev/Keiko.git");

    const resolved = await githubRemoteOwnerAndRepoFor(
      root,
      { ...hermeticEnv(home), GITHUB_REPOSITORY: "oscharko-dev/Keiko" },
      undefined,
      { activityLog: sink },
    );

    expect(resolved).toBeUndefined();
    expect(events[0]).toMatchObject({ level: "warn", extra: { outcome: "remote-redacted" } });
    expect(JSON.stringify(events[0])).not.toContain("oscharko-dev");
  });

  it("records an absent repository root without running git", async () => {
    const { sink, events } = capturingLog();

    await githubRemoteOwnerAndRepoFor("", hermeticEnv(home), undefined, { activityLog: sink });

    expect(events[0]).toMatchObject({ extra: { outcome: "repository-unresolved" } });
  });

  it("falls back to the unknown correlation id rather than omitting it", async () => {
    const { sink, events } = capturingLog();

    await githubRemoteOwnerAndRepoFor("", hermeticEnv(home), undefined, { activityLog: sink });

    expect(events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });

  // The line is evidence, not content. It may never carry the checkout path, the remote URL, or the
  // resolved repository — a customer's private repository name is exactly the kind of value ADR-0173
  // D4 keeps out of the log.
  it("keeps every outcome line body-free", async () => {
    const { sink, events } = capturingLog();
    const root = checkoutWithRemote("https://github.com/oscharko-dev/Keiko.git");

    await githubRemoteOwnerAndRepoFor(root, hermeticEnv(home), undefined, { activityLog: sink });

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("github.com");
    expect(serialized).not.toContain("oscharko-dev");
    expect(serialized).not.toContain("Keiko");
  });
});
