// S16 of epic #4173 (#4179): test cases in the form the issue template defines. The lab imports a
// template for REQ Tasks that defines the form (the sections `Schritte` and `Erwartet`, and a summary
// naming `<id>/AC<n>`), then asks for one test case per acceptance criterion of LH-002 in REQ without
// giving that form in the prompt. The obligation is credited only from the issues Jira holds: exactly
// one conforming issue per criterion, labelled with the requirement's trace. The template is removed
// when the journey ends, because the library activates every valid template for every later write.
import { buildCorpus } from "./corpus.mjs";
import { snapshotBefore } from "./journey-support.mjs";
import { turnIssues } from "./oracles.mjs";
import { templateMarkdown, withTemplate } from "./templates.mjs";

const TASK_QUERY = "project = REQ AND issuetype = Task";
const TEST_CASE_SECTIONS = Object.freeze(["Schritte", "Erwartet"]);
/** The summary the template requires: `LH-002/AC1 <title>`. */
const TEST_CASE_SUMMARY_PATTERN = String.raw`^LH-\d{3}/AC\d+ \S`;
const TEMPLATE_NAME = "REQ-Task-Testfall";
const FOOTER_START = "----\nKeiko traceability";

export const testCaseTemplateMarkdown = (project) =>
  templateMarkdown({
    project,
    issueType: "Task",
    rule: { sections: [...TEST_CASE_SECTIONS] },
    summaryPattern: TEST_CASE_SUMMARY_PATTERN,
  });

const HEADING = (name) =>
  new RegExp(String.raw`(?:^|\n)[ \t]*(?:h\d\.|#+)?[ \t]*[*_]*${name}\b[^\n]*`, "iu");

/** Whether every named section opens a heading and holds text before the next one (or the footer). */
export function sectionsFilled(description, names) {
  const text = String(description ?? "").replaceAll("\r\n", "\n");
  const footer = text.indexOf(FOOTER_START);
  const body = footer < 0 ? text : text.slice(0, footer);
  const heads = names.map((name) => HEADING(name).exec(body));
  if (heads.some((head) => head === null)) return false;
  const starts = heads.map((head) => head.index + head[0].length);
  return heads.every((head, index) => {
    const next = heads
      .map((other) => other.index)
      .filter((position) => position > head.index)
      .sort((a, b) => a - b)[0];
    return body.slice(starts[index], next ?? body.length).trim() !== "";
  });
}

/** The criterion number a conforming test case names, or undefined. */
function criterionOf(issue, item) {
  const pattern = new RegExp(String.raw`^${item.id}/AC(\d+) \S`, "u");
  const number = Number(pattern.exec(issue.fields.summary ?? "")?.[1]);
  const labels = issue.fields.labels ?? [];
  const traced =
    labels.includes(`keiko-req-${item.id}`) || labels.includes(`keiko-ac-${item.id}-AC${number}`);
  const known = Number.isInteger(number) && number >= 1 && number <= item.acceptanceCount;
  return known && traced && sectionsFilled(issue.fields.description, TEST_CASE_SECTIONS)
    ? number
    : undefined;
}

/**
 * Grades the issues of the turn: exactly one conforming issue per acceptance criterion and nothing
 * else. No issue at all is absent evidence (`unverified`); any other deviation is `red`.
 */
function gradeTemplateTestCases({ tests, item }) {
  if (tests.credited.length === 0) {
    return { status: "unverified", detail: "no test case issue in Jira" };
  }
  const numbers = tests.credited.map((issue) => criterionOf(issue, item));
  const expected = Array.from({ length: item.acceptanceCount }, (_, index) => index + 1);
  const count = (number) => numbers.filter((entry) => entry === number).length;
  const missing = expected.filter((number) => count(number) === 0);
  const duplicated = expected.filter((number) => count(number) > 1);
  const nonconforming = numbers.filter((number) => number === undefined).length;
  const ok =
    missing.length === 0 &&
    duplicated.length === 0 &&
    nonconforming === 0 &&
    tests.duplicates.length === 0 &&
    tests.credited.length === item.acceptanceCount;
  return {
    status: ok ? "green" : "red",
    detail: `${tests.credited.length} issues for ${item.acceptanceCount} criteria: ${missing.length} criteria without one, ${duplicated.length} duplicated, ${nonconforming} not conforming to the template`,
  };
}

/** The write turn of S16, run under the template and graded from Jira. */
export async function templateTestCasesPart(ctx, chat) {
  const item = buildCorpus(1).truth.find((entry) => entry.id === "LH-002");
  return withTemplate(ctx.http, testCaseTemplateMarkdown("REQ"), TEMPLATE_NAME, async () => {
    const before = await snapshotBefore(ctx, TASK_QUERY);
    const turn = await ctx.turn(
      chat,
      `Lege im Jira-Projekt REQ für die Anforderung ${item.id} aus dem Lastenheft zu jedem Abnahmekriterium genau einen Testfall als Vorgang an, in der Form, die die Vorlage des Projekts vorgibt. Melde die Vorgangsschlüssel.`,
    );
    const tests = turnIssues({
      before,
      issues: await ctx.search(TASK_QUERY, "summary,description,labels"),
      exchanges: turn.toolExchanges,
    });
    return {
      turn,
      part: {
        label: "template-defined test cases",
        covers: ["template-defined-format"],
        ...gradeTemplateTestCases({ tests, item }),
      },
    };
  });
}
