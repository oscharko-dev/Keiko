// #3610: a governed ask ends in exactly one closed outcome. Before this, the registry answered a
// bare boolean, so the tool facade route could not tell a denied or expired human decision from a
// browser-origin refusal and logged every one of them as `origin-not-allowed`.
// #3612: the ask names its tool call and, for an edit, the changeset's base digests. The decision
// carries the call it belongs to, and a stale base is refused before any human is asked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { createBufferedServerLogSink, type ServerLogEvent } from "../observability/server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { capturedGeneratedV2Ask } from "./opencodeFunctionalHarness/_governedTools.js";
import type { CodingToolEditBaseRead } from "./codingToolFacadePorts.js";
import {
  createOpenCodeV2ApprovalRequests,
  type OpenCodeV2EditBaseDigest,
} from "./opencodeV2ApprovalRequests.js";

const RUN_ID = "run-approval";
const SESSION_ID = "ses_approval";
const BASE = "a".repeat(64);
const PATCH = "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n";

function editArgs(
  files: readonly Record<string, unknown>[] = [
    { file: "src/example.ts", expectedContentHash: BASE },
  ],
): Record<string, unknown> {
  return { changeset: { patch: PATCH, files } };
}

// The ask exactly as the generated V2 plugin sends it for one keiko_changeset_edit call.
function editAsk(callId = "call_1", args = editArgs()): Promise<Record<string, unknown>> {
  return capturedGeneratedV2Ask({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    callId,
    tool: "keiko_changeset_edit",
    args,
  });
}

function verificationAsk(callId: string): Promise<Record<string, unknown>> {
  return capturedGeneratedV2Ask({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    callId,
    tool: "keiko_verification",
    args: { verifierId: "test", targetPath: "" },
  });
}

interface Asked {
  readonly events: SidecarPermissionEvent[];
  readonly onPermission: (event: SidecarPermissionEvent) => void;
}

function asked(): Asked {
  const events: SidecarPermissionEvent[] = [];
  return {
    events,
    onPermission: (event): void => {
      events.push(event);
    },
  };
}

function requestIdOf(ask: Asked, index = 0): string {
  const requestId = ask.events[index]?.requestId;
  if (requestId === undefined) throw new Error("the ask never reached the human");
  return requestId;
}

function digestOf(digest: string): Promise<CodingToolEditBaseRead> {
  return Promise.resolve({ kind: "digest", digest });
}

function digestPort(
  digests: Readonly<Record<string, string | undefined>>,
): OpenCodeV2EditBaseDigest {
  return (relativePath) => {
    const digest = digests[relativePath];
    return digest === undefined ? Promise.resolve({ kind: "unreadable" }) : digestOf(digest);
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCode V2 approval requests", () => {
  it.each([
    [true, "approved"],
    [false, "denied"],
  ] as const)(
    "settles a human decision of %s as %s, for the asked call",
    async (approved, outcome) => {
      const approvals = createOpenCodeV2ApprovalRequests();
      const ask = asked();
      const decision = approvals.request({
        value: await editAsk(),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
      });
      expect(approvals.resolve(RUN_ID, requestIdOf(ask), approved)).toBe(true);
      await expect(decision).resolves.toEqual({ outcome, actionId: `${SESSION_ID}:call_1` });
      // Settled once: a second reply for the same ask finds nothing pending.
      expect(approvals.resolve(RUN_ID, requestIdOf(ask), approved)).toBe(false);
    },
  );

  it("expires an unanswered ask after the one human-decision wait", async () => {
    const value = await editAsk();
    vi.useFakeTimers();
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = approvals.request({
      value,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
    await expect(decision).resolves.toMatchObject({ outcome: "expired" });
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), true)).toBe(false);
  });

  it("cancels a pending ask when its caller goes away or the run closes", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const controller = new AbortController();
    const aborted = approvals.request({
      value: await editAsk("call_abort"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: asked().onPermission,
      signal: controller.signal,
    });
    const closed = approvals.request({
      value: await editAsk("call_close"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: asked().onPermission,
      signal: new AbortController().signal,
    });
    controller.abort();
    approvals.close();
    await expect(aborted).resolves.toEqual({
      outcome: "cancelled",
      actionId: `${SESSION_ID}:call_abort`,
    });
    await expect(closed).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("answers an ask it cannot put to the human as unavailable, and an aborted one as cancelled", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const signal = new AbortController().signal;
    const onPermission = asked().onPermission;
    await expect(
      approvals.request({
        value: { action: "read" },
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal,
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
    const twice = await editAsk("call_twice");
    const pending = approvals.request({
      value: twice,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission,
      signal,
    });
    await expect(
      approvals.request({
        value: twice,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });
    await expect(
      approvals.request({
        value: await editAsk("call_late"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toMatchObject({ outcome: "cancelled" });
    approvals.close();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
  });

  // #3611 review: at most 64 asks wait at once. The 65th is refused as unavailable, and settling one
  // frees its slot again.
  it("refuses an ask beyond the 64 pending ones and admits one again after a settlement", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const signal = new AbortController().signal;
    const ask = asked();
    const values = await Promise.all(
      Array.from({ length: 66 }, (_unused, index) => editAsk(`call_capacity_${String(index)}`)),
    );
    const pending = values.slice(0, 64).map((value) =>
      approvals.request({
        value,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal,
      }),
    );
    await expect(
      approvals.request({
        value: values[64],
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });

    expect(approvals.resolve(RUN_ID, requestIdOf(ask), false)).toBe(true);
    await expect(pending[0]).resolves.toMatchObject({ outcome: "denied" });
    const admitted = approvals.request({
      value: values[65],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal,
    });
    expect(ask.events).toHaveLength(65);
    approvals.close();
    await expect(admitted).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("answers an ask whose delivery to the human failed as unavailable", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    await expect(
      approvals.request({
        value: await editAsk(),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: (): void => {
          throw new Error("event hub closed");
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });
  });

  it("sends the tool call's own identity and one base digest per changed file (#3612)", async () => {
    const value = await editAsk(
      "call_bases",
      editArgs([
        { file: "src/example.ts", expectedContentHash: BASE },
        { file: "src/other.ts", expectedContentHash: "b".repeat(64) },
      ]),
    );
    expect(value).toMatchObject({
      action: "permission-request",
      runId: RUN_ID,
      actionId: `${SESSION_ID}:call_bases`,
      baseDigests: [
        { file: "src/example.ts", expectedContentHash: BASE },
        { file: "src/other.ts", expectedContentHash: "b".repeat(64) },
      ],
    });
    // A verification ask names its call too, but carries no changeset base.
    const verification = await verificationAsk("call_verify");
    expect(verification).toMatchObject({ actionId: `${SESSION_ID}:call_verify` });
    expect(verification).not.toHaveProperty("baseDigests");
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = approvals.request({
      value: verification,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), true)).toBe(true);
    await expect(decision).resolves.toEqual({
      outcome: "approved",
      actionId: `${SESSION_ID}:call_verify`,
    });
  });

  // Fail closed: an ask that does not name its own call, or whose bases do not match the files the
  // human would be asked about, never reaches the human.
  type Ask = Record<string, unknown>;
  const withBases = (ask: Ask, baseDigests: unknown): Ask => ({ ...ask, baseDigests });
  const REFUSED_ASKS: readonly (readonly [string, (ask: Ask) => Ask])[] = [
    [
      "an actionId that does not hash to the ask id",
      (ask): Ask => ({ ...ask, actionId: `${SESSION_ID}:call_other` }),
    ],
    ["an actionId of another session", (ask): Ask => ({ ...ask, actionId: "ses_other:call_1" })],
    ["an ask without an actionId", ({ actionId: _dropped, ...ask }: Ask): Ask => ask],
    ["an edit without base digests", ({ baseDigests: _dropped, ...ask }: Ask): Ask => ask],
    ["an unknown extra field", (ask): Ask => ({ ...ask, extra: true })],
    [
      "a base for another file",
      (ask): Ask => withBases(ask, [{ file: "src/other.ts", expectedContentHash: BASE }]),
    ],
    [
      "a malformed base digest",
      (ask): Ask =>
        withBases(ask, [{ file: "src/example.ts", expectedContentHash: "A".repeat(64) }]),
    ],
    [
      "a base with an extra key",
      (ask): Ask =>
        withBases(ask, [{ file: "src/example.ts", expectedContentHash: BASE, extra: 1 }]),
    ],
    ["an empty base list", (ask): Ask => withBases(ask, [])],
    ["a base list that is not an array", (ask): Ask => withBases(ask, {})],
    ["a base that is not an object", (ask): Ask => withBases(ask, ["src/example.ts"])],
  ];
  it.each(REFUSED_ASKS)(
    "refuses %s as unavailable without asking the human",
    async (_name, mutate) => {
      const approvals = createOpenCodeV2ApprovalRequests();
      const ask = asked();
      await expect(
        approvals.request({
          value: mutate(await editAsk()),
          runId: RUN_ID,
          sessionId: SESSION_ID,
          onPermission: ask.onPermission,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ outcome: "unavailable" });
      expect(ask.events).toEqual([]);
    },
  );

  it("refuses base digests on an ask that is not an edit", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const value = {
      ...(await verificationAsk("call_verify_bases")),
      baseDigests: [{ file: "src/example.ts", expectedContentHash: BASE }],
    };
    await expect(
      approvals.request({
        value,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(ask.events).toEqual([]);
  });

  it("refuses a stale base without asking the human, and names the stale file (#3612)", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const checked: string[] = [];
    await expect(
      approvals.request({
        value: await editAsk(
          "call_stale",
          editArgs([
            { file: "src/example.ts", expectedContentHash: BASE },
            { file: "src/other.ts", expectedContentHash: BASE },
          ]),
        ),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest: (relativePath) => {
          checked.push(relativePath);
          return digestOf(relativePath === "src/other.ts" ? "c".repeat(64) : BASE);
        },
      }),
    ).resolves.toEqual({
      outcome: "stale",
      actionId: `${SESSION_ID}:call_stale`,
      staleFile: "src/other.ts",
    });
    expect(checked).toEqual(["src/example.ts", "src/other.ts"]);
    expect(ask.events).toEqual([]);
  });

  it("asks the human when every base is current, or cannot be read (a new file)", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const current = approvals.request({
      value: await editAsk(
        "call_current",
        editArgs([
          { file: "src/example.ts", expectedContentHash: BASE },
          { file: "src/new.ts", expectedContentHash: "d".repeat(64) },
        ]),
      ),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
      editBaseDigest: digestPort({ "src/example.ts": BASE, "src/new.ts": undefined }),
    });
    await vi.waitFor(() => {
      expect(ask.events).toHaveLength(1);
    });
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), true)).toBe(true);
    await expect(current).resolves.toMatchObject({ outcome: "approved" });
  });

  it("fails the ask closed, with a diagnostic, when the base check itself fails", async () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const approvals = createOpenCodeV2ApprovalRequests({
      record: (record): void => {
        diagnostics.push(record);
      },
    });
    const ask = asked();
    await expect(
      approvals.request({
        value: await editAsk("call_check_failed"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest: () => Promise.reject(new Error("secure read unavailable")),
      }),
    ).resolves.toEqual({ outcome: "unavailable", actionId: `${SESSION_ID}:call_check_failed` });
    expect(ask.events).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        correlationId: RUN_ID,
        operation: "coding-runtime.opencode-composition",
        errorClass: "Error",
        code: "stage=permission-base-check",
      }),
    ]);
  });

  // PR #3617 review: every base check leaves one run-correlated line, so each stale edit, and each
  // check that let an ask through, is attributable from the log alone: the ask's request id, how
  // many asked files the read could answer for, and the stale file only as a digest.
  it("logs each base check outcome under the run's correlation", async () => {
    const log = createBufferedServerLogSink();
    const approvals = createOpenCodeV2ApprovalRequests(undefined, log);
    const ask = asked();
    const request = async (
      callId: string,
      files: readonly Record<string, unknown>[],
      editBaseDigest: OpenCodeV2EditBaseDigest,
    ): Promise<unknown> =>
      approvals.request({
        value: await editAsk(callId, editArgs(files)),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest,
      });
    const twoFiles = (second: string): readonly Record<string, unknown>[] => [
      { file: "src/example.ts", expectedContentHash: BASE },
      { file: second, expectedContentHash: BASE },
    ];
    const newer = digestPort({ "src/example.ts": BASE, "src/a.ts": "c".repeat(64) });
    const newerB = digestPort({ "src/example.ts": BASE, "src/b.ts": "c".repeat(64) });

    await request("call_stale_a", twoFiles("src/a.ts"), newer);
    await request("call_stale_b", twoFiles("src/b.ts"), newerB);
    await request("call_failed", twoFiles("src/a.ts"), () => Promise.reject(new Error("read")));
    const current = request(
      "call_current",
      twoFiles("src/new.ts"),
      digestPort({ "src/example.ts": BASE }),
    );
    await vi.waitFor(() => {
      expect(ask.events).toHaveLength(1);
    });
    approvals.resolve(RUN_ID, requestIdOf(ask), true);
    await current;

    const lines = log.events.filter(
      (event): event is ServerLogEvent => event.op === "coding-runtime.approval.base-checked",
    );
    expect(lines.map((line) => [line.level, line.errorKind, line.extra?.outcome])).toEqual([
      ["warn", "conflict", "stale"],
      ["warn", "conflict", "stale"],
      ["warn", "internal", "failed"],
      // No level: the sink writes it at its default, info.
      [undefined, undefined, "current"],
    ]);
    for (const line of lines) {
      expect(line.correlationId).toBe(RUN_ID);
      expect(line.extra).toMatchObject({
        runId: RUN_ID,
        requestId: expect.any(String) as unknown,
        fileCount: 2,
      });
    }
    expect(lines.map((line) => line.extra?.checkedFileCount)).toEqual([2, 2, 0, 1]);
    // The line joins the approval the human saw, and each ask has its own.
    expect(lines[3]?.extra?.requestId).toBe(requestIdOf(ask));
    expect(new Set(lines.map((line) => line.extra?.requestId)).size).toBe(4);
    const [staleA, staleB] = lines.map((line) => line.extra?.staleFileSha256);
    expect(staleA).toMatch(/^[a-f0-9]{64}$/u);
    expect(staleB).toMatch(/^[a-f0-9]{64}$/u);
    expect(staleA).not.toBe(staleB);
    expect(lines[2]?.extra).not.toHaveProperty("staleFileSha256");
    expect(JSON.stringify(lines)).not.toContain("src/a.ts");
    expectActivityLogProof(
      "coding-runtime.approval.base-checked.emitted-line",
      formatActivityLogProofLine(lines[0] ?? {}),
    );
  });

  // PR #3617 review: a run whose live authority no longer admits the read puts no ask to the human
  // unverified; a check that throws says how far it got; a check the registry's closing ended
  // records the teardown, not a verdict.
  it("refuses an ask the run's authority no longer admits, and logs how each check ended", async () => {
    const log = createBufferedServerLogSink();
    const approvals = createOpenCodeV2ApprovalRequests(undefined, log);
    const ask = asked();
    const request = async (
      callId: string,
      editBaseDigest: OpenCodeV2EditBaseDigest,
    ): Promise<unknown> =>
      approvals.request({
        value: await editAsk(
          callId,
          editArgs([
            { file: "src/example.ts", expectedContentHash: BASE },
            { file: "src/other.ts", expectedContentHash: BASE },
          ]),
        ),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest,
      });

    await expect(
      request("call_denied", (path) =>
        path === "src/example.ts" ? digestOf(BASE) : Promise.resolve({ kind: "authority-denied" }),
      ),
    ).resolves.toEqual({ outcome: "authority-denied", actionId: `${SESSION_ID}:call_denied` });
    await request("call_throws", (path) =>
      path === "src/example.ts" ? digestOf(BASE) : Promise.reject(new Error("secure read")),
    );
    await expect(
      // The registry closes during the first read, whose digest is stale: the teardown wins.
      request("call_closed", () => {
        approvals.close();
        return digestOf("c".repeat(64));
      }),
    ).resolves.toEqual({ outcome: "cancelled", actionId: `${SESSION_ID}:call_closed` });
    expect(ask.events).toEqual([]);

    const lines = log.events.filter((event) => event.op === "coding-runtime.approval.base-checked");
    expect(
      lines.map((line) => [line.errorKind, line.extra?.outcome, line.extra?.checkedFileCount]),
    ).toEqual([
      ["authority-denied", "denied", 1],
      ["internal", "failed", 1],
      [undefined, "cancelled", 1],
    ]);
    expect(lines[2]?.extra).not.toHaveProperty("staleFileSha256");
  });

  // PR #3617 review: teardown that closes the registry after the check returned, but before the ask
  // resumes, still puts it to no one; a read that rejects because of the teardown is cancelled.
  it("cancels an ask that teardown ended after its check or through a rejected read", async () => {
    const approvals = createOpenCodeV2ApprovalRequests(undefined, {
      write: (event): void => {
        if (event.op === "coding-runtime.approval.base-checked") approvals.close();
      },
    });
    const ask = asked();
    await expect(
      approvals.request({
        value: await editAsk("call_after_check"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest: digestPort({ "src/example.ts": BASE }),
      }),
    ).resolves.toEqual({ outcome: "cancelled", actionId: `${SESSION_ID}:call_after_check` });
    expect(ask.events).toEqual([]);

    const log = createBufferedServerLogSink();
    const teardown = createOpenCodeV2ApprovalRequests(undefined, log);
    await expect(
      teardown.request({
        value: await editAsk("call_rejected_read"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest: () => {
          teardown.close();
          return Promise.reject(new Error("read aborted by teardown"));
        },
      }),
    ).resolves.toEqual({ outcome: "cancelled", actionId: `${SESSION_ID}:call_rejected_read` });
    expect(
      log.events
        .filter((event) => event.op === "coding-runtime.approval.base-checked")
        .map((event) => event.extra?.outcome),
    ).toEqual(["cancelled"]);
    expect(ask.events).toEqual([]);
  });

  // PR #3617 review: a registry closed while an edit's base is read, its run disposed, puts the ask
  // to no one, and a closed registry cancels any later ask at once.
  it("asks no one once the registry closed during or before the base check", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    await expect(
      approvals.request({
        value: await editAsk("call_closing"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
        editBaseDigest: () => {
          approvals.close();
          return digestOf(BASE);
        },
      }),
    ).resolves.toEqual({ outcome: "cancelled", actionId: `${SESSION_ID}:call_closing` });
    await expect(
      approvals.request({
        value: await verificationAsk("call_after_close"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ outcome: "cancelled", actionId: `${SESSION_ID}:call_after_close` });
    expect(ask.events).toEqual([]);
  });

  it("cancels an ask whose caller goes away during the base check", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const controller = new AbortController();
    await expect(
      approvals.request({
        value: await editAsk("call_gone"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: controller.signal,
        editBaseDigest: () => {
          controller.abort();
          return digestOf(BASE);
        },
      }),
    ).resolves.toEqual({ outcome: "cancelled", actionId: `${SESSION_ID}:call_gone` });
    expect(ask.events).toEqual([]);
  });
});
