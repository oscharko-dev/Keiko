// Production-shaped Jira card markup (JiraChatTools.tsx, JiraWriteApproval.tsx) must be read back.
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { visibleCards } from "../testing/jira-chat-lab/browser-a11y.mjs";
import { RESULT_CARDS } from "../testing/jira-chat-lab/browser-card-readability.mjs";

// Known read tool: div.cmpCard > fieldset[aria-label] > strong + output (JiraCardBody/JiraCardFrame).
const READ_RECEIPT =
  '<div class="cmpCard"><fieldset aria-label="Issues found"><strong>Issues found</strong>' +
  "<output>Completed</output><p>LIM7-1 and LIM7-2</p></fieldset></div>";
// A known write receipt: section[aria-label] > fieldset[aria-label] > strong + output.
const WRITE_RECEIPT =
  '<section class="cmpCard" aria-label="Jira action"><fieldset aria-label="Create issue">' +
  "<strong>Create issue</strong><output>Completed</output><p>LIM7-3</p></fieldset></section>";
// A non-Jira (MCP) receipt: section[aria-label] > div > strong + output.
const MCP_RECEIPT =
  '<section class="cmpCard" aria-label="Jira action"><div class="cmpCardBody">' +
  "<strong>mcp_jira_search</strong><output>Completed</output></div></section>";
// Approval card: section[aria-label] > strong, p, content, output (not adjacent), actions.
const APPROVAL =
  '<section class="cmpCard" aria-label="Review Jira action"><strong>Review Jira action</strong>' +
  '<p>Create issue</p><fieldset aria-label="Proposed action details"><p>LIM7-4</p></fieldset>' +
  '<output aria-live="polite">Waiting for your decision</output>' +
  "<div><button>Approve this action</button></div></section>";

// Playwright's innerText separates block and inline-block children; textContent would not.
function rendered(element) {
  return element.children.length === 0
    ? element.textContent
    : [...element.children].map(rendered).join("\n");
}

function adapter(root) {
  const wrap = (element) => ({
    isVisible: async () => true,
    innerText: async () => rendered(element),
    locator: (selector) => list([...element.querySelectorAll(selector)], true),
    getByRole: () => list([...element.querySelectorAll("a[href]")], false),
    getAttribute: async (name) => element.getAttribute(name),
  });
  const list = (elements, strict) => ({
    count: async () => elements.length,
    nth: (index) => wrap(elements[index]),
    innerText: async () => {
      if (strict && elements.length !== 1) throw new Error("strict mode violation");
      return rendered(elements[0]);
    },
  });
  return { list, wrap, root };
}

async function read(markup) {
  const dom = new JSDOM(`<body><div id="region">${markup}</div></body>`);
  const region = dom.window.document.getElementById("region");
  const { list } = adapter(region);
  return visibleCards(
    {
      region: { locator: (selector) => list([...region.querySelectorAll(selector)], false) },
      page: { url: () => "https://keiko.invalid/" },
    },
    "LIM7",
  );
}

describe("production-shaped Jira card markup", () => {
  it("keeps the shared selector able to see fieldset groups", () => {
    expect(RESULT_CARDS).toContain("fieldset[aria-label]");
  });
  it.each([
    ["a known read receipt (fieldset)", READ_RECEIPT, "Issues found", ["LIM7-1", "LIM7-2"]],
    ["a known write receipt (nested fieldset)", WRITE_RECEIPT, "Create issue", ["LIM7-3"]],
    ["an MCP receipt (section > div)", MCP_RECEIPT, "mcp_jira_search", []],
  ])("reads back %s", async (_name, markup, title, keys) => {
    const cards = await read(markup);
    expect(cards.cards).toEqual([{ title, outcome: "Completed" }]);
    expect(cards.keys).toEqual(keys);
  });
  it("reads an approval card whose status output is not adjacent to its heading", async () => {
    const cards = await read(APPROVAL);
    expect(cards.cards).toEqual([
      { title: "Review Jira action", outcome: "Waiting for your decision" },
    ]);
  });
  it("counts each rendered card once when receipts and approvals share a message", async () => {
    const cards = await read(READ_RECEIPT + WRITE_RECEIPT + MCP_RECEIPT + APPROVAL);
    expect(cards.cards).toHaveLength(4);
  });
});
