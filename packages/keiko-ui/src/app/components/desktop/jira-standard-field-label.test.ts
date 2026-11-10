import { describe, expect, it } from "vitest";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "@/lib/i18n-messages.optional.de";
import type { OptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { jiraStandardFieldLabel } from "./jira-standard-field-label";
import { jiraNamed, NO_JIRA_NAMES } from "./jiraNames";

const LABELS = [
  ["summary", "Summary", "Zusammenfassung"],
  ["description", "Description", "Beschreibung"],
  ["environment", "Environment", "Umgebung"],
  ["labels", "Labels", "Schlagwörter"],
  ["priority", "Priority", "Priorität"],
  ["assignee", "Assignee", "Bearbeiter"],
  ["reporter", "Reporter", "Gemeldet von"],
  ["duedate", "Due date", "Fälligkeitsdatum"],
  ["components", "Components", "Komponenten"],
  ["versions", "Affected versions", "Betroffene Versionen"],
  ["fixVersions", "Fix versions", "Zielversionen"],
  ["project", "Project", "Projekt"],
  ["issuetype", "Issue type", "Vorgangstyp"],
  ["status", "Status", "Status"],
  ["resolution", "Resolution", "Lösung"],
  ["timetracking", "Time tracking", "Zeiterfassung"],
  ["security", "Security level", "Sicherheitsstufe"],
  ["parent", "Parent issue", "Übergeordneter Vorgang"],
  ["attachment", "Attachments", "Anhänge"],
] as const;

describe.each(["en", "de"] as const)("built-in Jira field wording in %s", (locale) => {
  const catalog: Readonly<Record<string, string>> =
    locale === "en" ? OPTIONAL_WIDGET_EN_MESSAGES : OPTIONAL_WIDGET_DE_MESSAGES;
  const t: OptionalWidgetTranslate = (key) => catalog[key] ?? key;
  it.each(LABELS)("names %s without exposing its raw key", (id, en, de) => {
    expect(jiraStandardFieldLabel(id, t)).toBe(locale === "en" ? en : de);
  });
  it.each(["customfield_20001", "constructor", "__proto__", "toString", ""])(
    "preserves unknown field identity %j without treating it as a catalog key",
    (id) => {
      expect(jiraStandardFieldLabel(id, t)).toBeUndefined();
      const field = { id, value: { kind: "text", text: "Exact reviewed value" } } as const;
      expect(jiraNamed(field, NO_JIRA_NAMES, {}, t)).toEqual(field);
    },
  );
  it("preserves an already resolved field label and its exact value", () => {
    const field = {
      id: "summary",
      label: "Synthetic provider name",
      value: { kind: "text", text: "Exact reviewed value" },
    } as const;
    expect(jiraNamed(field, NO_JIRA_NAMES, {}, t)).toEqual(field);
  });
});
