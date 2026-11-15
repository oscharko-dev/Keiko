import { describe, expect, it } from "vitest";
import { jiraReportDeclaration } from "./jiraReportDescriptor.js";

describe("the jira.report description (#4356)", () => {
  it("says that a repeated scope is harmless and a different one is refused", () => {
    const { description } = jiraReportDeclaration().descriptor;
    expect(description).toContain("names a reportId takes reportId, section, startAt");
    expect(description).toContain(
      "repeating the report's own projectKey, jql or epicKey is harmless",
    );
    expect(description).toContain("a different one is refused");
  });

  it("keeps its size: the description is part of every Jira turn's prompt (8192 pins)", () => {
    // 1,170 characters before #4357 AC5; new text replaces text instead of adding to it.
    expect(jiraReportDeclaration().descriptor.description.length).toBeLessThanOrEqual(1170);
  });
});

// #4357 AC5: a question about how a project is configured was routed to jira.report first in three
// of three Gemma rounds (the lab's project-statuses case): the report takes a project and has a
// `statuses` section, and its description did not say what it is NOT for.
describe("the jira.report description does not attract a configuration question (#4357)", () => {
  const { description } = jiraReportDeclaration().descriptor;
  const sentences = description.split(/(?<=\.)\s+/u);
  const CONFIGURATION =
    /\bworkflow|\bconfigur|\bissue types\b|\bcomponents\b|\bversions\b|\bfields\b/iu;

  it("says first what the report is for: figures over the issues and which issues deviate", () => {
    expect(sentences[0]).toMatch(
      /^Deterministic Jira report computed by Keiko over a project's issues/u,
    );
    expect(sentences[0]).toMatch(/progress/u);
    expect(sentences[1]).toMatch(/counts/u);
    // The compliance question (S11: "which issues deviate from the template") is claimed too.
    expect(sentences[0]).toMatch(/template compliance \(which issues deviate\)/u);
  });

  it("mentions the configuration words only to send such a question to jira.discover", () => {
    const naming = sentences.filter((sentence) => CONFIGURATION.test(sentence));
    expect(naming).toHaveLength(1);
    expect(naming[0]).toMatch(/does not/u);
    expect(naming[0]).toMatch(/jira\.discover/u);
  });

  it("names none of the configuration words in the other sentences or in the argument names", () => {
    const schema = JSON.stringify(jiraReportDeclaration().descriptor.inputSchema);
    expect(sentences.filter((sentence) => !CONFIGURATION.test(sentence))).toHaveLength(
      sentences.length - 1,
    );
    expect(schema).not.toMatch(/workflow|configur|component|version/iu);
  });

  it("uses the word status only to say that it does not list a project's statuses", () => {
    const uses = sentences.filter((sentence) => /\bstatus(?:es)?\b/iu.test(sentence));
    for (const sentence of uses) expect(sentence).toMatch(/does not list/u);
  });
});
