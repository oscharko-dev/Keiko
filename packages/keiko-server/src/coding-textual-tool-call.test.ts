import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENCODE_PINNED_VERSION } from "./coding-runtime/opencodeToolSchemas.js";
import {
  detectTextualToolCall,
  foldDiscardedAttempt,
  LiveTextHold,
  TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS,
  TEXTUAL_TOOL_CALL_RETRY_HINT,
  textualToolCallForm,
  toolIndex,
  withDiscardedAttempts,
  withTextualToolCallHint,
} from "./coding-textual-tool-call.js";

// The REAL catalog the native sidecar sees: the tool names and parameter schemas of the pinned
// OpenCode advertisement (`todowrite`, not `todo`; `path`, not `filePath`).
const REAL_TOOLS = JSON.parse(
  readFileSync(
    new URL(
      `./coding-runtime/opencodeToolSchemas.opencode-${OPENCODE_PINNED_VERSION}-advertised.fixture.json`,
      import.meta.url,
    ),
    "utf8",
  ),
) as readonly { readonly name: string; readonly parameters: Record<string, unknown> }[];
const TOOLS = toolIndex(REAL_TOOLS);

// The answer observed live (M-1, Gemma 4 31B): a plan written as `<todo>` elements, then the call.
const OBSERVED_ANSWER = `<todo> <todo content="Verify the fix by running npm test" status="in_progress"/> <todo content="Commit the fix" status="pending"/> </todo>\n<shell command="npm test | tail -n 1" />`;

describe("detectTextualToolCall", () => {
  it.each([
    ["an XML element named after a tool (the live Gemma turn)", OBSERVED_ANSWER, "named-element"],
    [
      "an attribute value that contains a closing angle bracket",
      `<shell command="a > b" />`,
      "named-element",
    ],
    [
      "an element whose body names a parameter",
      `<edit>\n<path>a.ts</path>\n<oldString>x</oldString>\n</edit>`,
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
      "an unlabelled fence that is the whole answer",
      '```\n{"name":"edit","arguments":{"path":"a.ts"}}\n```',
      "json-call",
    ],
    [
      "a bare OpenAI-shaped JSON call",
      `{"type":"function","function":{"name":"shell","arguments":{}}}`,
      "json-call",
    ],
    ["a mixed-case tool name", `<SHELL command="ls"/>`, "named-element"],
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
    ["a JSON call to an unknown tool", '```\n{"name":"unknown","arguments":{}}\n```'],
    ["JSON that is not a call", '```\n{"name":"shell","note":"x"}\n```'],
    [
      "a json-labelled fence showing a call, even as the whole answer",
      '```json\n{"name":"shell","arguments":{"command":"ls"}}\n```',
    ],
    [
      "a one-line json fence showing a call",
      '```json {"name":"shell","arguments":{"command":"ls"}}```',
    ],
    [
      "a tool element inside an xml fence among prose",
      'Call it like this:\n```xml\n<read path="a.ts"/>\n```',
    ],
    [
      "a tool element inside a fence that is not the whole answer",
      '```xml\n<read path="a.ts"/>\n```\nThat reads the file.',
    ],
    [
      "an explanation of a tool call",
      `To read a file, the model writes <read path="src/a.ts" /> and the runtime answers with the content of that file, which it then reads.`,
    ],
    ["a prompt template", `<subagent>Summarise the repository</subagent>`],
    [
      "a plan element beside no call",
      `<todo content="Verify the fix" status="in_progress"/> <todo content="Commit" status="pending"/>`,
    ],
    ["a case-folding answer that is prose", `İİİ ${"x".repeat(50)} <SHELL> is a tool`],
    ["a bare tool-named tag", `<shell>`],
    ["an empty tool-named element", `<read/>`],
    [
      "prose that merely names a tag in a long answer",
      `The ${"explanation goes on and on. ".repeat(20)} Remember that <shell command="x"/> is the tool.`,
    ],
    ["a short lead-in beside the markup", `Let me run the tests.\n<shell command="npm test" />`],
    ["empty text", "   "],
  ])("does not detect %s", (_label, text) => {
    expect(detectTextualToolCall(text, TOOLS)).toBeUndefined();
  });

  it("counts the plan elements beside a call, and only beside one", () => {
    const plan = `<todo content="Verify" status="pending"/>\n<shell command="npm test" />`;
    expect(detectTextualToolCall(plan, TOOLS)).toBe("named-element");
    expect(detectTextualToolCall(OBSERVED_ANSWER, toolIndex([]))).toBeUndefined();
  });

  it("keeps indexes aligned when lower-casing would change the length", () => {
    expect(
      detectTextualToolCall(`İİİİİİİİİİİİİİİİİİİİİİİİİİİİ <shell command="ls" />`, TOOLS),
    ).toBeUndefined();
    expect(detectTextualToolCall(`<SHELL COMMAND="ls" />`, TOOLS)).toBe("named-element");
  });

  it("never detects without an advertised tool", () => {
    expect(detectTextualToolCall(`<shell command="ls" />`, toolIndex([]))).toBeUndefined();
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
  const tool = (content: string): { role: "tool"; content: string; toolCallId: string } => ({
    role: "tool",
    content,
    toolCallId: "c",
  });

  it("appends the correction to the last message and keeps every earlier byte", () => {
    const original = {
      messages: [
        { role: "system" as const, content: "Be brief." },
        { role: "user" as const, content: "hi" },
        tool("result"),
      ],
    };
    const hinted = withTextualToolCallHint(original);
    expect(hinted.messages.slice(0, -1)).toEqual(original.messages.slice(0, -1));
    expect(hinted.messages.at(-1)).toEqual({
      role: "tool",
      content: `result\n\n${TEXTUAL_TOOL_CALL_RETRY_HINT}`,
      toolCallId: "c",
    });
    expect(hinted.messages).toHaveLength(original.messages.length);
    expect(original.messages[2]?.content).toBe("result");
  });

  it("appends to a last user message without adding a second consecutive user message", () => {
    const hinted = withTextualToolCallHint({
      messages: [{ role: "user" as const, content: "hi" }],
    });
    expect(hinted.messages).toEqual([
      { role: "user", content: `hi\n\n${TEXTUAL_TOOL_CALL_RETRY_HINT}` },
    ]);
  });

  it("adds a short user message after a last message that cannot carry text", () => {
    const hinted = withTextualToolCallHint({
      messages: [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "partial" },
      ],
    });
    expect(hinted.messages.at(-1)).toEqual({ role: "user", content: TEXTUAL_TOOL_CALL_RETRY_HINT });
    expect(hinted.messages).toHaveLength(3);
  });
});

describe("withDiscardedAttempts", () => {
  const usage = {
    requestId: "fixture",
    promptTokens: 10,
    completionTokens: 4,
    latencyMs: 1,
    costClass: "low" as const,
  };
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
  it("streams prose through and holds from the first tag start", () => {
    const hold = new LiveTextHold(true);
    expect(hold.push("Running ")).toBe("Running ");
    expect(hold.push("the tests: <sh")).toBe("the tests: ");
    expect(hold.isHolding).toBe(true);
    expect(hold.push('ell command="x" />')).toBe("");
    expect(hold.release()).toBe('<shell command="x" />');
    expect(hold.push("later")).toBe("later");
  });

  it("does not hold a comparison or a generic", () => {
    const hold = new LiveTextHold(true);
    expect(hold.push("if a < b and x<3 then ")).toBe("if a < b and x<3 then ");
    expect(hold.push("List<string> is fine")).toBe("List");
    expect(hold.isHolding).toBe(true);
  });

  it("carries a trailing angle bracket until its next character decides", () => {
    const comparison = new LiveTextHold(true);
    expect(comparison.push("a <")).toBe("a ");
    expect(comparison.push(" b")).toBe("< b");
    expect(comparison.isHolding).toBe(false);
    const tag = new LiveTextHold(true);
    expect(tag.push("go <")).toBe("go ");
    expect(tag.push("shell />")).toBe("");
    expect(tag.release()).toBe("<shell />");
    const closing = new LiveTextHold(true);
    expect(closing.push("end <")).toBe("end ");
    expect(closing.release()).toBe("<");
  });

  it("holds a line-leading JSON object and a code fence but not an inline brace or backtick", () => {
    const braces = new LiveTextHold(true);
    expect(braces.push("a {b} c")).toBe("a {b} c");
    expect(braces.push("\n{")).toBe("\n");
    const fence = new LiveTextHold(true);
    expect(fence.push("```json")).toBe("");
    const inline = new LiveTextHold(true);
    expect(inline.push("Run `npm test` now")).toBe("Run `npm test` now");
    const afterProse = new LiveTextHold(true);
    expect(afterProse.push('Sure: {"a":1} and ```x```')).toBe('Sure: {"a":1} and ```x```');
  });

  it("passes everything through when disabled and after the hold is released by size", () => {
    const off = new LiveTextHold(false);
    expect(off.push("<shell />")).toBe("<shell />");
    const bounded = new LiveTextHold(true);
    expect(bounded.push("<a")).toBe("");
    const flood = "x".repeat(TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS);
    expect(bounded.push(flood)).toBe(`<a${flood}`);
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
