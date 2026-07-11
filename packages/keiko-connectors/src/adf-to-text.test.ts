// ADF-to-text converter tests (Issue #2243). Golden output per node type, hostile-input
// degradation, purity/determinism (byte-identical repeat runs), and depth/node/output caps at
// their exact boundary values. Hermetic and clock-free except the explicit wall-clock bound on
// the 10k-node hostile corpus, which the acceptance criteria demand.

import { describe, expect, it } from "vitest";
import {
  ADF_TO_TEXT_MAX_DEPTH,
  ADF_TO_TEXT_MAX_NODES,
  ADF_TO_TEXT_MAX_OUTPUT_CHARS,
  convertAdfToText,
} from "./adf-to-text.js";

type Json = Record<string, unknown>;

function doc(...content: Json[]): Json {
  return { type: "doc", version: 1, content };
}

function p(...content: (Json | string)[]): Json {
  return {
    type: "paragraph",
    content: content.map((entry) => (typeof entry === "string" ? text(entry) : entry)),
  };
}

function text(value: string, marks?: readonly Json[]): Json {
  return { type: "text", text: value, ...(marks === undefined ? {} : { marks }) };
}

function expectText(value: unknown, expected: string): void {
  const outcome = convertAdfToText(value);
  expect(outcome.text).toBe(expected);
  expect(outcome.truncated).toBe(false);
}

describe("convertAdfToText — golden output per node type", () => {
  it("renders paragraphs joined by blank lines", () => {
    expectText(doc(p("First."), p("Second.")), "First.\n\nSecond.");
  });

  it("renders headings with a #-per-level prefix, clamping hostile levels", () => {
    expectText(doc({ type: "heading", attrs: { level: 2 }, content: [text("Title")] }), "## Title");
    expectText(doc({ type: "heading", content: [text("Title")] }), "# Title");
    expectText(
      doc({ type: "heading", attrs: { level: 99 }, content: [text("Deep")] }),
      "###### Deep",
    );
  });

  it("renders strong/em/code marks as plain text — no markdown injection", () => {
    const body = p(
      text("plain "),
      text("bold", [{ type: "strong" }]),
      text(" and ", [{ type: "em" }]),
      text("x=1", [{ type: "code" }]),
    );
    expectText(doc(body), "plain bold and x=1");
  });

  it("renders link marks as `text (href)` and collapses href-equal or empty text", () => {
    const href = "https://example.test/docs";
    expectText(doc(p(text("Docs", [{ type: "link", attrs: { href } }]))), `Docs (${href})`);
    expectText(doc(p(text(href, [{ type: "link", attrs: { href } }]))), href);
    expectText(doc(p(text("", [{ type: "link", attrs: { href } }]))), href);
  });

  it("drops unbounded link hrefs instead of inflating output", () => {
    const href = `https://example.test/${"a".repeat(3000)}`;
    expectText(doc(p(text("Docs", [{ type: "link", attrs: { href } }]))), "Docs");
  });

  it("renders hard breaks as newlines inside a paragraph", () => {
    expectText(doc(p(text("a"), { type: "hardBreak" }, text("b"))), "a\nb");
  });

  it("renders nested bullet lists with marker-width indentation", () => {
    const nested = {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            p("Parent"),
            { type: "bulletList", content: [{ type: "listItem", content: [p("Child")] }] },
          ],
        },
        { type: "listItem", content: [p("Second")] },
      ],
    };
    expectText(doc(nested), "- Parent\n  - Child\n- Second");
  });

  it("renders ordered lists honouring the start attribute", () => {
    const list = (order?: number): Json => ({
      type: "orderedList",
      ...(order === undefined ? {} : { attrs: { order } }),
      content: [
        { type: "listItem", content: [p("First")] },
        { type: "listItem", content: [p("Second")] },
      ],
    });
    expectText(doc(list()), "1. First\n2. Second");
    expectText(doc(list(3)), "3. First\n4. Second");
  });

  it("linearizes tables one row per line with ` | ` separators, flattening cell blocks", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [p("Name")] },
            { type: "tableHeader", content: [p("Role")] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [p("Alice"), p("Example")] },
            { type: "tableCell", content: [p("Admin")] },
          ],
        },
      ],
    };
    expectText(doc(table), "Name | Role\nAlice Example | Admin");
  });

  it("renders fenced code blocks with and without a language", () => {
    expectText(
      doc({ type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1;")] }),
      "```ts\nconst x = 1;\n```",
    );
    expectText(doc({ type: "codeBlock", content: [text("plain")] }), "```\nplain\n```");
  });

  it("prefixes every blockquote line, including blank separator lines", () => {
    expectText(
      doc({ type: "blockquote", content: [p("First"), p("Second")] }),
      "> First\n> \n> Second",
    );
  });

  it("renders rules as --- separators between blocks", () => {
    expectText(doc(p("Above"), { type: "rule" }, p("Below")), "Above\n\n---\n\nBelow");
  });

  it("renders mentions from display text, id fallback, then a readable placeholder", () => {
    expectText(doc(p({ type: "mention", attrs: { id: "5", text: "@Alice" } })), "@Alice");
    expectText(doc(p({ type: "mention", attrs: { id: "abc123" } })), "@abc123");
    expectText(doc(p({ type: "mention" })), "[mention]");
  });

  it("renders emoji from text, shortname fallback, then a readable placeholder", () => {
    expectText(doc(p({ type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } })), "🎉");
    expectText(doc(p({ type: "emoji", attrs: { shortName: ":tada:" } })), ":tada:");
    expectText(doc(p({ type: "emoji" })), "[emoji]");
  });

  it("renders status text and empty fallback", () => {
    expectText(doc(p({ type: "status", attrs: { text: "In Progress" } })), "In Progress");
    expectText(doc(p(text("a"), { type: "status" })), "a");
  });

  it("renders date nodes as UTC ISO dates with invalid-timestamp fallback", () => {
    expectText(doc(p({ type: "date", attrs: { timestamp: "0" } })), "1970-01-01");
    expectText(doc(p({ type: "date", attrs: { timestamp: 1000000000000 } })), "2001-09-09");
    expectText(doc(p(text("x"), { type: "date", attrs: { timestamp: "nonsense" } })), "x");
    expectText(doc(p(text("x"), { type: "date", attrs: { timestamp: "" } })), "x");
  });

  it("renders inline/block cards as their URL with a readable placeholder fallback", () => {
    expectText(
      doc(p({ type: "inlineCard", attrs: { url: "https://x.test/page" } })),
      "https://x.test/page",
    );
    expectText(doc({ type: "blockCard" }), "[card]");
    expectText(
      doc(p({ type: "inlineCard", attrs: { url: `https://x.test/${"a".repeat(3000)}` } })),
      "[card]",
    );
  });

  it("renders panels as their content and expands with their title", () => {
    expectText(
      doc({ type: "panel", attrs: { panelType: "info" }, content: [p("Note body")] }),
      "Note body",
    );
    expectText(
      doc({ type: "expand", attrs: { title: "More" }, content: [p("Hidden")] }),
      "More\nHidden",
    );
    expectText(doc({ type: "expand", content: [p("Hidden")] }), "Hidden");
  });

  it("renders media containers as readable placeholders with alt text when present", () => {
    expectText(
      doc({ type: "mediaSingle", content: [{ type: "media", attrs: { alt: "diagram" } }] }),
      "[media: diagram]",
    );
    expectText(
      doc({ type: "mediaGroup", content: [{ type: "media" }, { type: "media" }] }),
      "[media]\n[media]",
    );
    expectText(doc({ type: "mediaGroup" }), "[media]");
  });

  it("renders task lists with checkbox prefixes by task state", () => {
    const tasks = {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { state: "DONE" }, content: [text("Done task")] },
        { type: "taskItem", attrs: { state: "TODO" }, content: [text("Open task")] },
      ],
    };
    expectText(doc(tasks), "[x] Done task\n[ ] Open task");
  });

  it("renders decision lists with a Decision prefix", () => {
    const decisions = {
      type: "decisionList",
      content: [{ type: "decisionItem", content: [text("Choose Postgres")] }],
    };
    expectText(doc(decisions), "Decision: Choose Postgres");
  });
});

describe("convertAdfToText — hostile input degradation", () => {
  it("degrades unknown node types to their concatenated content and reports bounded type names", () => {
    const outcome = convertAdfToText(
      doc({ type: "extension-weird", content: [text("inner "), text("bits")] }),
    );
    expect(outcome.text).toBe("inner bits");
    expect(outcome.truncated).toBe(false);
    expect(outcome.unknownNodeTypes).toStrictEqual(["extension-weird"]);
  });

  it("reports invalid-type for nodes without a string type and clamps hostile type names", () => {
    const longType = "z".repeat(500);
    const outcome = convertAdfToText(doc({ content: [text("kept")] }, { type: longType }));
    expect(outcome.text).toBe("kept");
    expect(outcome.unknownNodeTypes).toContain("invalid-type");
    expect(outcome.unknownNodeTypes.some((name) => name.length <= 60)).toBe(true);
    expect(outcome.unknownNodeTypes.every((name) => name.length <= 60)).toBe(true);
  });

  it("classifies doc shapes: v1 doc, unknown version (still converted), and not-a-doc", () => {
    expect(convertAdfToText(doc(p("ok"))).docShape).toBe("doc");
    const v2 = convertAdfToText({ type: "doc", version: 2, content: [p("still readable")] });
    expect(v2.docShape).toBe("unknown-version");
    expect(v2.text).toBe("still readable");
    expect(convertAdfToText(null).docShape).toBe("not-a-doc");
    expect(convertAdfToText("plain").docShape).toBe("not-a-doc");
    expect(convertAdfToText([p("x")]).docShape).toBe("not-a-doc");
    const bareNode = convertAdfToText(p("bare paragraph"));
    expect(bareNode.docShape).toBe("not-a-doc");
    expect(bareNode.text).toBe("bare paragraph");
  });

  it("never throws on malformed nodes and renders them as empty text", () => {
    expect(convertAdfToText(doc({ type: "text" }, { type: "paragraph", content: "x" })).text).toBe(
      "",
    );
    expect(convertAdfToText(undefined).text).toBe("");
    expect(convertAdfToText(42).text).toBe("");
  });

  it("terminates a programmatically self-referencing node graph via the depth cap", () => {
    const cyclic: Json = { type: "paragraph", content: [] };
    (cyclic.content as unknown[]).push(cyclic);
    const outcome = convertAdfToText({ type: "doc", version: 1, content: [cyclic] });
    expect(outcome.truncated).toBe(true);
    expect(outcome.truncationReasons).toContain("depth-exceeded");
  });
});

// The innermost text of `depth` nested blockquotes sits at node depth `depth + 2` (paragraph and
// text below the last quote), so `ADF_TO_TEXT_MAX_DEPTH - 2` quotes is the deepest fully-rendered
// shape and one more quote must trip the cap.
function nestedQuotes(count: number): Json {
  let node: Json = p("innermost");
  for (let index = 0; index < count; index += 1) {
    node = { type: "blockquote", content: [node] };
  }
  return doc(node);
}

function hostileBreadthDoc(nodeCount: number): Json {
  // One text node per paragraph: each paragraph costs 2 nodes; the doc itself costs 1.
  const paragraphs = Math.floor((nodeCount - 1) / 2);
  return doc(...Array.from({ length: paragraphs }, (_, index) => p(`n${String(index)}`)));
}

describe("convertAdfToText — caps at boundary values", () => {
  it("renders at exactly the depth cap and truncates one level beyond it", () => {
    const within = convertAdfToText(nestedQuotes(ADF_TO_TEXT_MAX_DEPTH - 2));
    expect(within.truncated).toBe(false);
    expect(within.text.endsWith("innermost")).toBe(true);
    const beyond = convertAdfToText(nestedQuotes(ADF_TO_TEXT_MAX_DEPTH - 1));
    expect(beyond.truncated).toBe(true);
    expect(beyond.truncationReasons).toStrictEqual(["depth-exceeded"]);
  });

  it("renders at exactly the node budget and truncates one node beyond it", () => {
    const textNodes = ADF_TO_TEXT_MAX_NODES - 1;
    const atBudget = convertAdfToText(doc(...Array.from({ length: textNodes }, () => text("a"))));
    expect(atBudget.truncated).toBe(false);
    const beyond = convertAdfToText(doc(...Array.from({ length: textNodes + 1 }, () => text("a"))));
    expect(beyond.truncated).toBe(true);
    expect(beyond.truncationReasons).toStrictEqual(["node-budget-exceeded"]);
  });

  it("renders at exactly the output cap and hard-truncates one character beyond it", () => {
    const atCap = convertAdfToText(doc(p("a".repeat(ADF_TO_TEXT_MAX_OUTPUT_CHARS))));
    expect(atCap.truncated).toBe(false);
    expect(atCap.text).toHaveLength(ADF_TO_TEXT_MAX_OUTPUT_CHARS);
    const beyond = convertAdfToText(doc(p("a".repeat(ADF_TO_TEXT_MAX_OUTPUT_CHARS + 1))));
    expect(beyond.truncated).toBe(true);
    expect(beyond.truncationReasons).toStrictEqual(["output-budget-exceeded"]);
    expect(beyond.text).toHaveLength(ADF_TO_TEXT_MAX_OUTPUT_CHARS);
  });

  it("charges list/quote prefix amplification against the output budget", () => {
    const chunk = "b".repeat(ADF_TO_TEXT_MAX_OUTPUT_CHARS - 10);
    const quoted = doc({ type: "blockquote", content: [p(chunk), p("tail")] });
    const outcome = convertAdfToText(quoted);
    expect(outcome.truncated).toBe(true);
    expect(outcome.truncationReasons).toContain("output-budget-exceeded");
    expect(outcome.text.length).toBeLessThanOrEqual(ADF_TO_TEXT_MAX_OUTPUT_CHARS);
  });
});

describe("convertAdfToText — purity and determinism", () => {
  it("produces byte-identical output across repeat runs over a hostile 10k-node corpus, within a wall-clock bound", () => {
    const breadth = hostileBreadthDoc(9_000).content as Json[];
    const deepQuoteChain = (nestedQuotes(40).content as Json[])[0] ?? p("fallback");
    const corpus = doc(...breadth, deepQuoteChain, {
      type: "unknown-blob",
      content: [text("tail"), { type: "mention", attrs: { text: "@Z" } }],
    });
    const startedAt = performance.now();
    const first = convertAdfToText(corpus);
    const second = convertAdfToText(corpus);
    const elapsedMs = performance.now() - startedAt;
    expect(second.text).toBe(first.text);
    expect(second.truncationReasons).toStrictEqual(first.truncationReasons);
    expect(second.unknownNodeTypes).toStrictEqual(first.unknownNodeTypes);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("produces identical output for a JSON round-tripped clone of the same document", () => {
    const original = doc(
      { type: "heading", attrs: { level: 3 }, content: [text("Spec")] },
      p(text("Body ", [{ type: "strong" }]), { type: "emoji", attrs: { shortName: ":x:" } }),
      {
        type: "taskList",
        content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("t")] }],
      },
    );
    const clone = JSON.parse(JSON.stringify(original)) as unknown;
    expect(convertAdfToText(clone).text).toBe(convertAdfToText(original).text);
  });

  it("does not mutate its input", () => {
    const input = doc(p("immutable"));
    const snapshot = JSON.stringify(input);
    convertAdfToText(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
