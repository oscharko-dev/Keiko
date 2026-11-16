// The lab's Skills-dialog observations: the dialog lists and checks templates by itself, so the
// driver must bind each verdict to the read the dialog actually made for the uploaded template.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("@playwright/test", () => ({
  expect: Object.assign(() => ({}), {
    poll: (probe) => ({
      async toBe(expected) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await probe()) === expected) return;
          await new Promise((resolve) => globalThis.setImmediate(resolve));
        }
        throw new Error("poll-timeout");
      },
    }),
  }),
}));

import {
  checkedTemplate,
  listedAfter,
  watchTemplateReads,
} from "../testing/jira-chat-lab/browser-rules-knowledge-setup.mjs";

const MARKDOWN = '# Limit task\n\nparentIssueTypes: ["Epic"]\n';
const FORMAL = { project: "LIM9", issueType: "Task", parentIssueTypes: ["Epic"] };
const SKILL = { id: "msk_1", name: "Limit task" };

function fakePage() {
  const page = new EventEmitter();
  page.off = page.removeListener.bind(page);
  page.exchange = (method, path, { status = 200, body, sent } = {}) => {
    const request = { method: () => method, postDataJSON: () => sent };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      url: () => `http://127.0.0.1:1983${path}`,
      status: () => status,
      json: async () => body,
    });
  };
  return page;
}

function fakeDialog(rowTexts) {
  const waited = [];
  return {
    waited,
    getByRole: (role) => {
      expect(role).toBe("listitem");
      return {
        filter: ({ hasText }) => ({
          getByText: (text, options) => ({
            waitFor: async () => {
              expect(options).toEqual({ exact: true });
              if (!(rowTexts[hasText] ?? []).includes(text)) throw new Error("row-text-missing");
              waited.push([hasText, text]);
            },
          }),
        }),
      };
    },
  };
}

const VALID = { valid: true, findings: [], checked: { project: true, fields: true } };

describe("Skills dialog template observations", () => {
  it("lists only reads issued after the store changed", async () => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    page.exchange("GET", "/api/skills/jira-templates", { body: { templates: [] } });
    const mark = watch.mark();
    page.exchange("GET", "/api/skills/jira-templates", {
      body: { templates: [{ id: SKILL.id }] },
    });
    await expect(
      listedAfter(watch, mark, (listed) => listed.some((entry) => entry.id === SKILL.id)),
    ).resolves.toEqual([{ id: SKILL.id }]);
    watch.stop();
  });

  it("never accepts a list read that predates the store change", async () => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    page.exchange("GET", "/api/skills/jira-templates", {
      body: { templates: [{ id: SKILL.id }] },
    });
    await expect(listedAfter(watch, watch.mark())).rejects.toThrow("poll-timeout");
    watch.stop();
  });

  it("binds the automatic check to the uploaded template's own Markdown and its row", async () => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    page.exchange("POST", "/api/skills/jira-templates/validate", {
      sent: { markdown: "# Other\n" },
      body: { valid: false, findings: [{}], checked: {} },
    });
    page.exchange("POST", "/api/skills/jira-templates/validate", {
      sent: { markdown: MARKDOWN },
      body: VALID,
    });
    const dialog = fakeDialog({ [SKILL.name]: ["LIM9 · Task — Matches Jira."] });
    await checkedTemplate(dialog, watch, SKILL, MARKDOWN, FORMAL);
    expect(dialog.waited).toEqual([[SKILL.name, "LIM9 · Task — Matches Jira."]]);
    watch.stop();
  });

  it.each([
    ["a mismatch Jira reported", { body: { ...VALID, findings: [{ code: "unknown-field" }] } }],
    ["an unread project", { body: { ...VALID, checked: { project: false } } }],
    ["a failed check request", { status: 502, body: VALID }],
  ])("refuses %s", async (_case, response) => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    page.exchange("POST", "/api/skills/jira-templates/validate", {
      sent: { markdown: MARKDOWN },
      ...response,
    });
    const dialog = fakeDialog({ [SKILL.name]: ["LIM9 · Task — Matches Jira."] });
    await expect(checkedTemplate(dialog, watch, SKILL, MARKDOWN, FORMAL)).rejects.toThrow();
    expect(dialog.waited).toEqual([]);
    watch.stop();
  });

  it("refuses a row that does not show the complete match", async () => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    page.exchange("POST", "/api/skills/jira-templates/validate", {
      sent: { markdown: MARKDOWN },
      body: VALID,
    });
    const dialog = fakeDialog({
      [SKILL.name]: ["LIM9 · Task — Matches Jira; fields could not be read."],
    });
    await expect(checkedTemplate(dialog, watch, SKILL, MARKDOWN, FORMAL)).rejects.toThrow(
      "row-text-missing",
    );
    watch.stop();
  });

  it("refuses a parent-type template whose stored Markdown lost the clause", async () => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    const stripped = "# Limit task\n";
    page.exchange("POST", "/api/skills/jira-templates/validate", {
      sent: { markdown: stripped },
      body: VALID,
    });
    const dialog = fakeDialog({ [SKILL.name]: ["LIM9 · Task — Matches Jira."] });
    await expect(checkedTemplate(dialog, watch, SKILL, stripped, FORMAL)).rejects.toThrow(
      "parent-type clause",
    );
    watch.stop();
  });

  it("stops observing once the dialog work ends", () => {
    const page = fakePage();
    const watch = watchTemplateReads(page);
    watch.stop();
    page.exchange("GET", "/api/skills/jira-templates", { body: { templates: [] } });
    expect(watch.lists).toEqual([]);
    expect(page.listenerCount("request") + page.listenerCount("response")).toBe(0);
  });
});
