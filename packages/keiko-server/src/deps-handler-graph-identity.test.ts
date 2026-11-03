import { describe, expect, it, vi } from "vitest";

import { installConversationReadinessInitialization, type UiHandlerDeps } from "./deps.js";
import {
  beginChatCompactionWork,
  chatCompactionWorkStopped,
} from "./chat-compaction-model-call.js";

// The Workbench description dispatcher, the semantic search lease and every cache keyed by the
// handler graph (the PR-description application services among them) are attached to the graph the
// assembly built, and the server hands the graph this function returns to its routes. #3676 made
// the function return a spread copy, so a proposal the dispatcher had just retained was unknown to
// the mounted review route (409 GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROPOSAL, found by the
// coding-issue-publish journey): the route read the copy's empty cache.

function graph(dispose: () => Promise<void>): UiHandlerDeps {
  return { dispose } as unknown as UiHandlerDeps;
}

describe("conversation readiness installation", () => {
  it("hands back the graph it was given, so everything attached to that graph stays reachable", () => {
    const assembled = graph(() => Promise.resolve());
    const attachedBeforeInstall = new WeakMap<UiHandlerDeps, string>([[assembled, "retained"]]);

    const served = installConversationReadinessInitialization(assembled);

    expect(served).toBe(assembled);
    expect(attachedBeforeInstall.get(served)).toBe("retained");
  });

  it("offers the catalog refresh on that same graph", () => {
    const assembled = graph(() => Promise.resolve());

    const served = installConversationReadinessInitialization(assembled);

    expect(served.refreshGatewayCatalog).toBeTypeOf("function");
    expect(assembled.refreshGatewayCatalog).toBe(served.refreshGatewayCatalog);
  });

  it("runs the assembled services' shutdown exactly once from the installed dispose", async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const served = installConversationReadinessInitialization(graph(shutdown));

    await served.dispose?.();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("drains detached summaries before disposing the assembled services", async () => {
    const order: string[] = [];
    const served = installConversationReadinessInitialization(
      graph(() => {
        order.push("services-disposed");
        return Promise.resolve();
      }),
    );
    const work = beginChatCompactionWork(served);
    if (work === undefined) throw new Error("Missing model work");
    work.signal.addEventListener("abort", () => {
      order.push("summary-cancelled");
      work.finish();
    });
    await served.dispose?.();
    expect(order).toEqual(["summary-cancelled", "services-disposed"]);
    expect(chatCompactionWorkStopped(served)).toBe(true);
  });
});
