import { describe, expect, it } from "vitest";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import { isGitHubIssueReaderAuthorized } from "./githubIssueReaderAuthorization.js";

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

  // ADR-0173: a denied external read must be reconstructable from the log alone. Without a decision
  // line, "no row", "grant withdrawn" and "no repository named" are indistinguishable in a support
  // timeline, and the reason the read was blocked is lost.
  it.each([
    ["authorized", granted, ROOT as string | undefined, true],
    ["no-grant", depsWith(() => undefined), ROOT as string | undefined, false],
    [
      "revoked",
      depsWith((repositoryId) => ({ repositoryId, authorized: false, revision: 2 })),
      ROOT as string | undefined,
      false,
    ],
    ["repository-unresolved", granted, undefined as string | undefined, false],
  ] as const)("records the %s decision on the activity log", (decision, deps, root, authorized) => {
    const { sink, events } = capturingLog();

    expect(
      isGitHubIssueReaderAuthorized(deps, root, { activityLog: sink, correlationId: "corr-3385" }),
    ).toBe(authorized);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "security",
      op: "coding-context.github-authorization.evaluated",
      correlationId: "corr-3385",
      extra: { decision, authorized },
    });
  });

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
