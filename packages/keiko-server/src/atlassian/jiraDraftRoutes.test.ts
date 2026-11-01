import { describe, expect, it } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createJiraDraftStore, type JiraDraftStore } from "@oscharko-dev/keiko-connectors";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import { matchRoute } from "../routes.js";
import { readJiraDraftRoute } from "./jiraDraftRoutes.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";

function item(ref: string): Record<string, unknown> {
  return { ref, projectId: "10000", issueTypeId: "10001", fields: { summary: `Item ${ref}` } };
}
function seeded(): { readonly store: JiraDraftStore; readonly digest: string } {
  const store = createJiraDraftStore({ newId: () => DRAFT_ID });
  const staged = store.append("chat-1", undefined, "fingerprint", [item("a"), item("b")]);
  if (!staged.ok) throw new Error("Expected a staged draft");
  return { store, digest: staged.draft.digest };
}
function context(query: string, draftId = DRAFT_ID): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: { draftId },
    url: new URL(`http://127.0.0.1/api/atlassian-connectors/jira-drafts/${draftId}?${query}`),
    correlationId: "correlation-1",
  };
}
function deps(
  store: JiraDraftStore | undefined,
  logs = createBufferedServerLogSink(),
): UiHandlerDeps {
  return { jiraDraftStore: store, activityLog: logs } as unknown as UiHandlerDeps;
}
function onlyLine(logs: ReturnType<typeof createBufferedServerLogSink>): string {
  const [event] = logs.events;
  if (event === undefined) throw new Error("Missing activity event");
  return formatActivityLogProofLine(event);
}

describe("Jira draft review route (#4178)", () => {
  it("is mounted on the documented path", () => {
    expect(matchRoute("GET", `/api/atlassian-connectors/jira-drafts/${DRAFT_ID}`)).toMatchObject({
      params: { draftId: DRAFT_ID },
    });
  });

  it("serves the staged items to the Chat that staged them, for the digest it was asked for", () => {
    const { store, digest } = seeded();
    const result = readJiraDraftRoute(context(`chatId=chat-1&digest=${digest}`), deps(store));
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "Cache-Control": "no-store" });
    expect(result.body).toMatchObject({
      draftId: DRAFT_ID,
      draftDigest: digest,
      itemCount: 2,
      items: [item("a"), item("b")],
    });
  });

  it.each([
    [
      "another Chat",
      (digest: string): string => `chatId=chat-2&digest=${digest}`,
      404,
      "draft-not-found",
    ],
    [
      "a changed digest",
      (): string => `chatId=chat-1&digest=${"0".repeat(64)}`,
      404,
      "draft-changed",
    ],
    ["a malformed digest", (): string => "chatId=chat-1&digest=nope", 400, "invalid-input"],
    ["a missing Chat", (digest: string): string => `digest=${digest}`, 400, "invalid-input"],
  ] as const)("refuses %s with a logged, closed reason", (_name, query, status, refusal) => {
    const { store, digest } = seeded();
    const logs = createBufferedServerLogSink();
    const result = readJiraDraftRoute(context(query(digest)), deps(store, logs));
    expect(result.status).toBe(status);
    expect(expectActivityLogProof("atlassian.jira-draft.line", onlyLine(logs))).toMatchObject({
      phase: "refused",
      level: "warn",
      refusal,
    });
  });

  it("refuses when no store exists or the draft id is malformed", () => {
    const query = `chatId=chat-1&digest=${"a".repeat(64)}`;
    expect(readJiraDraftRoute(context(query), deps(undefined)).status).toBe(404);
    expect(readJiraDraftRoute(context(query, "../x"), deps(seeded().store)).status).toBe(400);
  });
});

describe("Jira draft activity (#4178)", () => {
  it("reconstructs a staged page from counts alone, never an item", () => {
    const logs = createBufferedServerLogSink();
    recordJiraDraftActivity(logs, "correlation-2", {
      phase: "staged",
      newDraft: false,
      pageItemCount: 50,
      itemCount: 150,
      pageCount: 3,
      byteCount: 48_213,
      unresolvedRefCount: 4,
      violationCount: 0,
      durationMs: 41,
    });
    const line = onlyLine(logs);
    expect(expectActivityLogProof("atlassian.jira-draft.line", line)).toMatchObject({
      op: "atlassian.jira-draft",
      phase: "staged",
      pageItemCount: 50,
      itemCount: 150,
      pageCount: 3,
      byteCount: 48_213,
      unresolvedRefCount: 4,
    });
    expect(line).not.toContain("Item ");
    expect(analyzeLogText(line).timelines).toHaveLength(1);
  });

  it("records a draft refused above its byte bound as a warning with a closed reason", () => {
    const logs = createBufferedServerLogSink();
    recordJiraDraftActivity(logs, "correlation-3", {
      phase: "refused",
      refusal: "too-large",
      newDraft: false,
      pageItemCount: 50,
      itemCount: 0,
      pageCount: 0,
      byteCount: 0,
      unresolvedRefCount: 0,
      violationCount: 0,
      durationMs: 1,
    });
    expect(expectActivityLogProof("atlassian.jira-draft.line", onlyLine(logs))).toMatchObject({
      phase: "refused",
      refusal: "too-large",
      level: "warn",
      errorKind: "invalid-request",
      pageItemCount: 50,
    });
  });

  it("records a run's progress and end as counts only", () => {
    const logs = createBufferedServerLogSink();
    recordJiraDraftActivity(logs, "correlation-4", {
      phase: "executed",
      newDraft: false,
      pageItemCount: 0,
      itemCount: 1200,
      pageCount: 0,
      byteCount: 0,
      unresolvedRefCount: 0,
      violationCount: 0,
      settledCount: 800,
      pendingCount: 400,
      durationMs: 600_000,
    });
    expect(expectActivityLogProof("atlassian.jira-draft.line", onlyLine(logs))).toMatchObject({
      phase: "executed",
      level: "info",
      itemCount: 1200,
      settledCount: 800,
      pendingCount: 400,
    });
  });
});
