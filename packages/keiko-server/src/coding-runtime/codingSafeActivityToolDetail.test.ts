import { describe, expect, it } from "vitest";
import {
  CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS,
  CODING_SAFE_ACTIVITY_TOOL_OUTPUT_HEAD_LINES,
  CODING_SAFE_ACTIVITY_TOOL_OUTPUT_TAIL_LINES,
  isCodingSafeActivityToolPresentation,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import {
  boundedToolText,
  openCodeToolDetail,
  redactToolTexts,
  shortenedOutput,
  toolOutputPreview,
  withoutCutSecretStart,
} from "./codingSafeActivityToolDetail.js";

// An issuer-format token the credential floor removes from every text a person reads.
const TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const EMOJI = "\u{1F600}";

function shellPart(
  state: Readonly<Record<string, unknown>>,
  time: Readonly<Record<string, unknown>> = { created: 1, ran: 1_000, completed: 3_500 },
): Readonly<Record<string, unknown>> {
  return { type: "tool", id: "call", name: "shell", time, state };
}

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`).join("\n");
}

describe("the origin of a call that did not succeed", () => {
  it.each([
    ["a non-zero exit", { exit: 2 }, "command-failed"],
    ["a timeout", { exit: 124, timeout: true }, "timed-out"],
    // A kill nobody asked for (the system's memory guard, a crash) is the command's own failure.
    ["a kill signal", { signal: "SIGKILL" }, "command-failed"],
    ["no exit status at all", {}, "tool-error"],
  ] as const)("names %s of a finished shell", (_label, metadata, origin) => {
    const state = { status: "completed", input: { command: "npm test" }, metadata };
    expect(openCodeToolDetail("shell", shellPart(state), state, "failed").failureOrigin).toBe(
      origin,
    );
  });

  it("names a runtime error the tool's own and keeps the message it handed the model", () => {
    const state = {
      status: "error",
      input: { filePath: "missing.ts" },
      error: {
        type: "unknown",
        message: "File not found: missing.ts",
        response: { body: "PROVIDER_BODY" },
      },
    };
    const detail = openCodeToolDetail("read", shellPart(state), state, "failed");
    expect(detail).toMatchObject({
      failureOrigin: "tool-error",
      errorText: { text: "File not found: missing.ts", truncated: false },
    });
    // The provider's response body is not the message and never leaves the runtime.
    expect(JSON.stringify(detail)).not.toContain("PROVIDER_BODY");
  });

  it.each([
    ["arguments that are not JSON", "tool.input-json", "invalid-arguments"],
    ["arguments the model's output ended in", "tool.input-incomplete", "invalid-arguments"],
    // An unknown tool or a schema miss is the runtime's ordinary execution error: no closed fact
    // tells it apart, so the row names it a tool error and shows the runtime's own message.
    ["an unknown tool or a schema miss", "tool.execution", "tool-error"],
  ] as const)("names %s from the runtime's closed error type", (_label, type, origin) => {
    const state = {
      status: "error",
      input: {},
      error: { type, message: 'Invalid arguments for tool "read"' },
    };
    const detail = openCodeToolDetail("read", shellPart(state), state, "failed");
    expect(detail).toMatchObject({
      failureOrigin: origin,
      errorText: { text: 'Invalid arguments for tool "read"', truncated: false },
    });
  });

  it("names Keiko's refusal and a stop from the display state alone", () => {
    const state = { status: "error", error: "permission.rejected" };
    expect(openCodeToolDetail("edit", shellPart(state), state, "denied").failureOrigin).toBe(
      "keiko-refused",
    );
    expect(openCodeToolDetail("edit", shellPart(state), state, "cancelled").failureOrigin).toBe(
      "cancelled",
    );
  });

  it("names no origin for a call that succeeded or still runs", () => {
    const state = { status: "completed", input: { command: "ls" }, metadata: { exit: 0 } };
    expect(openCodeToolDetail("shell", shellPart(state), state, "succeeded")).not.toHaveProperty(
      "failureOrigin",
    );
    expect(openCodeToolDetail("shell", shellPart(state), state, "running")).not.toHaveProperty(
      "failureOrigin",
    );
  });
});

describe("a shell call's command, output and duration", () => {
  it("carries the command, the printed text and how long it ran", () => {
    const state = {
      status: "completed",
      input: { command: "npm test", workdir: "/private/workspace" },
      content: [{ type: "text", text: "ok 1\nok 2\n" }],
      metadata: { exit: 1 },
    };
    const detail = openCodeToolDetail("shell", shellPart(state), state, "failed");
    expect(detail).toEqual({
      failureOrigin: "command-failed",
      durationMs: 2_500,
      command: { text: "npm test", truncated: false },
      output: { head: "ok 1\nok 2", tail: "", lineCount: 2, hiddenLineCount: 0, truncated: false },
    });
    // The working directory is a path; it is not part of what the row shows.
    expect(JSON.stringify(detail)).not.toContain("/private/workspace");
    expect(isCodingSafeActivityToolPresentation(detail)).toBe(true);
  });

  it("names no command for another tool and no duration without both timestamps", () => {
    const state = { status: "completed", input: { command: "not a shell" } };
    const detail = openCodeToolDetail("read", shellPart(state, { created: 1 }), state, "succeeded");
    expect(detail).toEqual({});
  });

  it("removes the credential floor from the command, the output and the error", () => {
    const state = {
      status: "error",
      input: { command: `curl -H "Authorization: token ${TOKEN}" https://example.invalid` },
      content: [{ type: "text", text: `token is ${TOKEN}` }],
      error: { message: `rejected ${TOKEN}` },
    };
    const detail = openCodeToolDetail("shell", shellPart(state), state, "failed");
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
    expect(detail.command?.text).toContain("curl");
    expect(detail.errorText?.text).toContain("rejected");
  });

  it("redacts a token that a bidi or zero-width mark splits", () => {
    const tail = TOKEN.slice(-12);
    for (const at of [6, 28]) {
      for (const mark of ["\u202E", "\u200B"]) {
        const hidden = `${TOKEN.slice(0, at)}${mark}${TOKEN.slice(at)}`;
        const state = {
          status: "error",
          input: { command: `echo ${hidden}` },
          content: [{ type: "text", text: `token is ${hidden}` }],
          error: { message: `rejected ${hidden}` },
        };
        const shown = JSON.stringify(
          openCodeToolDetail("shell", shellPart(state), state, "failed"),
        );
        expect(shown).not.toContain(TOKEN);
        expect(shown).not.toContain(tail);
      }
    }
  });
});

describe("an output's preview", () => {
  it("keeps a short output whole", () => {
    expect(toolOutputPreview(lines(25))).toMatchObject({
      lineCount: 25,
      hiddenLineCount: 0,
      tail: "",
    });
  });

  it("shows the first and last lines and counts the lines between", () => {
    const preview = toolOutputPreview(lines(100));
    const head = CODING_SAFE_ACTIVITY_TOOL_OUTPUT_HEAD_LINES;
    const tail = CODING_SAFE_ACTIVITY_TOOL_OUTPUT_TAIL_LINES;
    expect(preview).toMatchObject({ lineCount: 100, hiddenLineCount: 100 - head - tail });
    expect(preview?.head.split("\n")).toHaveLength(head);
    expect(preview?.head.startsWith("line 1\n")).toBe(true);
    expect(preview?.tail.split("\n")).toHaveLength(tail);
    expect(preview?.tail.endsWith("line 100")).toBe(true);
    expect(isCodingSafeActivityToolPresentation({ output: preview })).toBe(true);
  });

  it("shows what a console line finally said and drops colour codes", () => {
    const raw = "\u001B[32mPASS\u001B[0m a.test.ts\r\nprogress 10%\rprogress 100%\n\n";
    expect(toolOutputPreview(raw)).toMatchObject({
      head: "PASS a.test.ts\nprogress 100%",
      lineCount: 2,
    });
  });

  it("drops every terminal sequence form, also one cut off at the end", () => {
    const esc = "\u001B";
    const link = `${esc}]8;;https://example.invalid${esc}\\docs${esc}]8;;${esc}\\`;
    const raw = [
      `${esc}[1;31mred${esc}[0m and ${esc}[?25lhidden cursor`,
      `title ${esc}]0;window\u0007done`,
      `link ${link}`,
      `${esc}7saved${esc}8 ${esc}Mup`,
      `cut ${esc}[38;5`,
      `open ${esc}]0;never closed`,
    ].join("\n");
    expect(toolOutputPreview(raw)?.head).toBe(
      ["red and hidden cursor", "title done", "link docs", "saved up", "cut ", "open "].join("\n"),
    );
  });

  it("drops terminal control strings whole, terminated or cut off at the line end", () => {
    const esc = "\u001B";
    const raw = [
      `a ${esc}Pq#0;2;0;0;0#0~~${esc}\\b`,
      `c ${esc}_app payload${esc}\\d`,
      `e ${esc}^privacy${esc}\\f ${esc}Xstring${esc}\\g`,
      `h ${esc}Pnever closed`,
      "next line",
    ].join("\n");
    expect(toolOutputPreview(raw)?.head).toBe(
      ["a b", "c d", "e f g", "h ", "next line"].join("\n"),
    );
  });

  it("trims a long blank prefix and suffix in linear time, and blank output to nothing", () => {
    const blank = "\n".repeat(1_000_000);
    expect(toolOutputPreview(`${blank}first\n  \nlast${blank}`)).toMatchObject({
      head: "first\n  \nlast",
      lineCount: 3,
    });
    expect(toolOutputPreview(" \n".repeat(1_000_000))).toBeUndefined();
    expect(toolOutputPreview("one\ntwo\n\n \n")).toMatchObject({ head: "one\ntwo", lineCount: 2 });
  });

  it("keeps what a line said before a trailing carriage return", () => {
    expect(toolOutputPreview("Downloading...\r\nDone\r")).toMatchObject({
      head: "Downloading...\nDone",
      lineCount: 2,
    });
  });

  it("bounds a single ten-megabyte line to one part without reading it twice", () => {
    const preview = toolOutputPreview("y".repeat(10 * 1024 * 1024));
    expect(preview).toMatchObject({ lineCount: 1, hiddenLineCount: 0, tail: "", truncated: true });
    expect(preview?.head).toHaveLength(CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS);
    expect(isCodingSafeActivityToolPresentation({ output: preview })).toBe(true);
  });

  it("is empty for blank output", () => {
    expect(toolOutputPreview("\n  \n")).toBeUndefined();
    expect(toolOutputPreview("")).toBeUndefined();
  });

  it("bounds each part on a whole character and marks the cut", () => {
    const long = `${"x".repeat(CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS - 1)}${EMOJI}tail`;
    const preview = toolOutputPreview(long);
    expect(preview?.truncated).toBe(true);
    expect(preview?.head.length).toBe(CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS - 1);
    expect(isCodingSafeActivityToolPresentation({ output: preview })).toBe(true);
  });
});

describe("a bounded tool text", () => {
  it("cuts on a whole character and is empty for blank text", () => {
    const max = CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS;
    const cut = boundedToolText(`${"a".repeat(max - 1)}${EMOJI}`, max);
    expect(cut).toEqual({ text: "a".repeat(max - 1), truncated: true });
    expect(boundedToolText("   ", max)).toBeUndefined();
  });

  it("never splits a surrogate pair at the error text's bound", () => {
    const max = CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS;
    const state = { status: "error", error: { message: `${"e".repeat(max - 1)}${EMOJI}rest` } };
    const detail = openCodeToolDetail("read", shellPart(state), state, "failed");
    expect(detail.errorText).toEqual({ text: "e".repeat(max - 1), truncated: true });
    expect(isCodingSafeActivityToolPresentation(detail)).toBe(true);
  });

  it("drops invisible format characters", () => {
    expect(boundedToolText("rm\u202e -rf", 100)?.text).toBe("rm -rf");
  });
});

describe("the deployment's own secrets in a live update", () => {
  const SECRET = "fixture-deployment-secret-2026";

  it("redacts them from every text and keeps the rest", () => {
    const presentation = {
      exitCode: 1,
      command: { text: `echo ${SECRET}`, truncated: false },
      errorText: { text: `bad ${SECRET}`, truncated: false },
      output: { head: SECRET, tail: "", lineCount: 1, hiddenLineCount: 0, truncated: false },
    };
    const redacted = redactToolTexts(presentation, [SECRET]);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted).toMatchObject({ exitCode: 1, command: { text: "echo [REDACTED]" } });
    expect(isCodingSafeActivityToolPresentation(redacted)).toBe(true);
  });

  it("removes the start of a secret that the source's cut split", () => {
    const max = CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS;
    // The cut at the bound left the secret's first five characters at the command's end.
    const cut = `${"a".repeat(max - 5)}${SECRET.slice(0, 5)}`;
    const presentation = {
      command: { text: cut, truncated: true },
      output: {
        head: `ok ${SECRET.slice(0, 9)}`,
        tail: "",
        lineCount: 1,
        hiddenLineCount: 0,
        truncated: true,
      },
    };
    const redacted = redactToolTexts(presentation, [SECRET]);
    expect(redacted.command).toEqual({ text: "a".repeat(max - 5), truncated: true });
    expect(redacted.output?.head).toBe("ok ");
    expect(JSON.stringify(redacted)).not.toContain(SECRET.slice(0, 5));
  });

  it("leaves an uncut text that merely ends like a secret's start alone", () => {
    const presentation = { command: { text: `echo ${SECRET.slice(0, 4)}`, truncated: false } };
    expect(redactToolTexts(presentation, [SECRET])).toEqual(presentation);
    expect(withoutCutSecretStart("plain text", [SECRET])).toBe("plain text");
    expect(withoutCutSecretStart(`x${SECRET.slice(0, 1)}`, [SECRET])).toBe("x");
  });

  it("returns the same presentation when there is nothing to redact", () => {
    const presentation = { command: { text: "ls", truncated: false } };
    expect(redactToolTexts(presentation, [SECRET])).toEqual(presentation);
    expect(redactToolTexts(presentation, [])).toBe(presentation);
  });
});

// PERF-2: the pinned runtime keeps the start of a result longer than its cap, ends the content with
// a marker naming the lines kept and the whole output's lines, and sets `metadata.truncated`.
describe("a result the runtime shortened for the model", () => {
  const MARKER_PATH = "/private/state/home/.local/share/opencode/tool-output/tool_0123456789ab";
  const shortenedState = (head: string, total: number, kept: number): Record<string, unknown> => ({
    status: "completed",
    input: { command: "npm test" },
    metadata: { exit: 0, truncated: true, outputPath: MARKER_PATH },
    content: [
      { type: "text", text: head },
      {
        type: "text",
        text: `[showing lines 1-${String(kept)} of ${String(total)}; full output saved to ${MARKER_PATH}]`,
      },
    ],
  });

  it("reports the bytes and lines the model kept, and never the path", () => {
    const head = lines(380, "tap");
    const state = shortenedState(head, 200_000, 380);
    const detail = openCodeToolDetail("shell", shellPart(state), state, "succeeded");
    expect(detail.outputShortened).toEqual({
      keptBytes: Buffer.byteLength(head, "utf8"),
      keptLines: 380,
      totalLines: 200_000,
    });
    expect(isCodingSafeActivityToolPresentation(detail)).toBe(true);
    expect(JSON.stringify(detail.outputShortened)).not.toContain("tool-output");
  });

  it("keeps the byte count alone when the runtime stated no usable line counts", () => {
    const unstated = "head\n[output cut]";
    const noGain = "head\n[showing lines 1-9 of 9; full output saved to /p]";
    for (const [text, kept] of [
      [unstated, unstated],
      [noGain, "head"],
    ] as const) {
      const state = {
        status: "completed",
        metadata: { truncated: true },
        content: [{ type: "text", text }],
      };
      expect(shortenedOutput(state)).toEqual({ keptBytes: Buffer.byteLength(kept, "utf8") });
    }
  });

  it("states nothing for a result the runtime did not shorten", () => {
    for (const metadata of [{ truncated: false }, { exit: 0 }, undefined]) {
      const state = { status: "completed", metadata, content: [{ type: "text", text: "ok" }] };
      expect(shortenedOutput(state)).toBeUndefined();
      expect(openCodeToolDetail("shell", shellPart(state), state, "succeeded")).not.toHaveProperty(
        "outputShortened",
      );
    }
  });
});

describe("the output a shell streams while it runs and keeps when it is stopped", () => {
  const streamed = `${TOKEN}\nserve ready\ntick 1\ntick 2`;

  it.each(["running", "failed", "cancelled"] as const)(
    "shows the streamed output of a %s call with the credential floor applied",
    (displayState) => {
      const status = displayState === "running" ? "running" : "error";
      const state = { status, input: { command: "npm run serve" }, metadata: { output: streamed } };
      const detail = openCodeToolDetail("shell", shellPart(state), state, displayState);
      expect(detail.output?.lineCount).toBe(4);
      expect(detail.output?.head).toContain("serve ready\ntick 1\ntick 2");
      expect(JSON.stringify(detail)).not.toContain(TOKEN);
    },
  );

  it("prefers the finished result over the streamed copy and ignores a non-text value", () => {
    const done = {
      status: "completed",
      input: { command: "ls" },
      content: [{ type: "text", text: "final" }],
      metadata: { exit: 0, output: "streamed" },
    };
    expect(openCodeToolDetail("shell", shellPart(done), done, "succeeded").output?.head).toBe(
      "final",
    );
    const odd = { status: "running", input: { command: "ls" }, metadata: { output: 7 } };
    expect(openCodeToolDetail("shell", shellPart(odd), odd, "running")).not.toHaveProperty(
      "output",
    );
  });

  it("shows no streamed output for a tool that is not a shell", () => {
    const state = { status: "running", input: {}, metadata: { output: "file text" } };
    expect(openCodeToolDetail("read", shellPart(state), state, "running")).not.toHaveProperty(
      "output",
    );
  });
});

describe("a subagent call's agent, description and prompt (U-52)", () => {
  const secret = "fixture-deployment-secret-2026";
  const state = {
    status: "completed",
    input: {
      agent: "explore",
      description: "Count test files",
      prompt: `Count the test files. Token ${TOKEN}`,
    },
  };

  it("projects the agent and description as facts and the prompt as detail under the credential floor", () => {
    const detail = openCodeToolDetail("subagent", shellPart(state), state, "succeeded");
    expect(detail.agentName).toEqual({ text: "explore", truncated: false });
    expect(detail.taskDescription).toEqual({ text: "Count test files", truncated: false });
    expect(detail.taskPrompt?.text).toContain("Count the test files.");
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
    expect(isCodingSafeActivityToolPresentation(detail)).toBe(true);
  });

  it("bounds every text and leaves another tool's input alone", () => {
    const long = {
      status: "completed",
      input: { agent: "a".repeat(500), description: "d".repeat(900), prompt: "p".repeat(5_000) },
    };
    const detail = openCodeToolDetail("subagent", shellPart(long), long, "succeeded");
    expect(detail.agentName?.truncated).toBe(true);
    expect(detail.taskDescription?.truncated).toBe(true);
    expect(detail.taskPrompt?.truncated).toBe(true);
    expect(isCodingSafeActivityToolPresentation(detail)).toBe(true);
    const other = openCodeToolDetail("read", shellPart(state), state, "succeeded");
    expect(other).not.toHaveProperty("agentName");
  });

  it("redacts a deployment secret in all three texts", () => {
    const presentation = {
      agentName: { text: `x${secret}`, truncated: false },
      taskDescription: { text: `y ${secret}`, truncated: false },
      taskPrompt: { text: `z ${secret}`, truncated: false },
    };
    const redacted = redactToolTexts(presentation, [secret]);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(isCodingSafeActivityToolPresentation(redacted)).toBe(true);
  });
});

describe("what a Code Mode program does (U-56)", () => {
  const program = (code: string): ReturnType<typeof openCodeToolDetail> => {
    const state = { status: "completed", input: { code } };
    return openCodeToolDetail("execute", shellPart(state), state, "succeeded");
  };

  it.each([
    ["schedule", 'return await tools.automation.create({ name: "x" });'],
    ["schedule", "await tools.automation.delete({ id });"],
    ["command", 'return await tools.shell({ command: "ls" });'],
    ["tool", 'return await tools.fixture.echo({ text: "a" });'],
  ] as const)("reads %s from the called tool", (kind, code) => {
    expect(program(code).programKind).toBe(kind);
  });

  it.each([
    "return 1 + 1;",
    "return await tools.opencode.worktree_list({});",
    "return await tools.automation.list();",
    "const tools = []; return tools.map((tool) => tool);",
  ])("names no kind for a program that calls no governed tool: %s", (code) => {
    expect(program(code).programKind).toBeUndefined();
  });

  it.each([
    'return "tools.shell(";',
    "return 'tools.automation.create(';",
    "return `run tools.shell( now`;",
    "return typeof tools.automation.create;",
    "const f = tools.automation.delete; return typeof f;",
    "// tools.shell({ command: 'ls' })\nreturn 1;",
    "/* tools.fixture.echo({}) */ return 2;",
    "return `${1 + 1} tools.bash(`;",
    "return obj.tools.shell({});",
  ])("names no kind where the program only mentions a tool: %s", (code) => {
    expect(program(code).programKind).toBeUndefined();
  });

  it.each([
    ["command", 'const note = "x"; return await tools.shell({ command: `${"a"}` });'],
    ["schedule", "return `${await tools.automation.create({})}`;"],
    ["tool", 'return `a${`b${await tools.fixture.echo({ text: "c" })}`}`;'],
    ["command", 'return "it\\"s"; await tools.bash({});'],
  ] as const)("still reads %s from a call beside literals", (kind, code) => {
    expect(program(code).programKind).toBe(kind);
  });

  it("stops reading a program nested deeper than any real one", () => {
    const code = "`${".repeat(40) + "tools.shell({})" + "}`".repeat(40);
    expect(program(code).programKind).toBeUndefined();
  });

  it("carries only the closed kind, never the program's text", () => {
    const detail = program('return await tools.automation.create({ prompt: "SECRET_BODY" });');
    expect(JSON.stringify(detail)).not.toContain("SECRET_BODY");
  });

  it("names no kind on a tool that is not a program", () => {
    const state = { status: "completed", input: { code: "tools.automation.create({})" } };
    expect(openCodeToolDetail("read", shellPart(state), state, "succeeded")).not.toHaveProperty(
      "programKind",
    );
  });
});
