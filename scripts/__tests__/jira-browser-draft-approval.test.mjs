// The real JiraDraftPreview DOM contract: fieldset/legend, labelled checkboxes, own target and fields.
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { queryAllByRole } from "@testing-library/dom";
import { approveWorkflowExchange } from "../testing/jira-chat-lab/browser-workflow-turn.mjs";

const EXPECTED = [1, 2, 3].map((number) => ({
  summary: `Draft task ${number}`,
  projectLabel: "Requirements (REQ)",
  issueType: "Task",
  parentIssueKey: "REQ-17",
  parentFieldId: "customfield_10100",
  parentFieldLabel: "Epic Link",
}));
const EXCHANGE = {
  call: { name: "jira_draft" },
  approval: {
    operation: "jira.draft",
    state: "pending",
    approvalId: "synthetic-approval",
    actionDigest: "synthetic-digest",
  },
};

function visible(element) {
  for (let current = element; current; current = current.parentElement) {
    const style = element.ownerDocument.defaultView.getComputedStyle(current);
    if (current.hidden || style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

// Playwright normalizes both sides of an exact accessible-name match (including invisible marks).
const normalizeName = (value) =>
  value
    .replace(/[\u200b\u00ad]/gu, "")
    .trim()
    .replace(/\s+/gu, " ");

// Real DOM role/name resolution, with the small Locator surface used by the shared owner.
function browserDom(document, clicked) {
  function wrap(elements) {
    const one = () => {
      if (elements.length !== 1) throw new TypeError("Strict locator requires one element");
      return elements[0];
    };
    return {
      elements,
      count: async () => elements.length,
      nth: (index) => wrap([elements[index]]),
      page: () => wrap([document.body]),
      locator: (selector) =>
        wrap([
          ...new Set(
            elements.flatMap((element) =>
              selector === ".." ? [element.parentElement] : [...element.querySelectorAll(selector)],
            ),
          ),
        ]),
      getByRole: (role, { includeHidden, ...options } = {}) =>
        wrap([
          ...new Set(
            elements.flatMap((element) =>
              queryAllByRole(element, role, {
                ...options,
                ...(typeof options.name === "string"
                  ? { name: (name) => normalizeName(name) === normalizeName(options.name) }
                  : {}),
                hidden: includeHidden ?? false,
              }),
            ),
          ),
        ]),
      filter: ({ has, visible: wanted }) =>
        wrap(
          elements.filter(
            (element) =>
              (wanted === undefined || visible(element) === wanted) &&
              (has === undefined || has.elements.some((child) => element.contains(child))),
          ),
        ),
      innerText: async () => one().textContent,
      evaluate: async (callback, argument) => callback(one(), argument),
      isVisible: async () => visible(one()),
      isEnabled: async () => !one().matches(":disabled"),
      isChecked: async () => one().checked,
      waitFor: async () => {
        if (!visible(one())) throw new TypeError("Expected a visible element");
      },
      click: async () => {
        if (!visible(one()) || one().matches(":disabled")) throw new TypeError("Not clickable");
        clicked.push(one().textContent);
      },
    };
  }
  return wrap([document.getElementById("chat")]);
}

function draftFixture({ parentAsField = false } = {}) {
  const dom = new JSDOM(
    '<body><div id="chat"><section aria-label="Review Jira action">' +
      "<strong>Review Jira action</strong><fieldset><legend>Issues to create (3 of 3 selected)</legend>" +
      "<ul></ul></fieldset><output>Waiting for your decision</output>" +
      "<div><button>Approve this action</button></div></section></div></body>",
  );
  const document = dom.window.document;
  const list = document.querySelector("fieldset > ul");
  for (const [index, expected] of EXPECTED.entries()) {
    const item = document.createElement("li");
    item.innerHTML =
      `<div><input id="item-${index}" type="checkbox" checked><div>` +
      `<label for="item-${index}">${expected.summary}</label>` +
      `<span>Project ${expected.projectLabel} · Issue type ${expected.issueType}</span>` +
      (parentAsField
        ? `<dl><div><dt>${expected.parentFieldLabel}</dt><dd>${expected.parentIssueKey}</dd></div></dl>`
        : `<span>Requirements: R-1 · Parent (${expected.parentFieldId}): ${expected.parentIssueKey}</span>`) +
      "</div></div>";
    list.append(item);
  }
  const clicked = [];
  return {
    document,
    region: browserDom(document, clicked),
    clicked,
    decisions: new Set(),
    options: {
      operations: ["jira.draft"],
      reviewText: ["Draft task", "REQ"],
      expectedDraftItems: structuredClone(EXPECTED),
    },
  };
}

const decide = (fixture, exchange = EXCHANGE) =>
  approveWorkflowExchange(fixture.region, exchange, fixture.options, fixture.decisions);

describe("visible draft approval stays inside the explicit item set", () => {
  it.each([false, true])(
    "approves all three exact tasks with parentAsField=%s",
    async (parentAsField) => {
      const fixture = draftFixture({ parentAsField });
      const lifecycle = [];
      fixture.options.beforeDecision = async (exchange) => {
        expect(exchange).toBe(EXCHANGE);
        expect(fixture.clicked).toEqual([]);
        lifecycle.push("reviewed");
      };
      fixture.options.persist = (facts) => lifecycle.push(facts.phase);
      await decide(fixture);
      expect(fixture.clicked).toEqual(["Approve this action"]);
      expect(fixture.decisions).toEqual(new Set([EXCHANGE.approval.approvalId]));
      expect(lifecycle).toEqual(["reviewed", "approval-may-have-been-sent"]);
    },
  );

  it.each([
    ["no expected item set", (f) => delete f.options.expectedDraftItems],
    ["an empty item set", (f) => (f.options.expectedDraftItems = [])],
    ["an incomplete target", (f) => delete f.options.expectedDraftItems[0].parentFieldId],
    [
      "duplicate expected titles",
      (f) => (f.options.expectedDraftItems[1].summary = EXPECTED[0].summary),
    ],
    [
      "a changed item title",
      (f) => (f.document.querySelector('label[for="item-1"]').textContent = "Another task"),
    ],
    ["a missing item", (f) => f.document.querySelectorAll("fieldset > ul > li")[1].remove()],
    [
      "an extra item",
      (f) =>
        f.document
          .querySelector("fieldset > ul")
          .append(f.document.querySelector("li").cloneNode(true)),
    ],
    ["an unchecked item", (f) => (f.document.getElementById("item-1").checked = false)],
    ["a disabled item", (f) => (f.document.getElementById("item-1").disabled = true)],
    ["a hidden item", (f) => (f.document.getElementById("item-1").hidden = true)],
    [
      "a hidden associated title",
      (f) => {
        f.document.querySelector('label[for="item-1"]').hidden = true;
        // Keep the accessible name matching so only the visible associated-title guard can refuse.
        f.document.getElementById("item-1").setAttribute("aria-label", EXPECTED[1].summary);
      },
    ],
    ["a hidden preview", (f) => (f.document.querySelector("fieldset").hidden = true)],
    [
      "a partial selection",
      (f) =>
        (f.document.querySelector("legend").textContent = "Issues to create (2 of 3 selected)"),
    ],
    [
      "two pending cards",
      (f) =>
        f.document
          .getElementById("chat")
          .append(f.document.querySelector("section").cloneNode(true)),
    ],
    [
      "two previews",
      (f) =>
        f.document
          .querySelector("section")
          .append(f.document.querySelector("fieldset").cloneNode(true)),
    ],
    [
      "a loading preview",
      (f) => (f.document.querySelector("fieldset").outerHTML = "<output>Loading draft</output>"),
    ],
    [
      "an unreadable fallback",
      (f) =>
        (f.document.querySelector("fieldset").outerHTML =
          '<fieldset aria-label="Proposed action details">REQ Draft task</fieldset>'),
    ],
    [
      "raw content",
      (f) => f.document.querySelector("section").append(f.document.createElement("pre")),
    ],
    [
      "a different project on the second item",
      (f) =>
        (f.document.getElementById("item-1").parentElement.querySelector("span").textContent =
          "Project Another (OTHER) · Issue type Task"),
    ],
    [
      "a different type on the second item",
      (f) =>
        (f.document.getElementById("item-1").parentElement.querySelector("span").textContent =
          "Project Requirements (REQ) · Issue type Epic"),
    ],
    [
      "a hidden target",
      (f) =>
        (f.document.getElementById("item-1").parentElement.querySelector("span").hidden = true),
    ],
    [
      "a second conflicting target",
      (f) =>
        f.document
          .getElementById("item-1")
          .parentElement.querySelector("span")
          .insertAdjacentHTML("afterend", "<span>Project Other (OTHER) · Issue type Task</span>"),
    ],
    [
      "a hidden parent",
      (f) =>
        (f.document.getElementById("item-1").parentElement.querySelectorAll("span")[1].hidden =
          true),
    ],
    [
      "a wrong parent on the second item",
      (f) =>
        (f.document.getElementById("item-1").parentElement.querySelectorAll("span")[1].textContent =
          "Parent (customfield_10100): REQ-99"),
    ],
    [
      "a missing parent",
      (f) => f.document.getElementById("item-1").parentElement.querySelectorAll("span")[1].remove(),
    ],
  ])("refuses %s before any decision or click", async (_name, change) => {
    const fixture = draftFixture();
    change(fixture);
    await expect(decide(fixture)).rejects.toThrow();
    expect(fixture.clicked).toEqual([]);
    expect(fixture.decisions.size).toBe(0);
  });

  it.each(["Draft  task 1", "Draft\ttask 1", "Draft\u200b task 1"])(
    "refuses normalized title alias %s instead of reviewing one checkbox twice",
    async (alias) => {
      const fixture = draftFixture();
      fixture.options.expectedDraftItems[1].summary = alias;
      await expect(decide(fixture)).rejects.toThrow();
      expect(fixture.clicked).toEqual([]);
      expect(fixture.decisions.size).toBe(0);
    },
  );

  it.each(["dt", "dd"])("refuses a hidden parent %s", async (tag) => {
    const fixture = draftFixture({ parentAsField: true });
    fixture.document.querySelector(tag).hidden = true;
    await expect(decide(fixture)).rejects.toThrow();
    expect(fixture.clicked).toEqual([]);
    expect(fixture.decisions.size).toBe(0);
  });

  it("does not borrow the expected parent key from a description", async () => {
    const fixture = draftFixture({ parentAsField: true });
    const firstField = fixture.document.querySelector("dl > div");
    firstField.querySelector("dd").textContent = "REQ-99";
    firstField.insertAdjacentHTML("afterend", "<div><dt>Description</dt><dd>REQ-17</dd></div>");
    await expect(decide(fixture)).rejects.toThrow();
    expect(fixture.clicked).toEqual([]);
  });

  it("does not borrow the correct target from another nested draft item", async () => {
    const fixture = draftFixture();
    const items = fixture.document.querySelectorAll("fieldset > ul > li");
    items[0].querySelector("span").remove();
    const children = fixture.document.createElement("ul");
    children.append(items[1]);
    items[0].append(children);
    await expect(decide(fixture)).rejects.toThrow();
    expect(fixture.clicked).toEqual([]);
  });

  it("rechecks selection after an asynchronous beforeDecision observer", async () => {
    const fixture = draftFixture();
    fixture.options.beforeDecision = async () => {
      fixture.document.getElementById("item-1").checked = false;
    };
    await expect(decide(fixture)).rejects.toThrow();
    expect(fixture.clicked).toEqual([]);
    expect(fixture.decisions.size).toBe(0);
  });

  it("keeps a normal single-action approval on its existing details path", async () => {
    const fixture = draftFixture();
    fixture.document.querySelector("fieldset").outerHTML =
      '<fieldset aria-label="Proposed action details"><p>REQ Draft task</p></fieldset>';
    fixture.options = { operations: ["jira.create"], reviewText: ["REQ", "Draft task"] };
    await decide(fixture, {
      ...EXCHANGE,
      call: { name: "jira_create" },
      approval: { ...EXCHANGE.approval, operation: "jira.create" },
    });
    expect(fixture.clicked).toEqual(["Approve this action"]);
  });
});
