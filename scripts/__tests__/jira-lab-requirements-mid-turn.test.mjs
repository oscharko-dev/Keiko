// The lab's mid-turn action starts exactly when the stored transcript reaches its anchor (S17).
import { describe, expect, it } from "vitest";
import { startDuring } from "../testing/jira-chat-lab/requirements/mid-turn.mjs";
import { canonicalToolId } from "../testing/jira-chat-lab/requirements/tool-exchanges.mjs";

const exchange = (operation, status) => ({
  call: { id: "call", name: operation.replace(".", "_"), arguments: {} },
  result: { toolRef: { canonicalId: canonicalToolId(operation) }, status, data: {} },
});
const idle = () => false;

describe("startDuring", () => {
  it("waits for an exchange before it starts a first-exchange action", async () => {
    let runs = 0;
    const during = {
      when: "first-exchange",
      run: () => {
        runs += 1;
        return Promise.resolve();
      },
    };
    expect(startDuring(during, [], idle)).toBeUndefined();
    expect(runs).toBe(0);
    const started = startDuring(during, [exchange("jira.search", "completed")], idle);
    await expect(started).resolves.toEqual({ ok: true, startedOpen: true, turnOpen: true });
    expect(runs).toBe(1);
  });

  it("starts a first-write action only after a completed Jira write", () => {
    const during = { when: "first-write", run: () => Promise.resolve() };
    expect(startDuring(during, [exchange("jira.search", "completed")], idle)).toBeUndefined();
    expect(startDuring(during, [exchange("jira.create", "failed")], idle)).toBeUndefined();
    expect(startDuring(during, [exchange("jira.create", "completed")], idle)).toBeDefined();
    expect(startDuring(during, [exchange("jira.draft", "completed")], idle)).toBeDefined();
  });

  it("tells a turn that settled during the action from one that had settled before it", async () => {
    let settled = false;
    const during = {
      when: "first-write",
      run: () => {
        settled = true;
        return Promise.resolve();
      },
    };
    await expect(
      startDuring(during, [exchange("jira.draft", "completed")], () => settled),
    ).resolves.toEqual({ ok: true, startedOpen: true, turnOpen: false });
    await expect(
      startDuring(during, [exchange("jira.draft", "completed")], () => settled),
    ).resolves.toEqual({ ok: true, startedOpen: false, turnOpen: false });
  });

  it("does nothing without an action", () => {
    expect(startDuring(undefined, [exchange("jira.create", "completed")], idle)).toBeUndefined();
  });

  it("records a failed action with a bounded message and whether the turn was still open", async () => {
    const during = {
      when: "first-exchange",
      run: () => Promise.reject(new Error("x".repeat(500))),
    };
    const exchanges = [exchange("jira.search", "completed")];
    const open = await startDuring(during, exchanges, idle);
    expect(open).toMatchObject({ ok: false, turnOpen: true });
    expect(open.error).toHaveLength(200);
    expect(await startDuring(during, exchanges, () => true)).toMatchObject({ turnOpen: false });
  });
});
