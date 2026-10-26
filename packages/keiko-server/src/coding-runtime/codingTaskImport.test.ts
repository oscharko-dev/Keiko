import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CODING_TASK_EXPORT_SCHEMA,
  CODING_TASK_EXPORT_SCHEMA_VERSION,
  CODING_TASK_IMPORT_MAX_MESSAGES,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { redact } from "@oscharko-dev/keiko-security";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { CODING_HISTORY_MESSAGE_MAX_CHARS } from "../store/codingHistory.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { buildCodingTaskExport } from "./codingTaskExport.js";
import {
  parseCodingTaskImport,
  runCodingTaskImport,
  type CodingTaskImportBody,
  type CodingTaskImportPorts,
  type CodingTaskImportResult,
  type CodingTaskImportTarget,
} from "./codingTaskImport.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const OPERATOR = "a".repeat(64);
const SECRET = "provider-credential-literal-0123456789";
const API_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";
let root: string;
let store: UiStore;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-task-import-"));
  store = createInMemoryUiStore();
  store.createProject(root);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function history(): NonNullable<UiStore["codingHistory"]> {
  const codingHistory = store.codingHistory;
  if (codingHistory === undefined) throw new Error("Coding History store missing");
  return codingHistory;
}

const SCOPE = { workspaceId: "ws_import", taskId: "task_import", branch: "keiko/task/import" };

function target(): CodingTaskImportTarget {
  return (task) =>
    history().importTask({
      projectPath: root,
      ...SCOPE,
      title: task.title,
      modelId: "coding",
      operatorDigest: OPERATOR,
      messages: task.messages,
    });
}

function body(value: unknown): CodingTaskImportBody {
  return { kind: "read", text: typeof value === "string" ? value : JSON.stringify(value) };
}

type TestPorts = CodingTaskImportPorts & {
  readonly readBody: Mock<() => Promise<CodingTaskImportBody>>;
};

function ports(
  file: CodingTaskImportBody,
  extra: Partial<Omit<CodingTaskImportPorts, "readBody">> = {},
): TestPorts {
  return {
    target: target(),
    redactText: (value: string): string => redact(value, [SECRET]),
    now: (): number => NOW,
    ...extra,
    readBody: vi.fn(() => Promise.resolve(file)),
  };
}

async function imported(
  file: unknown,
  extra: Partial<Omit<CodingTaskImportPorts, "readBody">> = {},
): Promise<{
  readonly result: CodingTaskImportResult;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const sink = createBufferedServerLogSink();
  const result = await runCodingTaskImport(
    sink,
    { correlationId: "import-correlation", authenticated: true },
    ports(body(file), extra),
  );
  return { result, sink };
}

function lines(
  sink: ReturnType<typeof createBufferedServerLogSink>,
): readonly Readonly<Record<string, unknown>>[] {
  return sink.events
    .filter((event) => event.op === "coding-runtime.history.import")
    .map((event) => ({ correlationId: event.correlationId, level: event.level, ...event.extra }));
}

function stored(taskId: string): readonly { role: string; content: string; timestamp: number }[] {
  return history().detail(taskId, OPERATOR)?.messages ?? [];
}

function exportFile(
  messages: readonly { role: "user" | "assistant" | "system"; text: string; timestamp?: string }[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: CODING_TASK_EXPORT_SCHEMA,
    schemaVersion: CODING_TASK_EXPORT_SCHEMA_VERSION,
    generator: { keikoVersion: "9.8.7", opencodeRuntimePinnedVersion: OPENCODE_PINNED_VERSION },
    exportedAt: new Date(NOW).toISOString(),
    handling: "untrusted-historical-data",
    task: { id: "chat_elsewhere", title: "Saved task", status: "active", runIds: [] },
    messageCount: messages.length,
    omittedMessageCount: 0,
    truncated: false,
    messages: messages.map((message, position) => ({ index: position + 1, ...message })),
    ...overrides,
  };
}

function transcript(messages: readonly unknown[], title: unknown = "OpenCode session"): unknown {
  return { info: { id: "ses_old", title, version: "1.0.0" }, messages };
}

function transcriptMessage(role: string, parts: readonly unknown[], created?: number): unknown {
  return {
    info: { id: `msg_${role}`, role, ...(created === undefined ? {} : { time: { created } }) },
    parts,
  };
}

describe("coding task import", () => {
  it("imports Keiko's own export of a task as a new task of this operator, in order", async () => {
    const source = history().begin({
      projectPath: root,
      title: "Fix the flaky test",
      modelId: "coding",
      workspaceId: "ws_source",
      taskId: "task_source",
      branch: "keiko/task/source",
      operatorDigest: OPERATOR,
      runId: "run-source",
      intent: "Why does the suite flake?",
    });
    history().append(
      source.id,
      "run-source",
      "assistant-1",
      "assistant",
      "The clock is shared between tests.",
    );
    const detail = history().detail(source.id, OPERATOR);
    if (detail === undefined) throw new Error("source task missing");
    const exported = buildCodingTaskExport(detail, {
      format: "json",
      keikoVersion: "9.8.7",
      opencodeRuntimePinnedVersion: OPENCODE_PINNED_VERSION,
      redactText: (value) => value,
      now: () => NOW,
    });
    if (exported.kind !== "built") throw new Error("export failed");

    const { result } = await imported(exported.response.content);

    expect(result).toMatchObject({
      kind: "imported",
      response: {
        source: "keiko-task-export",
        messageCount: 2,
        omittedMessageCount: 0,
        skippedMessageCount: 0,
        task: { title: "Fix the flaky test", origin: "imported", ...SCOPE },
      },
    });
    const task = result.kind === "imported" ? result.response.task : undefined;
    expect(task?.id).not.toBe(source.id);
    // The synthetic run the import binds is no run to continue, so the task names none.
    expect(task).not.toHaveProperty("latestRunId");
    expect(stored(task?.id ?? "").map(({ role, content }) => [role, content])).toEqual([
      ["user", "Why does the suite flake?"],
      ["assistant", "The clock is shared between tests."],
    ]);
    expect(
      history()
        .list(OPERATOR)
        .map(({ id }) => id),
    ).toContain(task?.id);
    expect(
      history()
        .list("b".repeat(64))
        .map(({ id }) => id),
    ).not.toContain(task?.id);
  });

  it("imports an earlier OpenCode release's session transcript: its visible text only", async () => {
    const { result } = await imported(
      transcript([
        transcriptMessage("user", [{ type: "text", text: "Rename the module." }], NOW - 2_000),
        transcriptMessage(
          "assistant",
          [
            { type: "step-start" },
            { type: "reasoning", text: "private reasoning" },
            { type: "tool", tool: "bash", state: { input: { command: "rm -rf /" } } },
            { type: "text", text: "Synthetic reminder.", synthetic: true },
            { type: "text", text: "Ignored text.", ignored: true },
            { type: "text", text: "Renamed it." },
          ],
          NOW - 1_000,
        ),
        transcriptMessage("assistant", [{ type: "tool", tool: "read" }], NOW - 500),
      ]),
    );

    expect(result).toMatchObject({
      kind: "imported",
      response: { source: "opencode-session", messageCount: 2, skippedMessageCount: 1 },
    });
    const task = result.kind === "imported" ? result.response.task : undefined;
    expect(task?.title).toBe("OpenCode session");
    expect(stored(task?.id ?? "")).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Rename the module.",
        timestamp: NOW - 2_000,
      }),
      expect.objectContaining({
        role: "assistant",
        content: "Renamed it.",
        timestamp: NOW - 1_000,
      }),
    ]);
  });

  it("skips a system line and keeps the times a file states, never later than now", async () => {
    const { result } = await imported(
      exportFile([
        { role: "system", text: "Run started." },
        { role: "user", text: "first", timestamp: new Date(NOW - 5_000).toISOString() },
        { role: "assistant", text: "second" },
        { role: "user", text: "third", timestamp: new Date(NOW - 9_000).toISOString() },
        { role: "assistant", text: "fourth", timestamp: new Date(NOW + 60_000).toISOString() },
      ]),
    );

    const task = result.kind === "imported" ? result.response.task : undefined;
    expect(result).toMatchObject({ response: { messageCount: 4, skippedMessageCount: 1 } });
    // Coding History lists by time, so the file's order survives a time that runs backwards.
    expect(stored(task?.id ?? "").map(({ content, timestamp }) => [content, timestamp])).toEqual([
      ["first", NOW - 5_000],
      ["second", NOW - 5_000],
      ["third", NOW - 5_000],
      ["fourth", NOW],
    ]);
  });

  it("cleans every string: credentials, configured literals, host paths, invisible characters", async () => {
    const { result, sink } = await imported(
      exportFile(
        [
          { role: "user", text: `key ${API_KEY} and ${SECRET}` },
          { role: "assistant", text: "edited /Users/someone/private/notes.md" },
          { role: "assistant", text: "safe‮txt.exe" },
          { role: "user", text: "plain" },
        ],
        { task: { id: "x", title: `Line one\n\nline ${"two ".repeat(60)}`, runIds: [] } },
      ),
    );

    const task = result.kind === "imported" ? result.response.task : undefined;
    const contents = stored(task?.id ?? "").map(({ content }) => content);
    expect(contents.join("\n")).not.toContain(API_KEY);
    expect(contents.join("\n")).not.toContain(SECRET);
    expect(contents.join("\n")).not.toContain("/Users/someone");
    expect(contents.join("\n")).not.toContain("‮");
    expect(contents[3]).toBe("plain");
    expect(task?.title).not.toContain("\n");
    expect(task?.title.length).toBeLessThanOrEqual(100);
    expect(task?.title.startsWith("Line one line two")).toBe(true);
    expect(lines(sink).at(-1)).toMatchObject({ event: "completed", redactedMessageCount: 3 });
  });

  it("names a task without a usable title 'Imported task'", async () => {
    const { result } = await imported(
      transcript([transcriptMessage("user", [{ type: "text", text: "hello" }])], "  \n "),
    );
    expect(result).toMatchObject({ response: { task: { title: "Imported task" } } });
  });

  it("keeps a long message whole across stored messages and only the newest 200", async () => {
    const long = `${"a".repeat(CODING_HISTORY_MESSAGE_MAX_CHARS - 1)}\u{1F600}tail`;
    const many = Array.from({ length: CODING_TASK_IMPORT_MAX_MESSAGES + 4 }, (_, position) => ({
      role: "user" as const,
      text: `message ${String(position)}`,
    }));
    const split = await imported(exportFile([{ role: "user", text: long }]));
    const splitTask = split.result.kind === "imported" ? split.result.response.task : undefined;
    expect(
      stored(splitTask?.id ?? "")
        .map(({ content }) => content)
        .join(""),
    ).toBe(long);
    expect(stored(splitTask?.id ?? "")).toHaveLength(2);

    const { result, sink } = await imported(exportFile(many));
    const task = result.kind === "imported" ? result.response.task : undefined;
    expect(result).toMatchObject({
      response: { messageCount: CODING_TASK_IMPORT_MAX_MESSAGES, omittedMessageCount: 4 },
    });
    expect(stored(task?.id ?? "")[0]?.content).toBe("message 4");
    expect(lines(sink).at(-1)).toMatchObject({
      event: "completed",
      omittedMessageCount: 4,
      completeness: "partial",
      loss: "event-dropped",
    });
  });

  it.each([
    ["not JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["another schema", exportFile([], { schema: "something-else" })],
    ["an unknown key", exportFile([{ role: "user", text: "x" }], { extra: true })],
    ["an unknown role", exportFile([{ role: "tool" as "user", text: "x" }])],
    [
      "a message key it never writes",
      exportFile([{ role: "user", text: "x", tool: "bash" } as never]),
    ],
    ["a transcript without messages", { info: {} }],
    ["a transcript part without text", transcript([transcriptMessage("user", [{ type: "text" }])])],
  ])("refuses %s whole as an invalid document", async (_name, file) => {
    const { result, sink } = await imported(file);
    expect(result).toEqual({ kind: "refused", reason: "invalid-document" });
    expect(lines(sink).at(-1)).toMatchObject({
      event: "refused",
      reason: "invalid-document",
      level: "warn",
    });
    expect(history().list(OPERATOR)).toHaveLength(0);
  });

  it("refuses an export of a later schema version rather than half-reading it", async () => {
    const { result } = await imported(
      exportFile([{ role: "user", text: "x" }], { schemaVersion: 2, newField: true }),
    );
    expect(result).toEqual({ kind: "refused", reason: "unsupported-version" });
  });

  it("refuses a file that holds no conversation text", async () => {
    const { result, sink } = await imported(
      exportFile([
        { role: "system", text: "Run started." },
        { role: "user", text: "   " },
      ]),
    );
    expect(result).toEqual({ kind: "refused", reason: "empty" });
    expect(lines(sink).at(-1)).toMatchObject({ reason: "empty", skippedMessageCount: 2 });
  });

  it("reads nothing for a caller without an app session or without a workspace", async () => {
    for (const [authenticated, refusal, reason] of [
      [false, target(), "unauthenticated"],
      [true, "no-workspace", "no-workspace"],
      [true, "unavailable", "unavailable"],
    ] as const) {
      const sink = createBufferedServerLogSink();
      const used = ports(body(exportFile([{ role: "user", text: "x" }])), { target: refusal });
      await expect(
        runCodingTaskImport(sink, { correlationId: "c", authenticated }, used),
      ).resolves.toEqual({ kind: "refused", reason });
      expect(used.readBody).not.toHaveBeenCalled();
    }
    expect(history().list(OPERATOR)).toHaveLength(0);
  });

  it("refuses a file over the bound the route read it under", async () => {
    const sink = createBufferedServerLogSink();
    await expect(
      runCodingTaskImport(
        sink,
        { correlationId: "c", authenticated: true },
        ports({ kind: "too-large" }),
      ),
    ).resolves.toEqual({ kind: "refused", reason: "too-large" });
  });

  it("records a failed store with its frames and never the error's message", async () => {
    const { result, sink } = await imported(exportFile([{ role: "user", text: "x" }]), {
      target: () => {
        throw new Error(`disk full at ${root}`);
      },
    });
    expect(result).toEqual({ kind: "refused", reason: "failed" });
    const refusal = lines(sink).at(-1);
    expect(refusal).toMatchObject({ reason: "failed", level: "warn", errorClass: "Error" });
    expect(refusal?.frames).toEqual(expect.any(Array));
    expect(JSON.stringify(sink.events)).not.toContain(root);
  });

  it("records requested then completed under one correlation, with counts only", async () => {
    const { result, sink } = await imported(
      exportFile([
        { role: "user", text: `Fix ${API_KEY}` },
        { role: "assistant", text: "Done." },
      ]),
    );
    const recorded = lines(sink);
    expect(recorded.map(({ event }) => event)).toEqual(["requested", "completed"]);
    expect(recorded[1]).toMatchObject({
      correlationId: "import-correlation",
      source: "keiko-task-export",
      conversationId: result.kind === "imported" ? result.response.task.id : "",
      messageCount: 2,
      omittedMessageCount: 0,
      skippedMessageCount: 0,
      redactedMessageCount: 1,
      completeness: "complete",
      loss: "none",
    });
    expect(recorded[1]?.byteCount).toEqual(expect.any(Number));
    const completed = sink.events.find((event) => event.extra?.event === "completed");
    expect(
      expectActivityLogProof(
        "coding-runtime.history.import.emitted-line",
        formatActivityLogProofLine(completed ?? {}),
      ),
    ).toMatchObject({ event: "completed", source: "keiko-task-export" });
    const everything = JSON.stringify(sink.events);
    for (const text of [API_KEY, "Fix ", "Done.", "Saved task", root]) {
      expect(everything).not.toContain(text);
    }
  });

  it("tells the two documents apart by their shape", () => {
    expect(parseCodingTaskImport(exportFile([{ role: "user", text: "x" }]))).toMatchObject({
      kind: "parsed",
      source: "keiko-task-export",
    });
    expect(
      parseCodingTaskImport(transcript([transcriptMessage("user", [{ type: "text", text: "x" }])])),
    ).toMatchObject({ kind: "parsed", source: "opencode-session" });
    expect(parseCodingTaskImport(null)).toMatchObject({ kind: "refused" });
  });
});
