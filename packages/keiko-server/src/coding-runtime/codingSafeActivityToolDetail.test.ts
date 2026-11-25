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
  stateFailureOrigin,
  toolOutputPreview,
  withoutCutSecretStart,
} from "./codingSafeActivityToolDetail.js";

// An issuer-format token the credential floor removes from every text a person reads.
const TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
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

  it("falls back to the closed state for a producer that named none", () => {
    expect(stateFailureOrigin("failed", 1)).toBe("command-failed");
    expect(stateFailureOrigin("failed", 0)).toBe("tool-error");
    expect(stateFailureOrigin("failed", undefined)).toBe("tool-error");
    expect(stateFailureOrigin("denied", undefined)).toBe("keiko-refused");
    expect(stateFailureOrigin("cancelled", undefined)).toBe("cancelled");
    expect(stateFailureOrigin("succeeded", undefined)).toBeUndefined();
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
    expect(boundedToolText("rm‮ -rf", 100)?.text).toBe("rm -rf");
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
      output: { head: `ok ${SECRET.slice(0, 9)}`, tail: "", lineCount: 1, hiddenLineCount: 0, truncated: true },
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
