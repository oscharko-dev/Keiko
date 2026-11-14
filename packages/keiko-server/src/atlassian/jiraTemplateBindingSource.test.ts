import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJiraReportTemplateChecker,
  jiraInstanceIdentity,
  type JiraReportCheckerBinder,
  type JiraReportIssueFacts,
} from "@oscharko-dev/keiko-connectors";
import {
  bindJiraIssueTemplateText,
  jiraTemplateBindingDigest,
  parseJiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { jiraIssueTemplateSource } from "./jiraTemplateLog.js";

// #4354 (S6): the template reaches the report through the real source (the skill store and the Jira's
// identity), not through a hand-built object, and an issue record that carries no issue type id must
// never silently become "without template".
const BASE_URL = "https://jira.example.invalid/context";
const close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup();
});

const PLAIN = [
  "---",
  "keiko: jira-issue-template",
  "version: 1",
  "project: SYN",
  "issueType: Aufgabe",
  "activateOn: [create, edit]",
  "requiredLabels: [reviewed]",
  "---",
  "# Aufgabe",
].join("\n");

function sourceWith(markdown: string): ReturnType<typeof jiraIssueTemplateSource> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-template-source-")));
  close.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.createProject(root);
  store.markdownSkills.import({
    fileName: "template.md",
    contentBase64: Buffer.from(markdown, "utf8").toString("base64"),
  });
  return jiraIssueTemplateSource(store, BASE_URL);
}

function bound(): string {
  const parsed = parseJiraIssueTemplate(PLAIN);
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  const digest = jiraTemplateBindingDigest(jiraInstanceIdentity(BASE_URL), parsed.template, {
    issueTypeId: "10002",
  });
  const text = bindJiraIssueTemplateText(PLAIN, { digest, issueTypeId: "10002" });
  if (text === undefined) throw new TypeError("Expected a bound template");
  return text;
}

function checkerOf(
  binder: JiraReportCheckerBinder,
): Exclude<ReturnType<JiraReportCheckerBinder["bind"]>, "none" | "unavailable"> {
  const checker = binder.bind(undefined);
  if (checker === "none" || checker === "unavailable")
    throw new TypeError("Expected a template checker");
  return checker;
}

const facts = (issueTypeId: string, typeName: string): JiraReportIssueFacts => ({
  key: "SYN-1",
  projectKey: "SYN",
  issueTypeId,
  typeName,
  category: "new",
  fields: { summary: "An issue", description: "", labels: [] },
});

type Checker = ReturnType<typeof checkerOf>;
const covers = (checker: Checker, issue: JiraReportIssueFacts): boolean => {
  if (checker.covers === undefined) throw new TypeError("Expected a covering checker");
  return checker.covers(issue);
};

describe("a bound template reaches the report through the real source", () => {
  it("judges the issues of the bound type under whatever name the acting user sees", async () => {
    const checker = checkerOf(createJiraReportTemplateChecker(sourceWith(bound())));
    expect(covers(checker, facts("10002", "Task"))).toBe(true);
    expect(await checker.check(facts("10002", "Task"), undefined)).toEqual([
      expect.objectContaining({ ruleId: "label-missing" }),
    ]);
    // Another type carrying the typed name is not the bound type.
    expect(covers(checker, facts("10099", "Aufgabe"))).toBe(false);
  });

  it("never lets an issue record without a type id become 'without template' silently", async () => {
    const checker = checkerOf(createJiraReportTemplateChecker(sourceWith(bound())));
    expect(covers(checker, facts("", "Task"))).toBe(true);
    expect(await checker.check(facts("", "Task"), undefined)).toBe("unavailable");
  });

  it("falls back to name matching when the typed name was edited after binding", () => {
    const edited = bound().replace("issueType: Aufgabe", "issueType: Bug");
    const checker = checkerOf(createJiraReportTemplateChecker(sourceWith(edited)));
    // The stale id no longer governs: the template now means Bug, by name.
    expect(covers(checker, facts("10002", "Aufgabe"))).toBe(false);
    expect(covers(checker, facts("10077", "Bug"))).toBe(true);
    // An unbound template needs no type id to be matched by name.
    expect(covers(checker, facts("", "Bug"))).toBe(true);
  });

  it("matches an unbound template by its typed name, with or without a type id", () => {
    const checker = checkerOf(createJiraReportTemplateChecker(sourceWith(PLAIN)));
    expect(covers(checker, facts("", "Aufgabe"))).toBe(true);
    expect(covers(checker, facts("10002", "Task"))).toBe(false);
  });
});
