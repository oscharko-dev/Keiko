import { describe, expect, it, vi } from "vitest";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { privateJiraCustodyFixture } from "../../../tests/support/jira-private-custody-fixture.js";
import { prepareJiraHumanInput } from "./jira-human-input-preparation.js";

const PASSWORD = ["synthetic", "held call", "input"].join(" ");
describe("existing held-call human information continuation", () => {
  it("publishes the pending view before waiting, returns the original bound revision and never claims a secret", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const views: JiraHumanInputView[] = [];
    const selected = await prepareJiraHumanInput(
      f.inputs,
      f.binding,
      (view) => {
        views.push(view);
        if (view.state === "awaiting-input")
          f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
      },
      new AbortController().signal,
      () => undefined,
    );
    expect(views.map((view) => view.state)).toEqual(["awaiting-input", "ready"]);
    expect(selected.binding).toEqual(f.binding);
    expect(f.inputs.inspect(selected.requestId, f.binding)).toMatchObject({
      state: "ready",
      revision: selected.revision,
    });
    expect(JSON.stringify(views)).not.toContain(PASSWORD);
    expect(f.privateInputs.claim(selected.requestId, selected.binding, selected.revision)).toEqual({
      password: PASSWORD,
    });
  });
  it("clears human values when the existing call is cancelled while its ready view is being persisted", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const abort = new AbortController();
    let id = "";
    await expect(
      prepareJiraHumanInput(
        f.inputs,
        f.binding,
        (view) => {
          id = view.requestId;
          if (view.state === "awaiting-input")
            f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
          else abort.abort();
        },
        abort.signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.inputs.inspect(id, f.binding)?.state).toBe("cancelled");
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
  });
  it.each([false, true])(
    "clears returned but unclaimed input immediately on the held call's abort (revoked=%s)",
    async (revoked) => {
      const f = privateJiraCustodyFixture("jira.login");
      const abort = new AbortController();
      const selected = await prepareJiraHumanInput(
        f.inputs,
        f.binding,
        (view) => {
          if (view.state === "awaiting-input")
            f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
        },
        abort.signal,
        () => undefined,
      );
      expect([...f.sealedPortEntries.values()].join("")).toContain(PASSWORD);
      if (revoked) f.custody.beginVerification(f.binding.authRef, 1);
      abort.abort();
      // Inspect/cancel/sweep could themselves erase the value and conceal a missing lifetime hook.
      expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
      expect(f.clearedPhases).toEqual(["cancelled"]);
      expect(f.inputs.cancelOwned(selected.requestId, f.binding.principalDigest)?.state).toBe(
        "cancelled",
      );
      expect(f.clearedPhases).toEqual(["cancelled"]);
    },
  );
  it.each(["before-wait", "while-waiting"])(
    "retains the existing expiry cleanup until unclaimed input ends (%s)",
    async (submission) => {
      vi.useFakeTimers();
      const f = privateJiraCustodyFixture("jira.login");
      const abort = new AbortController();
      let pending: JiraHumanInputView | undefined;
      try {
        const preparation = prepareJiraHumanInput(
          f.inputs,
          f.binding,
          (view) => {
            if (view.state !== "awaiting-input") return;
            pending = view;
            if (submission === "before-wait")
              f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
          },
          abort.signal,
          () => undefined,
        );
        await Promise.resolve();
        if (pending === undefined) throw new TypeError("Missing pending input fixture");
        if (submission === "while-waiting")
          f.inputs.submit(pending.requestId, f.binding, pending.revision, { password: PASSWORD });
        const selected = await preparation;
        expect([...f.sealedPortEntries.values()].join("")).toContain(PASSWORD);
        f.advance(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
        expect(f.clearedPhases).toEqual(["expired"]);
        expect(f.inputs.inspect(selected.requestId, f.binding)?.state).toBe("expired");
        abort.abort();
        expect(f.clearedPhases).toEqual(["expired"]);
      } finally {
        abort.abort();
        vi.useRealTimers();
      }
    },
  );
  it("does not cancel or recreate a consumed value when the held call later ends", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const abort = new AbortController();
    const selected = await prepareJiraHumanInput(
      f.inputs,
      f.binding,
      (view) => {
        if (view.state === "awaiting-input")
          f.inputs.submit(view.requestId, f.binding, view.revision, { password: PASSWORD });
      },
      abort.signal,
      () => undefined,
    );
    expect(f.privateInputs.claim(selected.requestId, selected.binding, selected.revision)).toEqual({
      password: PASSWORD,
    });
    abort.abort();
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
    expect(f.clearedPhases).toEqual([]);
    expect(f.inputs.inspect(selected.requestId, f.binding)?.state).toBe("consumed");
  });
  it("clears ready values when publication fails after the credential binding is revoked", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    let id = "";
    const failure = new TypeError("Synthetic view persistence failure");
    await expect(
      prepareJiraHumanInput(
        f.inputs,
        f.binding,
        (view) => {
          id = view.requestId;
          if (view.state === "awaiting-input")
            f.inputs.submit(id, f.binding, view.revision, { password: PASSWORD });
          else {
            f.custody.beginVerification(f.binding.authRef, 1);
            throw failure;
          }
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toBe(failure);
    expect(f.inputs.cancelOwned(id, f.binding.principalDigest)?.state).toBe("cancelled");
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(PASSWORD);
  });
  it("retains the original publication failure when cleanup fails and reports only through its cleanup observer", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const original = new TypeError("Synthetic original publication failure");
    const cleanup = new Error("Synthetic private storage unavailable");
    const failures: unknown[] = [];
    await expect(
      prepareJiraHumanInput(
        {
          ...f.inputs,
          cancel: () => {
            throw cleanup;
          },
        },
        f.binding,
        () => {
          throw original;
        },
        new AbortController().signal,
        (error) => {
          failures.push(error);
        },
      ),
    ).rejects.toBe(original);
    expect(failures).toEqual([cleanup]);
  });
  it("propagates the exact wait rejection while reporting a cleanup failure once", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const original = new TypeError("Synthetic wait failure");
    const cleanup = new Error("Synthetic sealed storage failure");
    const recorded: unknown[] = [];
    await expect(
      prepareJiraHumanInput(
        {
          ...f.inputs,
          wait: () => Promise.reject(original),
          cancel: () => {
            throw cleanup;
          },
        },
        f.binding,
        () => undefined,
        new AbortController().signal,
        (error) => {
          recorded.push(error);
        },
      ),
    ).rejects.toBe(original);
    expect(recorded).toEqual([cleanup]);
  });
});
