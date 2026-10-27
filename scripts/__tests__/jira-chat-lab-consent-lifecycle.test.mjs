import { describe, expect, it, vi } from "vitest";
import {
  consentLifecycleObserver,
  lifecycleTurnReceipt,
} from "../testing/jira-chat-lab/consent-lifecycle.mjs";

function fixture(write = false) {
  const group = { key: "KEIKO-1", results: [] };
  const intent = {
    id: "fresh-read",
    operation: write ? "jira.comment" : "jira.issue",
    arguments: { issueKey: group.key },
    clientTurnId: "new-client-turn",
    expectedReadGrants: 0,
    transport: "buffered",
  };
  const user = {
    id: "new-user",
    role: "user",
    turnState: "completed",
    toolTranscript: {
      exchanges: [
        {
          call: { name: write ? "jira_comment" : "jira_issue", arguments: intent.arguments },
          result: {
            status: "completed",
            invocationId: "new-invocation",
            data: { outcome: "succeeded", items: [{ key: group.key }] },
          },
          ...(write ? { mutationOutcome: "succeeded" } : {}),
        },
      ],
    },
  };
  return {
    group,
    intent,
    user,
    observed: {
      completed: { messages: [user] },
      decisions: { grants: 0, approvals: write ? 1 : 0 },
    },
    dispatch: {
      attempts: write ? 1 : 0,
      forwarded: write ? 1 : 0,
      status: write ? 201 : 0,
      issueReads: 1,
    },
  };
}

describe("new-turn restart and rotation qualification", () => {
  it("requires a genuinely new canonical user and invocation after restart", () => {
    const f = fixture();
    expect(lifecycleTurnReceipt(f.group, f.observed, f.intent, f.dispatch)).toMatchObject({
      userId: "new-user",
      invocationId: "new-invocation",
      grants: 0,
    });
    f.group.results.push({
      userId: "new-user",
      clientTurnId: "old-client-turn",
      invocationId: "old-invocation",
    });
    expect(() => lifecycleTurnReceipt(f.group, f.observed, f.intent, f.dispatch)).toThrow();
  });

  it("does not accept a cached result as a newly executed Jira read", () => {
    const f = fixture();
    f.dispatch.issueReads = 0;
    expect(() => lifecycleTurnReceipt(f.group, f.observed, f.intent, f.dispatch)).toThrow();
  });

  it("refuses extra disclosure when proving persistence across restart", () => {
    const f = fixture();
    f.observed.decisions.grants = 1;
    expect(() => lifecycleTurnReceipt(f.group, f.observed, f.intent, f.dispatch)).toThrow();
  });

  it("requires known success and exactly one approved write after rotation", () => {
    const f = fixture(true);
    expect(lifecycleTurnReceipt(f.group, f.observed, f.intent, f.dispatch)).toMatchObject({
      approvals: 1,
      forwarded: 1,
      status: 201,
    });
    f.user.toolTranscript.exchanges[0].mutationOutcome = "unknown";
    expect(() => lifecycleTurnReceipt(f.group, f.observed, f.intent, f.dispatch)).toThrow();
  });

  it("counts forwarded target reads and preserves the original custody lifecycle", async () => {
    const observer = consentLifecycleObserver();
    const lifecycle = { beforeDispatch: vi.fn(), onResponse: vi.fn() };
    const request = vi.fn(async () => ({ kind: "response", status: 200 }));
    const factory = vi.fn(() => request);
    const port = observer.decorate(factory)({ credential: "opaque" }, "correlation", lifecycle);
    observer.arm("KEIKO-1", "Synthetic fixture", false);
    await port({ method: "GET", url: "https://fixture.invalid/rest/api/2/serverInfo" });
    await port({ method: "GET", url: "https://fixture.invalid/rest/api/2/issue/KEIKO-1" });
    expect(observer.snapshot()).toEqual({ attempts: 0, forwarded: 0, status: 0, issueReads: 1 });
    expect(factory).toHaveBeenCalledWith({ credential: "opaque" }, "correlation", lifecycle);
    await expect(
      port({
        method: "POST",
        url: "https://fixture.invalid/rest/api/2/issue/KEIKO-1/comment",
        bodyJson: JSON.stringify({ body: "Synthetic fixture" }),
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
