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

describe("an element with attributes that no tool parameter carries", () => {
  it("is ordinary XML, not a tool call", () => {
    const tools = toolIndex([
      { name: "task", parameters: { type: "object", properties: { description: {} } } },
    ]);
    expect(
      detectTextualToolCall('<task id="delivery">Quarterly planning</task>', tools),
    ).toBeUndefined();
    expect(detectTextualToolCall('<task description="Quarterly planning" />', tools)).toBeDefined();
  });
});

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
    foldDiscardedAttempt(tally, response);
    foldDiscardedAttempt(tally, response);
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

describe("a discarded response that already carries discarded attempts", () => {
  it("folds its nested attempts into the recovery tally", () => {
    const usage = {
      requestId: "fixture",
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      latencyMs: 1,
      costClass: "low" as const,
    };
    const tally = { attemptCount: 0, promptTokens: 0, completionTokens: 0 };
    foldDiscardedAttempt(tally, {
      usage,
      discardedAttemptUsage: { attemptCount: 2, promptTokens: 7, completionTokens: 3 },
    });
    expect(tally).toEqual({ attemptCount: 3, promptTokens: 17, completionTokens: 5 });
  });
});

describe("LiveTextHold", () => {
  it("holds an answer that begins with a tag naming an advertised tool", () => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push("<sh")).toBe("");
    expect(hold.push('ell command="x" />')).toBe("");
    expect(hold.isHolding).toBe(true);
    expect(hold.release()).toBe('<shell command="x" />');
    expect(hold.push("later")).toBe("later");
  });

  it("holds the observed plan-then-call answer and a wrapper tag from the first character", () => {
    const observed = new LiveTextHold(true, TOOLS);
    expect(observed.push(OBSERVED_ANSWER.slice(0, 20))).toBe("");
    expect(observed.push(OBSERVED_ANSWER.slice(20))).toBe("");
    expect(observed.release()).toBe(OBSERVED_ANSWER);
    const wrapper = new LiveTextHold(true, TOOLS);
    expect(wrapper.push("\n <tool_call>")).toBe("\n ");
    expect(wrapper.isHolding).toBe(true);
    const named = new LiveTextHold(true, TOOLS);
    expect(named.push("<function=shell>")).toBe("");
    expect(named.isHolding).toBe(true);
  });

  it("streams a plain prose answer once its first line has ended", () => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push("Running ")).toBe("");
    expect(hold.push("the tests now.\n")).toBe("");
    expect(hold.push("Done")).toBe("Running the tests now.\nDone");
    expect(hold.isHolding).toBe(false);
    expect(hold.push("<shell />\n```json\n{}\n```")).toBe("<shell />\n```json\n{}\n```");
  });

  it("streams a long first line without waiting for its newline", () => {
    const hold = new LiveTextHold(true, TOOLS);
    const line = "word ".repeat(40);
    expect(line.length).toBeGreaterThan(160);
    expect(hold.push(line.slice(0, 100))).toBe("");
    expect(hold.push(line.slice(100))).toBe(line);
    expect(hold.push(" more")).toBe(" more");
    expect(hold.isHolding).toBe(false);
  });

  it("holds a short preface together with the tool call that follows it", () => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push("Ok.")).toBe("");
    expect(hold.push('\n<shell command="ls" />')).toBe("");
    expect(hold.isHolding).toBe(true);
    expect(hold.push("\n")).toBe("");
    expect(hold.release()).toBe('Ok.\n<shell command="ls" />\n');
  });

  it("holds a preface followed by a fence or an object, and waits for a tag name to finish", () => {
    const fence = new LiveTextHold(true, TOOLS);
    expect(fence.push('Sure:\n```json\n{"name":"shell"}\n```')).toBe("");
    expect(fence.isHolding).toBe(true);
    const split = new LiveTextHold(true, TOOLS);
    expect(split.push("Ok.\n<s")).toBe("");
    expect(split.isHolding).toBe(false);
    expect(split.push("hell />")).toBe("");
    expect(split.isHolding).toBe(true);
  });

  it("releases a preface whose next line is not markup, as prose, at once", () => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push("Ok.\nHere is the plan:")).toBe("Ok.\nHere is the plan:");
    expect(hold.isHolding).toBe(false);
    const later = new LiveTextHold(true, TOOLS);
    expect(later.push("Ok.\n   \n\n")).toBe("");
    expect(later.push("then <div>")).toBe("Ok.\n   \n\nthen <div>");
  });

  it("streams an ordinary code block once its first content line is visible", () => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push("Here is the code:\n```js\n")).toBe("");
    expect(hold.push("const x = 1;")).toBe("Here is the code:\n```js\nconst x = 1;");
    expect(hold.isHolding).toBe(false);
    expect(hold.push("\n```")).toBe("\n```");
  });

  it("keeps holding a preface followed by a fenced or bare tool-call object", () => {
    const fenced = new LiveTextHold(true, TOOLS);
    expect(fenced.push('Ok.\n```json\n{"name":"shell",')).toBe("");
    expect(fenced.isHolding).toBe(true);
    const bare = new LiveTextHold(true, TOOLS);
    expect(bare.push('Ok.\n{\n  "tool": "shell"')).toBe("");
    expect(bare.isHolding).toBe(true);
    const tag = new LiveTextHold(true, TOOLS);
    expect(tag.push("Ok.\n```xml\n<shell command=")).toBe("");
    expect(tag.isHolding).toBe(true);
  });

  it("releases a fenced JSON block without a tool-call key once the lookahead is spent", () => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push("Data:\n```json\n{")).toBe("");
    const rows = '"a":1,'.repeat(40);
    expect(hold.push(rows)).toBe(`Data:\n\`\`\`json\n{${rows}`);
    expect(hold.isHolding).toBe(false);
  });

  it("releases a window that waits too long for the next line", () => {
    const hold = new LiveTextHold(true, TOOLS);
    const blanks = "\n".repeat(300);
    expect(hold.push("Ok." + blanks)).toBe("Ok." + blanks);
    expect(hold.push("x")).toBe("x");
  });

  it.each([
    ["a generic type", "List<string> is fine"],
    ["a markup tag that no tool is named after", "<div>hello</div>"],
    ["a comparison", "a < b"],
    ["an inline code span", "`npm test` runs it"],
    ["a closing tag that no tool is named after", "</div>"],
  ])("does not hold an answer that begins with %s past its first line", (_label, answer) => {
    const hold = new LiveTextHold(true, TOOLS);
    expect(hold.push(`${answer}\nnext`)).toBe(`${answer}\nnext`);
    expect(hold.isHolding).toBe(false);
  });

  it("carries a tag name or a fence that is still arriving until the next characters decide", () => {
    const comparison = new LiveTextHold(true, TOOLS);
    expect(comparison.push("<")).toBe("");
    expect(comparison.push(" b\nok")).toBe("< b\nok");
    expect(comparison.isHolding).toBe(false);
    const html = new LiveTextHold(true, TOOLS);
    expect(html.push("<s")).toBe("");
    expect(html.push("tyle>\nok")).toBe("<style>\nok");
    const fence = new LiveTextHold(true, TOOLS);
    expect(fence.push("``")).toBe("");
    expect(fence.push("`json")).toBe("");
    expect(fence.isHolding).toBe(true);
    const code = new LiveTextHold(true, TOOLS);
    expect(code.push("`")).toBe("");
    expect(code.push("x` is\nok")).toBe("`x` is\nok");
    const closing = new LiveTextHold(true, TOOLS);
    expect(closing.push("<")).toBe("");
    expect(closing.release()).toBe("<");
  });

  it("holds an answer that begins with a JSON object, an array or a code fence", () => {
    const braces = new LiveTextHold(true, TOOLS);
    expect(braces.push("\n{")).toBe("\n");
    expect(braces.isHolding).toBe(true);
    const array = new LiveTextHold(true, TOOLS);
    expect(array.push("[")).toBe("");
    const fence = new LiveTextHold(true, TOOLS);
    expect(fence.push("```json")).toBe("");
    expect(fence.isHolding).toBe(true);
  });

  it("streams a brace, a fence or an inline backtick that follows a long first line", () => {
    const line = "a long first line of prose ".repeat(8);
    const braces = new LiveTextHold(true, TOOLS);
    expect(braces.push(line)).toBe(line);
    expect(braces.push("\n{")).toBe("\n{");
    expect(braces.isHolding).toBe(false);
    const fence = new LiveTextHold(true, TOOLS);
    expect(fence.push(`${line}\n\`\`\`x\n\`\`\``)).toBe(`${line}\n\`\`\`x\n\`\`\``);
  });

  it("passes everything through when disabled and after the hold is released by size", () => {
    const off = new LiveTextHold(false, TOOLS);
    expect(off.push("<shell />")).toBe("<shell />");
    const bounded = new LiveTextHold(true, TOOLS);
    expect(bounded.push("<shell ")).toBe("");
    const flood = "x".repeat(TEXTUAL_TOOL_CALL_HOLD_LIMIT_CHARS);
    expect(bounded.push(flood)).toBe(`<shell ${flood}`);
    expect(bounded.push("<more")).toBe("<more");
  });

  it("discards what it held when restarted for the next attempt", () => {
    const hold = new LiveTextHold(true, TOOLS);
    hold.push("<shell />");
    hold.restart(true);
    expect(hold.isHolding).toBe(false);
    expect(hold.release()).toBe("");
    hold.restart(true);
    expect(hold.push("plain\nmore")).toBe("plain\nmore");
    hold.restart(true);
    expect(hold.push("<shell />")).toBe("");
  });
});
