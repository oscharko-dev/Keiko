import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_COMMANDS_MAX,
  validateCodingWorkbenchRuntimeCommandsChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { activityLogEventWillBeRejected } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  OPENCODE_COMMAND_PRESENTATION_MAX,
  commandDisplayText,
  createOpenCodeCommandPresentation,
  createOpenCodeCommandsRunPort,
  projectCommands,
  recordCommandsListed,
  type CommandsRun,
} from "./opencodeCommands.js";
import { openCodePromptInputs, type AdmittedPromptInputs } from "./opencodePromptInputs.js";
import { OpenCodeV2HttpStatusError, type OpenCodeV2Command } from "./opencodeV2HttpClient.js";

const NATIVE = openCodePromptInputs("native");
const MAPPED = openCodePromptInputs("direct");
const LISTING: readonly OpenCodeV2Command[] = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
];

interface Harness {
  readonly port: ReturnType<typeof createOpenCodeCommandsRunPort>;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  /** How many listings were requested of the runtime. */
  readonly reads: { count: number };
}

function harness(
  options: {
    readonly capabilities?: typeof NATIVE;
    readonly missing?: boolean;
    readonly listing?: () => Promise<readonly OpenCodeV2Command[]>;
  } = {},
): Harness {
  const sink = createBufferedServerLogSink();
  const reads = { count: 0 };
  const run: CommandsRun = {
    runId: "run-1",
    client: {
      commands: () => {
        reads.count += 1;
        return (
          options.listing ?? ((): Promise<readonly OpenCodeV2Command[]> => Promise.resolve(LISTING))
        )();
      },
    },
  };
  return {
    port: createOpenCodeCommandsRunPort({
      readyRun: (runId) => (options.missing === true || runId !== "run-1" ? undefined : run),
      capabilities: options.capabilities ?? NATIVE,
      activityLog: sink,
    }),
    sink,
    reads,
  };
}

/** The evidence of each line; the sink stamps `completeness` and `loss` on every one. */
const lines = (h: Harness): unknown[] =>
  h.sink.events.map((event) => {
    const {
      completeness: _completeness,
      loss: _loss,
      ...extra
    } = (event as { extra: Record<string, unknown> }).extra;
    return extra;
  });

function admitted(name: string, argumentBytes = 0): AdmittedPromptInputs {
  return {
    referenceCount: 0,
    files: [],
    fileBytes: 0,
    command: { name, argumentBytes },
    correlationId: "corr-0123456789",
    requestId: "req-1",
  };
}

describe("the projection of a runtime's command listing for the browser", () => {
  it("keeps names and descriptions the browser contract accepts, in the runtime's order", () => {
    const projection = projectCommands(LISTING);

    expect(projection).toEqual({ commands: LISTING, skippedCount: 0 });
    expect(
      validateCodingWorkbenchRuntimeCommandsChannelPayload({
        session: "active",
        commands: projection.commands,
      }).ok,
    ).toBe(true);
  });

  it("keeps the name of an entry whose description the contract refuses, and drops an unusable name", () => {
    const projection = projectCommands([
      { name: "bidi", description: "looks fine \u202eevil" },
      { name: "zero", description: "zero\u200bwidth" },
      { name: "bad name", description: "x" },
      { name: "", description: "x" },
      { name: "ok", description: "fine" },
    ]);

    expect(projection.commands).toEqual([
      { name: "bidi" },
      { name: "zero" },
      { name: "ok", description: "fine" },
    ]);
    expect(projection.skippedCount).toBe(2);
    expect(
      validateCodingWorkbenchRuntimeCommandsChannelPayload({
        session: "active",
        commands: projection.commands,
      }).ok,
    ).toBe(true);
  });

  it("lists a repeated name once and stops at the contract's bound, counting what it left out", () => {
    const many = Array.from({ length: CODING_WORKBENCH_COMMANDS_MAX + 5 }, (_, index) => ({
      name: `command-${String(index)}`,
    }));

    const projection = projectCommands([{ name: "init" }, { name: "init" }, ...many]);

    expect(projection.commands).toHaveLength(CODING_WORKBENCH_COMMANDS_MAX);
    expect(projection.commands[0]).toEqual({ name: "init" });
    expect(projection.skippedCount).toBe(1 + 5 + 1);
  });
});

describe("listing a run's commands", () => {
  it("lists what the runtime reports and records the counts alone", async () => {
    const h = harness({
      listing: () => Promise.resolve([...LISTING, { name: "two words" }, { name: "init" }]),
    });

    await expect(h.port.listCommands("run-1", "corr-0123456789")).resolves.toEqual(LISTING);

    expect(lines(h)).toEqual([
      { runId: "run-1", outcome: "listed", commandCount: 2, skippedCount: 2 },
    ]);
    expect(h.sink.events[0]).toMatchObject({
      level: "info",
      op: "coding-runtime.commands.listed",
      correlationId: "corr-0123456789",
    });
    expect(JSON.stringify(h.sink.events)).not.toMatch(/AGENTS|uncommitted|two words/u);
  });

  it("offers nothing on a profile without commands and never asks the runtime", async () => {
    const h = harness({ capabilities: MAPPED });

    await expect(h.port.listCommands("run-1")).resolves.toBeUndefined();

    expect(h.reads.count).toBe(0);
    expect(lines(h)).toEqual([{ runId: "run-1", outcome: "unsupported" }]);
  });

  it("joins a listing to the run when the request carries no correlation of its own", () => {
    const sink = createBufferedServerLogSink();

    recordCommandsListed(sink, "run-0123456789", { outcome: "unavailable" });

    expect(sink.events).toMatchObject([{ correlationId: "run-0123456789" }]);
  });

  it("offers nothing for a run that is not live", async () => {
    const h = harness({ missing: true });

    await expect(h.port.listCommands("run-1")).resolves.toBeUndefined();
    await expect(harness().port.listCommands("run-9")).resolves.toBeUndefined();

    expect(h.reads.count).toBe(0);
    expect(lines(h)).toEqual([{ runId: "run-1", outcome: "unavailable" }]);
  });

  it("reports a failed listing as a warning with the closed error kind, frames and causes", async () => {
    const h = harness({ listing: () => Promise.reject(new OpenCodeV2HttpStatusError(503)) });

    await expect(h.port.listCommands("run-1", "corr-0123456789")).resolves.toBeUndefined();

    expect(h.sink.events).toHaveLength(1);
    expect(h.sink.events[0]).toMatchObject({
      level: "warn",
      op: "coding-runtime.commands.listed",
      correlationId: "corr-0123456789",
      errorKind: expect.any(String) as unknown,
      extra: { runId: "run-1", outcome: "failed" },
    });
    const extra = (h.sink.events[0] as { extra: Record<string, unknown> }).extra;
    expect(Array.isArray(extra.frames)).toBe(true);
    expect(Array.isArray(extra.causeChain)).toBe(true);
    expect(extra).not.toHaveProperty("commandCount");
  });

  it("emits only lines its own registration accepts", async () => {
    const h = harness({ listing: () => Promise.reject(new Error("boom")) });
    await h.port.listCommands("run-1");
    await harness({ capabilities: MAPPED }).port.listCommands("run-1");
    const ok = harness();
    await ok.port.listCommands("run-1");

    for (const event of [...h.sink.events, ...ok.sink.events]) {
      expect(activityLogEventWillBeRejected(event)).toBe(false);
    }
  });

  // Needs the regenerated Activity Log registry (`npm run generate:op-catalog`), which carries the
  // typed registration this operation declares.
  it("is a registered, persistable line: the production formatter accepts exactly its fields", async () => {
    const ok = harness();
    await ok.port.listCommands("run-1", "corr-0123456789");
    const failed = harness({ listing: () => Promise.reject(new Error("boom")) });
    await failed.port.listCommands("run-1", "corr-0123456789");

    const written = [...ok.sink.events, ...failed.sink.events].map((event) =>
      expectActivityLogProof(
        "coding-runtime.commands.listed.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );

    expect(written).toMatchObject([
      { runId: "run-1", outcome: "listed", commandCount: 2, skippedCount: 0 },
      { runId: "run-1", outcome: "failed" },
    ]);
  });
});

describe("confirming the command a turn names", () => {
  it("passes a turn that names none, asking the runtime nothing", async () => {
    const h = harness();
    const inputs: AdmittedPromptInputs = { referenceCount: 0, files: [], fileBytes: 0 };

    await expect(h.port.admitCommand("run-1", inputs)).resolves.toEqual({ ok: true, inputs });

    expect(h.reads.count).toBe(0);
    expect(h.sink.events).toHaveLength(0);
  });

  it("admits a command the runtime lists", async () => {
    const h = harness();
    const inputs = admitted("review", 12);

    await expect(h.port.admitCommand("run-1", inputs)).resolves.toEqual({ ok: true, inputs });

    expect(h.reads.count).toBe(1);
    expect(h.sink.events).toHaveLength(0);
  });

  it.each([
    ["a command the runtime does not list", "nope", "command-unknown"],
    ["a name that only resembles a listed one", "Review", "command-unknown"],
    ["a listed name as a prefix", "revie", "command-unknown"],
  ] as const)("refuses %s with a closed reason and no name", async (_name, name, reason) => {
    const h = harness();

    await expect(h.port.admitCommand("run-1", admitted(name, 3))).resolves.toEqual({
      ok: false,
      reason,
    });

    expect(lines(h)).toEqual([
      {
        runId: "run-1",
        outcome: "refused",
        delivery: "none",
        referenceCount: 0,
        requestId: "req-1",
        command: "other",
        commandDigest: createHash("sha256").update(name, "utf8").digest("hex"),
        commandArgumentBytes: 3,
        reason,
      },
    ]);
    expect(JSON.stringify(h.sink.events)).not.toContain(name);
  });

  it("refuses on a profile without commands, never asking the runtime", async () => {
    const h = harness({ capabilities: MAPPED });

    await expect(h.port.admitCommand("run-1", admitted("review"))).resolves.toEqual({
      ok: false,
      reason: "commands-unsupported",
    });

    expect(h.reads.count).toBe(0);
    expect(lines(h)).toMatchObject([{ outcome: "refused", reason: "commands-unsupported" }]);
  });

  it("refuses for a run that is not live", async () => {
    const h = harness({ missing: true });

    await expect(h.port.admitCommand("run-1", admitted("review"))).resolves.toEqual({
      ok: false,
      reason: "run-unavailable",
    });

    expect(lines(h)).toMatchObject([{ outcome: "refused", reason: "run-unavailable" }]);
  });

  it("refuses when the runtime cannot be asked, proving nothing about the name", async () => {
    const h = harness({ listing: () => Promise.reject(new OpenCodeV2HttpStatusError(500)) });

    await expect(h.port.admitCommand("run-1", admitted("review"))).resolves.toEqual({
      ok: false,
      reason: "command-unavailable",
    });

    expect(h.sink.events[0]).toMatchObject({
      level: "warn",
      errorKind: expect.any(String) as unknown,
      extra: { outcome: "refused", reason: "command-unavailable", command: "review" },
    });
  });

  it("emits only lines its own registration accepts", async () => {
    const refusals = [
      harness({ capabilities: MAPPED }),
      harness({ missing: true }),
      harness({ listing: () => Promise.reject(new Error("boom")) }),
      harness(),
    ];
    for (const h of refusals) await h.port.admitCommand("run-1", admitted("nope", 7));

    for (const h of refusals) {
      for (const event of h.sink.events) expect(activityLogEventWillBeRejected(event)).toBe(false);
    }
  });
});

describe("the presentation of a command turn", () => {
  it("shows the command as the operator typed it", () => {
    expect(commandDisplayText("review", "")).toBe("/review");
    expect(commandDisplayText("review", "   ")).toBe("/review");
    expect(commandDisplayText("review", "  main branch \n")).toBe("/review main branch");
  });

  it("binds the first new user message after it is armed, and keeps it on every later read", () => {
    const presentation = createOpenCodeCommandPresentation();

    expect(presentation.displayFor("msg_1", true), "nothing is armed").toBeUndefined();
    presentation.arm("/review main");
    expect(
      presentation.displayFor("msg_old", false),
      "a message already shown is not it",
    ).toBeUndefined();
    expect(presentation.displayFor("msg_2", true)).toBe("/review main");
    // The history is pulled again before its checkpoint is committed: the message stays presented.
    expect(presentation.displayFor("msg_2", true)).toBe("/review main");
    expect(presentation.displayFor("msg_2", false)).toBe("/review main");
    expect(presentation.displayFor("msg_3", true), "the arming is spent").toBeUndefined();
  });

  it("presents nothing once disarmed, so a later turn never takes a command's place", () => {
    const presentation = createOpenCodeCommandPresentation();
    presentation.arm("/init");

    presentation.disarm();

    expect(presentation.displayFor("msg_1", true)).toBeUndefined();
  });

  it("remembers a bounded number of command messages, forgetting the oldest first", () => {
    const presentation = createOpenCodeCommandPresentation();
    for (let index = 0; index <= OPENCODE_COMMAND_PRESENTATION_MAX; index += 1) {
      presentation.arm(`/review ${String(index)}`);
      presentation.displayFor(`msg_${String(index)}`, true);
    }

    expect(presentation.displayFor("msg_0", false), "the oldest was forgotten").toBeUndefined();
    expect(presentation.displayFor("msg_1", false)).toBe("/review 1");
    expect(presentation.displayFor(`msg_${String(OPENCODE_COMMAND_PRESENTATION_MAX)}`, false)).toBe(
      `/review ${String(OPENCODE_COMMAND_PRESENTATION_MAX)}`,
    );
  });
});
