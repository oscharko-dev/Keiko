import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX,
  validateCodingWorkbenchRuntimeInboxChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { activityLogEventWillBeRejected } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createOpenCodeInboxRunPort, recordInboxAction, type InboxRun } from "./opencodeInbox.js";
import { openCodePromptInputs, type MintedNativeInput } from "./opencodePromptInputs.js";
import { OpenCodeV2HttpStatusError, type OpenCodeV2InboxEntry } from "./opencodeV2HttpClient.js";

const NATIVE = openCodePromptInputs("native");
const MAPPED = openCodePromptInputs("direct");
const SECRET_TEXT = "PRIVATE-OPERATOR-TEXT";

/** The id the runtime holds the nth message under. */
const id = (n: number): string => `msg_inbox_${String(n)}`;
const user = (n: number, delivery: "queue" | "steer"): OpenCodeV2InboxEntry => ({
  id: id(n),
  kind: "user",
  delivery,
});

interface Harness {
  readonly port: ReturnType<typeof createOpenCodeInboxRunPort>;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  /** The runtime's inbox right now; the harness removes an entry a call consumes. */
  entries: OpenCodeV2InboxEntry[];
  /** The ids of the session's newest messages: what reached the model. */
  recent: string[];
  /** Every call that reached the runtime, in order. */
  readonly calls: string[];
  /** What the next call of that name rejects with. */
  readonly failures: Map<string, Error>;
  /** The signals the runtime calls were made with. */
  readonly signals: (AbortSignal | undefined)[];
  /** What Keiko minted for the run: id to its preview and whether it withdrew it. */
  readonly minted: Map<string, { preview: string; withdrawn: boolean }>;
  inFlight: boolean;
}

function harness(
  options: {
    readonly capabilities?: typeof NATIVE;
    readonly missing?: boolean;
    /** Runs when the runtime is asked to withdraw an entry, before the harness removes it. */
    readonly onCancel?: (h: Harness, entryId: string) => void;
    /** Runs when the runtime is asked to change an entry, before the call can fail. */
    readonly onPromote?: (h: Harness, entryId: string) => void;
  } = {},
): Harness {
  const sink = createBufferedServerLogSink();
  const state: Harness = {
    port: undefined as never,
    sink,
    entries: [],
    recent: [],
    calls: [],
    failures: new Map(),
    signals: [],
    minted: new Map(),
    inFlight: true,
  };
  const attempt = (name: string, signal: AbortSignal | undefined): void => {
    state.calls.push(name);
    state.signals.push(signal);
    const failure = state.failures.get(name);
    if (failure !== undefined) {
      state.failures.delete(name);
      throw failure;
    }
  };
  const run: InboxRun = {
    runId: "run-1",
    sessionId: "ses_1",
    client: {
      inbox: (_session, signal) => {
        attempt("inbox", signal);
        return Promise.resolve([...state.entries]);
      },
      cancelInboxEntry: (_session, entryId, signal) => {
        attempt("cancel", signal);
        options.onCancel?.(state, entryId);
        state.entries = state.entries.filter((entry) => entry.id !== entryId);
        return Promise.resolve();
      },
      promoteInboxEntry: (_session, entryId, signal) => {
        options.onPromote?.(state, entryId);
        attempt("promote", signal);
        state.entries = state.entries.map((entry) =>
          entry.id === entryId ? { ...entry, delivery: "steer" } : entry,
        );
        return Promise.resolve();
      },
      recentMessageIds: (_session, signal) => {
        attempt("recent", signal);
        return Promise.resolve([...state.recent]);
      },
    },
    runtimeAdapter: { turnInFlight: () => state.inFlight },
  };
  const port = createOpenCodeInboxRunPort({
    readyRun: (runId) => (options.missing === true || runId !== "run-1" ? undefined : run),
    capabilities: options.capabilities ?? NATIVE,
    activityLog: sink,
    nativeInput: (runId, messageId): MintedNativeInput | undefined =>
      runId === "run-1" ? state.minted.get(messageId) : undefined,
    withdrawNativeInput: (runId, messageId): void => {
      const held = runId === "run-1" ? state.minted.get(messageId) : undefined;
      if (held !== undefined) held.withdrawn = true;
    },
  });
  return Object.assign(state, { port });
}

/** The ids Keiko minted for the run, with a preview each. */
function mint(h: Harness, ...ids: readonly number[]): void {
  for (const n of ids)
    h.minted.set(id(n), { preview: `${SECRET_TEXT} ${String(n)}`, withdrawn: false });
}

const lines = (h: Harness): unknown[] =>
  h.sink.events.map((event) => {
    const {
      completeness: _completeness,
      loss: _loss,
      ...extra
    } = (event as { extra: Record<string, unknown> }).extra;
    return extra;
  });

describe("listing the messages still waiting for the running turn", () => {
  it("lists the operator's own messages in the order the model will receive them", async () => {
    const h = harness();
    // The runtime lists in delivery order of arrival: a queued message may precede a steered one,
    // yet the steered one reaches the model first.
    h.entries = [user(1, "queue"), user(2, "steer"), user(3, "queue"), user(4, "steer")];
    mint(h, 1, 2, 3, 4);

    const items = await h.port.listInbox("run-1", "corr-0123456789");

    expect(items).toEqual([
      { itemId: id(2), delivery: "steer", preview: `${SECRET_TEXT} 2` },
      { itemId: id(4), delivery: "steer", preview: `${SECRET_TEXT} 4` },
      { itemId: id(1), delivery: "queue", preview: `${SECRET_TEXT} 1` },
      { itemId: id(3), delivery: "queue", preview: `${SECRET_TEXT} 3` },
    ]);
    expect(validateCodingWorkbenchRuntimeInboxChannelPayload({ session: "active", items }).ok).toBe(
      true,
    );
    expect(h.calls).toEqual(["inbox"]);
  });

  it("shows nothing the runtime queued on its own, nothing Keiko did not mint and nothing it withdrew", async () => {
    const h = harness();
    h.entries = [
      user(1, "queue"),
      { id: id(2), kind: "other", delivery: "steer" },
      user(3, "steer"),
      user(4, "queue"),
    ];
    mint(h, 1, 2, 4);
    const withdrawn = h.minted.get(id(4));
    if (withdrawn !== undefined) withdrawn.withdrawn = true;

    const items = await h.port.listInbox("run-1");

    expect(items?.map((item) => item.itemId)).toEqual([id(1)]);
    expect(lines(h)).toEqual([
      { runId: "run-1", action: "list", outcome: "listed", itemCount: 1, ignoredCount: 3 },
    ]);
  });

  it("lists an empty inbox as an empty list, not as an absent one", async () => {
    const h = harness();

    await expect(h.port.listInbox("run-1")).resolves.toEqual([]);

    expect(lines(h)).toEqual([
      { runId: "run-1", action: "list", outcome: "listed", itemCount: 0, ignoredCount: 0 },
    ]);
  });

  it("lists at most the bound the contract admits", async () => {
    const h = harness();
    const count = CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX + 5;
    h.entries = Array.from({ length: count }, (_, index) => user(index, "queue"));
    mint(h, ...h.entries.map((_, index) => index));

    const items = await h.port.listInbox("run-1");

    expect(items).toHaveLength(CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX);
    expect(lines(h)).toMatchObject([{ itemCount: 32, ignoredCount: 5 }]);
  });

  it("offers nothing on a profile that takes no delivery and never asks the runtime", async () => {
    const h = harness({ capabilities: MAPPED });

    await expect(h.port.listInbox("run-1")).resolves.toBeUndefined();

    expect(h.calls).toEqual([]);
    expect(lines(h)).toEqual([{ runId: "run-1", action: "list", outcome: "unsupported" }]);
    expect(h.sink.events[0]).toMatchObject({ level: "warn" });
  });

  it("offers nothing for a run that is not live or whose turn is not in flight", async () => {
    const missing = harness({ missing: true });
    const idle = harness();
    idle.inFlight = false;

    await expect(missing.port.listInbox("run-1")).resolves.toBeUndefined();
    await expect(idle.port.listInbox("run-1")).resolves.toBeUndefined();
    await expect(harness().port.listInbox("run-9")).resolves.toBeUndefined();

    expect(missing.calls).toEqual([]);
    expect(idle.calls).toEqual([]);
    expect(lines(missing)).toEqual([
      { runId: "run-1", action: "list", outcome: "run-unavailable" },
    ]);
    expect(lines(idle)).toEqual([{ runId: "run-1", action: "list", outcome: "turn-not-running" }]);
  });

  it("reports a listing the runtime could not give as a warning with the closed error kind, frames and causes", async () => {
    const h = harness();
    h.failures.set("inbox", new OpenCodeV2HttpStatusError(503));

    await expect(h.port.listInbox("run-1", "corr-0123456789")).resolves.toBeUndefined();

    expect(h.sink.events).toHaveLength(1);
    expect(h.sink.events[0]).toMatchObject({
      level: "warn",
      op: "coding-runtime.inbox.action",
      correlationId: "corr-0123456789",
      errorKind: expect.any(String) as unknown,
      extra: { runId: "run-1", action: "list", outcome: "failed" },
    });
    const extra = (h.sink.events[0] as { extra: Record<string, unknown> }).extra;
    expect(Array.isArray(extra.frames)).toBe(true);
    expect(Array.isArray(extra.causeChain)).toBe(true);
    expect(extra).not.toHaveProperty("itemCount");
  });

  it("joins a line to the run when the request carries no correlation of its own", () => {
    const sink = createBufferedServerLogSink();

    recordInboxAction(sink, "run-0123456789", {
      action: "list",
      outcome: "run-unavailable",
    });

    expect(sink.events).toMatchObject([{ correlationId: "run-0123456789" }]);
  });
});

describe("withdrawing a message that is still waiting", () => {
  it("withdraws it from the runtime, proves it did not reach the model and remembers the withdrawal", async () => {
    const h = harness();
    h.entries = [user(1, "queue"), user(2, "queue")];
    mint(h, 1, 2);
    h.recent = [id(0)];

    await expect(
      h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) }, "corr-0123456789"),
    ).resolves.toEqual({ ok: true, outcome: "cancelled" });

    expect(h.calls).toEqual(["inbox", "cancel", "recent"]);
    expect(h.entries.map((entry) => entry.id)).toEqual([id(2)]);
    expect(h.minted.get(id(1))?.withdrawn).toBe(true);
    expect(h.minted.get(id(2))?.withdrawn).toBe(false);
    expect(h.sink.events[0]).toMatchObject({
      level: "info",
      correlationId: "corr-0123456789",
    });
    expect(lines(h)).toEqual([{ runId: "run-1", action: "cancel", outcome: "cancelled" }]);
  });

  it("says a message the runtime already took was delivered, without touching the runtime", async () => {
    const h = harness();
    mint(h, 1);

    await expect(h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) })).resolves.toEqual({
      ok: true,
      outcome: "already-delivered",
    });

    expect(h.calls, "no withdrawal is sent for a message that is gone").toEqual(["inbox"]);
    expect(h.minted.get(id(1))?.withdrawn).toBe(false);
    expect(lines(h)).toEqual([{ runId: "run-1", action: "cancel", outcome: "already-delivered" }]);
    expect(h.sink.events[0]).toMatchObject({ level: "info" });
  });

  it("says a message it withdrew itself was cancelled, not delivered, when the action is repeated", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);
    await h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) });

    await expect(h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) })).resolves.toEqual({
      ok: true,
      outcome: "already-cancelled",
    });
    await expect(h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) })).resolves.toEqual(
      { ok: true, outcome: "already-cancelled" },
    );

    expect(h.calls.filter((call) => call === "cancel")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "promote")).toHaveLength(0);
  });

  // The runtime answers a withdrawal of an input it already took with the same 204 as one it removed:
  // the message is delivered in the instant between the read and the withdrawal.
  it("does not claim a withdrawal when the message reached the model in that instant", async () => {
    const h = harness({
      onCancel: (state, entryId) => {
        state.recent = [entryId, ...state.recent];
      },
    });
    h.entries = [user(1, "queue")];
    mint(h, 1);

    await expect(h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) })).resolves.toEqual({
      ok: true,
      outcome: "already-delivered",
    });

    expect(h.minted.get(id(1))?.withdrawn, "the message was not withdrawn").toBe(false);
    expect(lines(h)).toEqual([{ runId: "run-1", action: "cancel", outcome: "already-delivered" }]);
  });

  it("refuses an id Keiko did not mint for the run and asks the runtime nothing", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];

    await expect(h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) })).resolves.toEqual({
      ok: false,
      reason: "unknown-item",
    });
    await expect(h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) })).resolves.toEqual(
      { ok: false, reason: "unknown-item" },
    );

    expect(h.calls).toEqual([]);
    expect(h.entries).toHaveLength(1);
    expect(lines(h)).toEqual([
      { runId: "run-1", action: "cancel", outcome: "unknown-item" },
      { runId: "run-1", action: "promote", outcome: "unknown-item" },
    ]);
    expect(h.sink.events[0]).toMatchObject({ level: "warn" });
  });

  it("refuses on a profile without delivery, for an unknown run and with no turn in flight", async () => {
    const unsupported = harness({ capabilities: MAPPED });
    const missing = harness({ missing: true });
    const idle = harness();
    idle.inFlight = false;
    for (const h of [unsupported, missing, idle]) mint(h, 1);

    await expect(
      unsupported.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) }),
    ).resolves.toEqual({ ok: false, reason: "unsupported" });
    await expect(
      missing.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) }),
    ).resolves.toEqual({ ok: false, reason: "run-unavailable" });
    await expect(
      idle.port.actOnInbox("run-1", { action: "promote", itemId: id(1) }),
    ).resolves.toEqual({ ok: false, reason: "turn-not-running" });

    for (const h of [unsupported, missing, idle]) expect(h.calls).toEqual([]);
    expect(lines(idle)).toEqual([
      { runId: "run-1", action: "promote", outcome: "turn-not-running" },
    ]);
  });

  it("reports a withdrawal the runtime failed as a refusal and does not remember it as done", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);
    h.failures.set("cancel", new OpenCodeV2HttpStatusError(500));

    await expect(
      h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) }, "corr-0123456789"),
    ).resolves.toEqual({ ok: false, reason: "inbox-failed" });

    expect(h.minted.get(id(1))?.withdrawn).toBe(false);
    expect(h.sink.events[0]).toMatchObject({
      level: "warn",
      errorKind: expect.any(String) as unknown,
      extra: { runId: "run-1", action: "cancel", outcome: "failed" },
    });
  });

  it("does not remember a withdrawal as done when the message history could not prove it", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);
    h.failures.set("recent", new OpenCodeV2HttpStatusError(503));

    await expect(h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) })).resolves.toEqual({
      ok: false,
      reason: "inbox-failed",
    });

    expect(h.minted.get(id(1))?.withdrawn).toBe(false);
    expect(lines(h)).toEqual([
      expect.objectContaining({ action: "cancel", outcome: "failed" }) as unknown,
    ]);
  });
});

describe("promoting a queued message to be sent now", () => {
  it("changes the delivery to steer and keeps the message pending", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);

    await expect(h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) })).resolves.toEqual(
      { ok: true, outcome: "promoted" },
    );

    expect(h.calls).toEqual(["inbox", "promote"]);
    expect(h.entries).toEqual([user(1, "steer")]);
    expect(h.minted.get(id(1))?.withdrawn).toBe(false);
    expect(lines(h)).toEqual([{ runId: "run-1", action: "promote", outcome: "promoted" }]);
    await expect(h.port.listInbox("run-1")).resolves.toMatchObject([
      { itemId: id(1), delivery: "steer" },
    ]);
  });

  it("says a message the runtime took meanwhile was delivered when it answers the change with a conflict", async () => {
    // The runtime took the message between the read and the change.
    const h = harness({
      onPromote: (state) => {
        state.entries = [];
      },
    });
    h.entries = [user(1, "queue")];
    mint(h, 1);
    h.failures.set("promote", new OpenCodeV2HttpStatusError(409));

    await expect(h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) })).resolves.toEqual(
      { ok: true, outcome: "already-delivered" },
    );

    expect(lines(h)).toEqual([{ runId: "run-1", action: "promote", outcome: "already-delivered" }]);
  });

  it("believes a conflict only when the runtime no longer lists the message", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);
    h.failures.set("promote", new OpenCodeV2HttpStatusError(409));

    await expect(h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) })).resolves.toEqual(
      { ok: false, reason: "inbox-failed" },
    );

    expect(h.calls).toEqual(["inbox", "promote", "inbox"]);
    expect(lines(h)).toEqual([
      expect.objectContaining({ action: "promote", outcome: "failed" }) as unknown,
    ]);
  });

  it("reports any other failure of the change as a refusal", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);
    h.failures.set("promote", new OpenCodeV2HttpStatusError(500));

    await expect(h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) })).resolves.toEqual(
      { ok: false, reason: "inbox-failed" },
    );

    expect(h.calls, "a failure other than a conflict reads nothing more").toEqual([
      "inbox",
      "promote",
    ]);
  });
});

describe("withdrawing what is still pending when the turn is interrupted", () => {
  it("withdraws every message of the operator's, once, and records one line with the count", async () => {
    const h = harness();
    h.inFlight = false;
    h.entries = [
      user(1, "queue"),
      user(2, "steer"),
      { id: id(3), kind: "other", delivery: "steer" },
      user(4, "queue"),
      user(5, "queue"),
    ];
    mint(h, 1, 2, 3, 5);
    const done = h.minted.get(id(5));
    if (done !== undefined) done.withdrawn = true;
    const signal = AbortSignal.timeout(60_000);

    await h.port.withdrawPendingInbox("run-1", "corr-0123456789", signal);

    expect(h.entries.map((entry) => entry.id)).toEqual([id(3), id(4), id(5)]);
    expect(h.minted.get(id(1))?.withdrawn).toBe(true);
    expect(h.minted.get(id(2))?.withdrawn).toBe(true);
    expect(h.signals.every((held) => held === signal)).toBe(true);
    expect(lines(h)).toEqual([
      { runId: "run-1", action: "withdraw", outcome: "withdrawn", itemCount: 2 },
    ]);
    expect(h.sink.events[0]).toMatchObject({ level: "info", correlationId: "corr-0123456789" });
  });

  it("records nothing when nothing was pending, and asks nothing of a profile without delivery", async () => {
    const quiet = harness();
    const mapped = harness({ capabilities: MAPPED });
    const missing = harness({ missing: true });

    await quiet.port.withdrawPendingInbox("run-1");
    await mapped.port.withdrawPendingInbox("run-1");
    await missing.port.withdrawPendingInbox("run-1");

    expect(quiet.calls).toEqual(["inbox"]);
    expect(mapped.calls).toEqual([]);
    expect(missing.calls).toEqual([]);
    for (const h of [quiet, mapped, missing]) expect(h.sink.events).toEqual([]);
  });

  it("never throws: a failure is one warning with the closed error kind, frames and causes", async () => {
    const h = harness();
    h.entries = [user(1, "queue"), user(2, "queue")];
    mint(h, 1, 2);
    h.failures.set("cancel", new OpenCodeV2HttpStatusError(500));

    await expect(h.port.withdrawPendingInbox("run-1", "corr-0123456789")).resolves.toBeUndefined();

    expect(h.sink.events).toHaveLength(1);
    expect(h.sink.events[0]).toMatchObject({
      level: "warn",
      errorKind: expect.any(String) as unknown,
      extra: { runId: "run-1", action: "withdraw", outcome: "failed" },
    });
    const extra = (h.sink.events[0] as { extra: Record<string, unknown> }).extra;
    expect(Array.isArray(extra.frames)).toBe(true);
    expect(Array.isArray(extra.causeChain)).toBe(true);
  });
});

describe("the inbox evidence", () => {
  it("records counts and closed words, never a message, a preview or an id", async () => {
    const h = harness();
    h.entries = [user(1, "queue"), user(2, "steer")];
    mint(h, 1, 2);

    await h.port.listInbox("run-1");
    await h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) });
    await h.port.actOnInbox("run-1", { action: "cancel", itemId: id(2) });
    await h.port.actOnInbox("run-1", { action: "cancel", itemId: "msg_never_minted" });

    const written = JSON.stringify(h.sink.events);
    expect(written).not.toContain(SECRET_TEXT);
    expect(written).not.toMatch(/msg_/u);
    expect(h.sink.events.map((event) => (event as { op?: string }).op)).toEqual(
      Array.from({ length: 4 }, () => "coding-runtime.inbox.action"),
    );
  });

  it("emits only lines its own registration accepts", async () => {
    const h = harness();
    h.entries = [user(1, "queue")];
    mint(h, 1);
    h.failures.set("promote", new Error("boom"));
    await h.port.listInbox("run-1");
    await h.port.actOnInbox("run-1", { action: "promote", itemId: id(1) });
    await h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) });
    await h.port.actOnInbox("run-1", { action: "cancel", itemId: id(1) });
    await h.port.withdrawPendingInbox("run-1");
    await harness({ capabilities: MAPPED }).port.listInbox("run-1");

    expect(h.sink.events.length).toBeGreaterThan(3);
    for (const event of h.sink.events) {
      expect(activityLogEventWillBeRejected(event)).toBe(false);
    }
  });

  // Needs the regenerated Activity Log registry (`npm run generate:op-catalog`), which carries the
  // typed registration this operation declares.
  it("is a registered, persistable line: the production formatter accepts exactly its fields", async () => {
    const ok = harness();
    ok.entries = [user(1, "queue")];
    mint(ok, 1);
    await ok.port.listInbox("run-1", "corr-0123456789");
    const failed = harness();
    failed.failures.set("inbox", new Error("boom"));
    await failed.port.listInbox("run-1", "corr-0123456789");
    const refused = harness();
    await refused.port.actOnInbox(
      "run-1",
      { action: "cancel", itemId: "msg_never_minted" },
      "corr-0123456789",
    );

    const written = [...ok.sink.events, ...failed.sink.events, ...refused.sink.events].map(
      (event) =>
        expectActivityLogProof(
          "coding-runtime.inbox.action.emitted-line",
          formatActivityLogProofLine(event),
        ),
    );

    expect(written).toMatchObject([
      { runId: "run-1", action: "list", outcome: "listed", itemCount: 1, ignoredCount: 0 },
      { runId: "run-1", action: "list", outcome: "failed" },
      { runId: "run-1", action: "cancel", outcome: "unknown-item" },
    ]);
  });
});
