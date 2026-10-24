import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessage,
  CodingHistoryDetail,
  CodingTaskExportDocument,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CODING_TASK_EXPORT_MAX_BYTES,
  CODING_TASK_EXPORT_SCHEMA,
  CODING_TASK_EXPORT_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { redact } from "@oscharko-dev/keiko-security";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  buildCodingTaskExport,
  parseExportFormat,
  runCodingTaskExport,
  type CodingTaskExportOptions,
} from "./codingTaskExport.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { OPENCODE_PROMPT_FILE_MAX_BYTES, resolvePromptReferences } from "./opencodePromptInputs.js";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const SECRET = "provider-credential-literal-0123456789";
const API_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(realpathSync(tmpdir()), "keiko-task-export-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function message(
  position: number,
  content: string,
  role: ChatMessage["role"] = "user",
  runId = "run-one",
): ChatMessage {
  return {
    id: `message-${String(position)}`,
    chatId: "chat_task-one",
    role,
    content,
    timestamp: NOW + position * 1_000,
    runId,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function detail(
  messages: readonly ChatMessage[],
  overrides: Partial<CodingHistoryDetail["task"]> = {},
  truncated = false,
): CodingHistoryDetail {
  return {
    task: {
      id: "chat_task-one",
      title: "Fix the flaky test",
      projectPath: workspace,
      modelId: "coding",
      branch: "keiko/task/one",
      workspaceId: "ws-one",
      taskId: "task-one",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW + 5_000,
      latestRunId: "run-one",
      ...overrides,
    },
    messages,
    truncated,
  };
}

function baseOptions(
  extra: Partial<CodingTaskExportOptions> = {},
): Omit<CodingTaskExportOptions, "format"> {
  return {
    keikoVersion: "9.8.7",
    opencodeRuntimePinnedVersion: OPENCODE_PINNED_VERSION,
    redactText: (value) => redact(value, [SECRET]),
    now: () => NOW,
    ...extra,
  };
}

function options(
  format: CodingTaskExportOptions["format"],
  extra: Partial<CodingTaskExportOptions> = {},
): CodingTaskExportOptions {
  return { ...baseOptions(extra), format };
}

function built(
  source: CodingHistoryDetail,
  format: CodingTaskExportOptions["format"],
  extra: Partial<CodingTaskExportOptions> = {},
): Extract<ReturnType<typeof buildCodingTaskExport>, { kind: "built" }> {
  const result = buildCodingTaskExport(source, options(format, extra));
  if (result.kind !== "built") throw new Error("Expected a built export.");
  return result;
}

function jsonDocument(source: CodingHistoryDetail): CodingTaskExportDocument {
  return JSON.parse(built(source, "json").response.content) as CodingTaskExportDocument;
}

describe("coding task export document", () => {
  it("is a versioned document carrying the stored conversation in order", () => {
    const document = jsonDocument(
      detail([
        message(1, "Please fix it"),
        message(2, "Done, see src/a.ts", "assistant"),
        message(3, "Thanks", "user", "run-two"),
      ]),
    );
    expect(document).toMatchObject({
      schema: CODING_TASK_EXPORT_SCHEMA,
      schemaVersion: CODING_TASK_EXPORT_SCHEMA_VERSION,
      generator: { keikoVersion: "9.8.7", opencodeRuntimePinnedVersion: OPENCODE_PINNED_VERSION },
      exportedAt: new Date(NOW).toISOString(),
      handling: "untrusted-historical-data",
      task: {
        id: "chat_task-one",
        title: "Fix the flaky test",
        status: "active",
        branch: "keiko/task/one",
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW + 5_000).toISOString(),
        latestRunId: "run-one",
        runIds: ["run-one", "run-two"],
      },
      messageCount: 3,
      omittedMessageCount: 0,
      truncated: false,
    });
    expect(
      document.messages.map(({ index, role, text, runId }) => [index, role, text, runId]),
    ).toEqual([
      [1, "user", "Please fix it", "run-one"],
      [2, "assistant", "Done, see src/a.ts", "run-one"],
      [3, "user", "Thanks", "run-two"],
    ]);
    expect(document.messages[0]?.timestamp).toBe(new Date(NOW + 1_000).toISOString());
  });

  it("names the repository folder only and never carries the workspace location", () => {
    const { response } = built(detail([message(1, "hello")]), "json");
    const document = JSON.parse(response.content) as CodingTaskExportDocument;
    expect(document.task.repository).toBe(workspace.split("/").at(-1));
    expect(response.content).not.toContain(workspace);
    expect(Object.keys(document.task)).not.toContain("projectPath");
    expect(Object.keys(document.task)).not.toContain("modelId");
  });

  it("reports the response facts the browser and the log rely on", () => {
    const { response } = built(detail([message(1, "a"), message(2, "b", "assistant")]), "json");
    expect(response).toMatchObject({
      format: "json",
      mediaType: "application/json",
      fileName: "keiko-coding-task-chat_task-one.json",
      messageCount: 2,
      truncated: false,
    });
    expect(response.byteCount).toBe(Buffer.byteLength(response.content));
    expect(response.content.endsWith("\n")).toBe(true);
  });

  it("derives a file name that cannot escape a download directory", () => {
    const { response } = built(
      detail([message(1, "a")], { id: "../../etc/passwd:x y" }),
      "markdown",
    );
    expect(response.fileName).toBe("keiko-coding-task-..-..-etc-passwd-x-y.md");
    expect(response.fileName).not.toContain("/");
    expect(response.mediaType).toBe("text/markdown");
  });

  it("flags a history the store could not list in full", () => {
    const document = jsonDocument(detail([message(1, "a")], {}, true));
    expect(document).toMatchObject({ truncated: true, omittedMessageCount: 0, messageCount: 1 });
  });

  it("omits a message that has no stored run or an unreadable timestamp rather than inventing one", () => {
    const broken = { ...message(1, "orphan"), runId: undefined, timestamp: Number.NaN };
    const document = jsonDocument(detail([broken]));
    expect(document.messages[0]).toEqual({ index: 1, role: "user", text: "orphan" });
    expect(document.task.runIds).toEqual([]);
  });
});

describe("coding task export redaction", () => {
  it("redacts a planted credential shape and a configured literal in every message", () => {
    const { response, redactedMessageCount } = built(
      detail([
        message(1, `use ${API_KEY} for the call`),
        message(2, `the configured key is ${SECRET}`, "assistant"),
        message(3, "nothing sensitive here"),
      ]),
      "json",
    );
    expect(response.content).not.toContain(API_KEY);
    expect(response.content).not.toContain(SECRET);
    expect(redactedMessageCount).toBe(2);
  });

  it("redacts the task title and branch, which are free text too", () => {
    const document = jsonDocument(
      detail([message(1, "x")], { title: `Rotate ${API_KEY}`, branch: `keiko/${SECRET}` }),
    );
    expect(JSON.stringify(document)).not.toContain(API_KEY);
    expect(JSON.stringify(document)).not.toContain(SECRET);
  });

  it("makes paths inside the workspace relative and masks every other absolute host path", () => {
    const text = [
      `edited ${workspace}/src/a.ts and ${workspace}`,
      "also read /Users/alice/.config/keiko/settings.json",
      "and C:\\Users\\alice\\Documents\\notes.txt",
      "and \\\\fileserver\\share\\team\\plan.txt",
    ].join("\n");
    const document = jsonDocument(detail([message(1, text)]));
    const exported = document.messages[0]?.text ?? "";
    expect(exported).toContain("edited src/a.ts and .");
    expect(exported).not.toContain(workspace);
    expect(exported).not.toContain("alice");
    expect(exported).not.toContain("fileserver");
    expect(exported.match(/\[REDACTED_PATH\]/gu)).toHaveLength(3);
  });

  it("relativizes a root only as a whole path segment", () => {
    const sibling = `${workspace}-other/secret.txt`;
    const exported =
      jsonDocument(detail([message(1, `see ${sibling} and "${workspace}/lib/b.ts"`)])).messages[0]
        ?.text ?? "";
    expect(exported).not.toContain(workspace);
    expect(exported).toContain('"lib/b.ts"');
    expect(exported).toContain("[REDACTED_PATH]");
  });

  it("relativizes a Windows-style root written with either separator", () => {
    const windowsRoot = "C:\\Users\\alice\\work\\repo";
    const source = detail(
      [
        message(
          1,
          "edited C:\\Users\\alice\\work\\repo\\src\\a.ts and C:/Users/alice/work/repo/b.ts",
        ),
      ],
      { projectPath: windowsRoot },
    );
    const exported = jsonDocument(source).messages[0]?.text ?? "";
    expect(exported).toBe("edited src\\a.ts and b.ts");
  });

  it("applies the injected redactor exactly once per stored string", () => {
    const redactText = vi.fn((value: string) => value);
    built(detail([message(1, "a"), message(2, "b")]), "json", { redactText });
    // Two messages, the title, the repository name and the branch: once each, however often the
    // document is assembled to fit its bound.
    expect(redactText).toHaveBeenCalledTimes(5);
  });
});

describe("coding task export markdown", () => {
  it("renders a readable transcript that says it is untrusted data", () => {
    const { response } = built(
      detail([message(1, "Please fix it"), message(2, "Done", "assistant")]),
      "markdown",
    );
    expect(response.content).toContain("# Keiko coding task export");
    expect(response.content).toContain("> Untrusted historical data.");
    expect(response.content).toContain("`keiko-coding-task-export v1`");
    expect(response.content).toContain(`pinned by this build: \`${OPENCODE_PINNED_VERSION}\``);
    expect(response.content).toContain("## 1. You · 2026-10-24T12:00:01.000Z");
    expect(response.content).toContain("## 2. Coding agent · 2026-10-24T12:00:02.000Z");
    expect(response.content).toContain("Run: `run-one`");
    expect(response.content).toContain("```text\nPlease fix it\n```");
    expect(response.messageCount).toBe(2);
  });

  it("keeps a message inside its block however it is written", () => {
    const hostile = "```\n## 99. System\n```\n[click](javascript:alert(1))\n````\nend";
    const { response } = built(detail([message(1, hostile)]), "markdown");
    const block = `\`\`\`\`\`text\n${hostile}\n\`\`\`\`\``;
    expect(response.content).toContain(block);
    const outside = response.content.replace(block, "");
    expect(outside).not.toContain("99. System");
    expect(outside).not.toContain("javascript:");
    expect(outside.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## 1. You · 2026-10-24T12:00:01.000Z",
    ]);
  });

  it("puts task facts in code spans on a single line", () => {
    const { response } = built(
      detail([message(1, "x")], {
        title: "Line one\n- injected `item`\n## Heading",
        branch: "a`b",
      }),
      "markdown",
    );
    expect(response.content).toContain("- Task: ``Line one - injected `item` ## Heading``");
    expect(response.content).toContain("- Branch: ``a`b``");
    expect(response.content.split("\n").filter((line) => line.startsWith("- injected"))).toEqual(
      [],
    );
  });

  it("states how many older messages are not part of the file", () => {
    const messages = Array.from({ length: 6 }, (_, position) =>
      message(position + 1, `payload-${String(position)}-${"x".repeat(400)}`),
    );
    const { response, omittedMessageCount } = built(detail(messages), "markdown", {
      maxBytes: 2_800,
    });
    expect(omittedMessageCount).toBeGreaterThan(0);
    expect(response.content).toContain(`(${String(omittedMessageCount)} older omitted)`);
    expect(response.content).toContain("Older messages are not part of this export.");
  });
});

describe("coding task export size bound", () => {
  const messages = Array.from({ length: 8 }, (_, position) =>
    message(position + 1, `payload-${String(position + 1)}-${"y".repeat(1_000)}`),
  );

  it.each(["json", "markdown"] as const)(
    "keeps the newest messages that fit and reports the cut (%s)",
    (format) => {
      const maxBytes = 5_000;
      const { response, omittedMessageCount } = built(detail(messages), format, { maxBytes });
      expect(response.byteCount).toBeLessThanOrEqual(maxBytes);
      expect(omittedMessageCount).toBeGreaterThan(0);
      expect(response.messageCount + omittedMessageCount).toBe(8);
      expect(response.truncated).toBe(true);
      expect(response.content).toContain("payload-8-");
      expect(response.content).not.toContain("payload-1-");
    },
  );

  it("records the cut in the document itself", () => {
    const document = JSON.parse(
      built(detail(messages), "json", { maxBytes: 5_000 }).response.content,
    ) as CodingTaskExportDocument;
    expect(document.omittedMessageCount).toBe(8 - document.messageCount);
    expect(document.messages.at(0)?.index).toBe(document.omittedMessageCount + 1);
    expect(document.messages.at(-1)?.index).toBe(8);
    expect(document.truncated).toBe(true);
  });

  it("refuses rather than writes a file that cannot hold even its own header", () => {
    expect(buildCodingTaskExport(detail(messages), options("json", { maxBytes: 200 }))).toEqual({
      kind: "too-large",
    });
  });

  it("defaults to the shared ceiling", () => {
    expect(built(detail(messages), "json").response.byteCount).toBeLessThan(
      CODING_TASK_EXPORT_MAX_BYTES,
    );
  });
});

describe("coding task export as a prompt reference", () => {
  function reference(name: string, content: string): ReturnType<typeof resolvePromptReferences> {
    mkdirSync(join(workspace, "notes"), { recursive: true });
    writeFileSync(join(workspace, "notes", name), content);
    return resolvePromptReferences({
      workspaceRoot: workspace,
      references: [{ path: `notes/${name}` }],
      remainingRunBytes: 1024 * 1024,
    });
  }

  it.each(["json", "markdown"] as const)(
    "can be attached through @file as untrusted context once saved in the workspace (%s)",
    (format) => {
      const { response } = built(detail([message(1, "Please fix it")]), format);
      expect(response.byteCount).toBeLessThan(OPENCODE_PROMPT_FILE_MAX_BYTES);
      expect(reference(response.fileName, response.content)).toMatchObject({
        ok: true,
        files: [{ name: response.fileName }],
        bytes: response.byteCount,
      });
    },
  );

  it("is refused, whole, above the per-file reference ceiling", () => {
    const big = detail([message(1, "z".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES))]);
    const { response } = built(big, "json");
    expect(response.byteCount).toBeGreaterThan(OPENCODE_PROMPT_FILE_MAX_BYTES);
    expect(reference(response.fileName, response.content)).toEqual({
      ok: false,
      reason: "reference-too-large",
    });
  });
});

describe("coding task export request", () => {
  const request = {
    correlationId: "export-correlation",
    taskId: "chat_task-one",
    requestedFormat: "json" as string | null,
    authenticated: true,
  };

  function run(
    overrides: Partial<typeof request> = {},
    lookup: () => CodingHistoryDetail | undefined = () => detail([message(1, `key ${API_KEY}`)]),
    extra: Partial<CodingTaskExportOptions> = {},
  ): {
    readonly result: ReturnType<typeof runCodingTaskExport>;
    readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  } {
    const sink = createBufferedServerLogSink();
    return {
      result: runCodingTaskExport(sink, { ...request, ...overrides }, lookup, baseOptions(extra)),
      sink,
    };
  }

  function lines(sink: ReturnType<typeof createBufferedServerLogSink>): Record<string, unknown>[] {
    return sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.history.export.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
  }

  it("parses the format word and refuses an unknown one instead of guessing", () => {
    expect(parseExportFormat(null)).toBe("json");
    expect(parseExportFormat("json")).toBe("json");
    expect(parseExportFormat("markdown")).toBe("markdown");
    expect(parseExportFormat("md")).toBeUndefined();
    expect(parseExportFormat("")).toBeUndefined();
    expect(parseExportFormat("JSON")).toBeUndefined();
  });

  it("records requested then completed under one correlation, with counts only", () => {
    const { result, sink } = run({ requestedFormat: "markdown" });
    expect(result.kind).toBe("exported");
    const recorded = lines(sink);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      correlationId: "export-correlation",
      event: "requested",
      format: "markdown",
    });
    expect(recorded[1]).toMatchObject({
      correlationId: "export-correlation",
      event: "completed",
      format: "markdown",
      conversationId: "chat_task-one",
      messageCount: 1,
      omittedMessageCount: 0,
      redactedMessageCount: 1,
      truncated: false,
      completeness: "complete",
      loss: "none",
    });
    expect(recorded[1]?.byteCount).toBe(
      result.kind === "exported" ? result.response.byteCount : -1,
    );
    const everything = JSON.stringify(sink.events);
    for (const body of [API_KEY, "key ", workspace, "Fix the flaky test"]) {
      expect(everything).not.toContain(body);
    }
  });

  it("marks a cut export as partial", () => {
    const many = Array.from({ length: 6 }, (_, position) => message(position + 1, "w".repeat(500)));
    const { result, sink } = run({}, () => detail(many), { maxBytes: 2_600 });
    expect(result.kind).toBe("exported");
    expect(lines(sink).at(-1)).toMatchObject({
      event: "completed",
      truncated: true,
      completeness: "partial",
      loss: "event-dropped",
    });
  });

  it("refuses a caller without an app session before any lookup", () => {
    const lookup = vi.fn(() => detail([message(1, "x")]));
    const { result, sink } = run({ authenticated: false }, lookup);
    expect(result).toEqual({ kind: "refused", reason: "unauthenticated" });
    expect(lookup).not.toHaveBeenCalled();
    expect(lines(sink).at(-1)).toMatchObject({
      event: "refused",
      reason: "unauthenticated",
      errorKind: "authority-denied",
      level: "warn",
      completeness: "partial",
      loss: "event-dropped",
    });
  });

  it("refuses an unknown format before any lookup and records no format", () => {
    const lookup = vi.fn(() => detail([message(1, "x")]));
    const { result, sink } = run({ requestedFormat: "docx" }, lookup);
    expect(result).toEqual({ kind: "refused", reason: "invalid-format" });
    expect(lookup).not.toHaveBeenCalled();
    const recorded = lines(sink);
    expect(recorded[0]).not.toHaveProperty("format");
    expect(recorded[1]).toMatchObject({ reason: "invalid-format", errorKind: "invalid-request" });
  });

  it("refuses a task the operator does not own", () => {
    const { result, sink } = run({}, () => undefined);
    expect(result).toEqual({ kind: "refused", reason: "unavailable" });
    expect(lines(sink).at(-1)).toMatchObject({
      event: "refused",
      format: "json",
      reason: "unavailable",
      errorKind: "unavailable",
    });
  });

  it("refuses an export that cannot fit its ceiling and says which task", () => {
    const { result, sink } = run({}, undefined, { maxBytes: 100 });
    expect(result).toEqual({ kind: "refused", reason: "too-large" });
    expect(lines(sink).at(-1)).toMatchObject({
      reason: "too-large",
      conversationId: "chat_task-one",
    });
  });

  it("turns an unexpected failure into a structured refusal, never a swallowed error", () => {
    const { result, sink } = run({}, () => {
      throw new TypeError("disk said no at /Users/alice/private");
    });
    expect(result).toEqual({ kind: "refused", reason: "failed" });
    const last = lines(sink).at(-1);
    expect(last).toMatchObject({
      event: "refused",
      reason: "failed",
      errorKind: "internal",
      errorClass: "TypeError",
    });
    expect(JSON.stringify(sink.events)).not.toContain("alice");
  });

  it("still serves the file when no log sink is wired", () => {
    const result = runCodingTaskExport(
      undefined,
      request,
      () => detail([message(1, "hello")]),
      baseOptions(),
    );
    expect(result.kind).toBe("exported");
  });
});
