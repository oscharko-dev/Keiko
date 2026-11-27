import { describe, expect, it } from "vitest";
import {
  detectTextualToolCall,
  foldDiscardedAttempt,
  LiveTextHold,
  TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS,
  TEXTUAL_TOOL_CALL_RETRY_HINT,
  textualToolCallForm,
  toolNameSet,
  withDiscardedAttempts,
  withTextualToolCallHint,
} from "./coding-textual-tool-call.js";

const TOOLS = toolNameSet(["read", "edit", "shell", "todo", "Bash"]);

describe("detectTextualToolCall", () => {
  it.each([
    [
      "an XML element named after a tool (the live Gemma turn)",
      `<todo> <todo content="Verify the fix by running npm test" status="in_progress"/> </todo>\n<shell command="npm test | tail -n 1" />`,
      "named-element",
    ],
    [
      "an attribute value that contains a closing angle bracket",
      `<shell command="a > b" />`,
      "named-element",
    ],
    [
      "a tool_call wrapper around a JSON call",
      `<tool_call>\n{"name": "shell", "arguments": {"command": "npm test"}}\n</tool_call>`,
      "wrapper-element",
    ],
    [
      "a function tag with parameters",
      `<function=shell>\n<parameter=command>npm test</parameter>\n</function>`,
      "function-tag",
    ],
    [
      "a fenced JSON call",
      '```json\n{"name":"edit","arguments":{"filePath":"a.ts"}}\n```',
      "json-call",
    ],
    [
      "a bare OpenAI-shaped JSON call",
      `{"type":"function","function":{"name":"bash","arguments":{}}}`,
      "json-call",
    ],
    ["a mixed-case tool name", `<BASH command="ls"/>`, "named-element"],
    ["a short lead-in before the markup", `Run.\n<shell command="npm test" />`, "named-element"],
  ])("detects %s", (_label, text, form) => {
    expect(detectTextualToolCall(text, TOOLS)).toBe(form);
  });

  it.each([
    [
      "prose that mentions a div",
      "Use a <div> element for the wrapper, then style the <span> inside it.",
    ],
    [
      "a code block with XML",
      'Here is the markup:\n```xml\n<div class="a"><span>hi</span></div>\n```\nIt renders a box.',
    ],
    ["markup naming an unknown tool", `<launch_missiles target="x" />`],
    [
      "a wrapper naming an unknown tool",
      `<tool_call>{"name":"unknown","arguments":{}}</tool_call>`,
    ],
    ["a JSON call to an unknown tool", '```json\n{"name":"unknown","arguments":{}}\n```'],
    ["JSON that is not a call", '```json\n{"name":"shell","note":"x"}\n```'],
    [
      "prose that merely names a tag in a long answer",
      `The ${"explanation goes on and on. ".repeat(20)} Remember that <shell> is the tool.`,
    ],
    ["empty text", "   "],
  ])("does not detect %s", (_label, text) => {
    expect(detectTextualToolCall(text, TOOLS)).toBeUndefined();
  });

  it("never detects without an advertised tool", () => {
    expect(detectTextualToolCall(`<shell command="ls" />`, toolNameSet([]))).toBeUndefined();
  });

  it("does not analyse an answer longer than a tool call can be", () => {
    expect(
      detectTextualToolCall(`<shell command="ls" />${" ".repeat(40_000)}x`, TOOLS),
    ).toBeUndefined();
  });
});

describe("textualToolCallForm", () => {
  const markup = `<shell command="ls" />`;
  const base = { content: markup, finishReason: "stop" as const, toolCalls: [] };

  it("requires a normal finish with no native tool call", () => {
    expect(textualToolCallForm(base, TOOLS)).toBe("named-element");
    expect(textualToolCallForm({ ...base, finishReason: "length" }, TOOLS)).toBeUndefined();
    expect(
      textualToolCallForm(
        { ...base, toolCalls: [{ id: "c", name: "shell", arguments: {} }] },
        TOOLS,
      ),
    ).toBeUndefined();
  });
});

describe("withTextualToolCallHint", () => {
  it("appends the fixed correction and keeps the original request", () => {
    const original = { modelId: "m", messages: [{ role: "user" as const, content: "hi" }] };
    const hinted = withTextualToolCallHint(original);
    expect(hinted.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "system", content: TEXTUAL_TOOL_CALL_RETRY_HINT },
    ]);
    expect(original.messages).toHaveLength(1);
  });
});

describe("withDiscardedAttempts", () => {
  const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };
  const response = {
    modelId: "m",
    content: "ok",
    finishReason: "stop" as const,
    toolCalls: [],
    structuredOutput: null,
    usage,
  };

  it("counts the discarded attempts beside the answer's own", () => {
    const tally = { attemptCount: 0, promptTokens: 0, completionTokens: 0 };
    expect(withDiscardedAttempts(response, tally)).toBe(response);
    foldDiscardedAttempt(tally, usage);
    foldDiscardedAttempt(tally, usage);
    expect(
      withDiscardedAttempts(
        {
          ...response,
          discardedAttemptUsage: { attemptCount: 1, promptTokens: 5, completionTokens: 1 },
        },
        tally,
      ).discardedAttemptUsage,
    ).toEqual({ attemptCount: 3, promptTokens: 25, completionTokens: 9 });
  });
});

describe("LiveTextHold", () => {
  it("streams prose through and holds from the first markup start", () => {
    const hold = new LiveTextHold(true);
    expect(hold.push("Running ")).toBe("Running ");
    expect(hold.push("the tests: <sh")).toBe("the tests: ");
    expect(hold.isHolding).toBe(true);
    expect(hold.push('ell command="x" />')).toBe("");
    expect(hold.release()).toBe('<shell command="x" />');
    expect(hold.push("later")).toBe("later");
  });

  it("holds a line-leading JSON object and a code fence but not an inline brace", () => {
    const braces = new LiveTextHold(true);
    expect(braces.push("a {b} c")).toBe("a {b} c");
    expect(braces.push("\n{")).toBe("\n");
    const fence = new LiveTextHold(true);
    expect(fence.push("```json")).toBe("");
    const inline = new LiveTextHold(true);
    expect(inline.push("Run `npm test` now")).toBe("Run `npm test` now");
  });

  it("passes everything through when disabled and after the hold is released by size", () => {
    const off = new LiveTextHold(false);
    expect(off.push("<shell />")).toBe("<shell />");
    const bounded = new LiveTextHold(true);
    expect(bounded.push("<")).toBe("");
    const flood = "x".repeat(TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS);
    expect(bounded.push(flood)).toBe(`<${flood}`);
    expect(bounded.push("<more")).toBe("<more");
  });

  it("discards what it held when restarted for the next attempt", () => {
    const hold = new LiveTextHold(true);
    hold.push("<shell />");
    hold.restart(true);
    expect(hold.isHolding).toBe(false);
    expect(hold.release()).toBe("");
    hold.restart(true);
    expect(hold.push("plain")).toBe("plain");
  });
});
