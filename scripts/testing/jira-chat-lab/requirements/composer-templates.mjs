// The Composer lane's templates and conformity rules (#4369, Release 1). The lane writes Jira from
// the Chat composer by plain instruction, with no Knowledge Pod and no requirements document, so its
// templates name no requirement: one template per issue type of the work project, all active at
// once, built from the lab's own template builder and its structure rules. Conformity is judged by
// the lab from what Jira holds, never from the product's account of a refusal.
import { SUBTASK_PARENT_TYPES } from "./composer-refusals.mjs";
import { STRUCTURE_RULES } from "./corpus.mjs";
import { sectionsPresent } from "./oracles.mjs";
import { STORY_STRUCTURE_RULE, templateMarkdown } from "./templates.mjs";

export const COMPOSER_TYPES = Object.freeze(["Epic", "Story", "Task", "Sub-task", "Bug"]);
/** The Epic a lead asks for without any requirement: a goal and how it is accepted. */
const COMPOSER_EPIC_RULE = Object.freeze({ sections: ["Ziel", "Abnahmekriterien"] });

const RULES = Object.freeze({
  Epic: COMPOSER_EPIC_RULE,
  Story: STORY_STRUCTURE_RULE,
  Task: STRUCTURE_RULES.Task,
  "Sub-task": STRUCTURE_RULES.Task,
  Bug: STRUCTURE_RULES.Bug,
});

/** `sub-task` for `Sub-task`: the closed id of a type inside an obligation name. */
export const typeSlug = (type) => type.toLowerCase().replaceAll(/[^a-z]+/gu, "-");

/** The sections the template of `type` requires in the description. */
export const requiredSections = (type) => RULES[type].sections;

/**
 * One template per type, as the project lead defines it. Story, Task and Bug require the epic link;
 * a Sub-task requires a parent of the type Task; a Bug requires a priority. `activateOn` names the
 * actions the template governs (create by default; the edit lane adds `edit`).
 */
export function composerTemplates(project, epicLinkFieldId, { activateOn = ["create"] } = {}) {
  return COMPOSER_TYPES.map((issueType) => {
    const subtask = issueType === "Sub-task";
    const hierarchy = { Story: true, Task: true, Bug: true }[issueType] === true;
    const markdown = templateMarkdown({
      project,
      issueType,
      rule: RULES[issueType],
      activateOn,
      ...(hierarchy ? { parentField: epicLinkFieldId } : {}),
      ...(subtask ? { parentField: "parent", parentIssueTypes: [...SUBTASK_PARENT_TYPES] } : {}),
      requiredFields: issueType === "Bug" ? ["priority"] : [],
    });
    return { name: `${project}-Composer-${issueType}`, markdown, issueType };
  });
}

/** The JQL fields every composer oracle reads for a type's issues. */
export const composerFields = (epicLinkFieldId) =>
  `summary,description,labels,issuetype,priority,parent,issuelinks,${epicLinkFieldId}`;

const filled = (value) => typeof value === "string" && value !== "";

/**
 * The lab's conformity rule of one type, as a predicate over an issue read from Jira: the required
 * sections, the epic link (Story, Task, Bug), a parent (Sub-task) and a priority (Bug).
 */
export function composerConformity(type, { epicLink }) {
  const sections = requiredSections(type);
  return (issue) => {
    const fields = issue.fields ?? {};
    if (!sectionsPresent(fields.description, sections)) return false;
    if (type === "Epic") return true;
    if (type === "Sub-task") return filled(fields.parent?.key);
    if (!filled(fields[epicLink])) return false;
    return type !== "Bug" || filled(fields.priority?.name);
  };
}

const quoted = (title) => `„${title}“`;

/** What a person writes under one required section after seeing the template. */
const sectionContent = (name) => `${name}: Synthetischer Inhalt zum Abschnitt ${name}.`;

/** The content every section and required field of the type's template asks for, said in the request. */
export function contentRequest(type, each = "die") {
  const sections = requiredSections(type)
    .map((name) => sectionContent(name))
    .join(" ");
  const priority = type === "Bug" ? " Die Priorität ist High." : "";
  return `${each === "die" ? "Die Beschreibung" : "Die Beschreibung jeder Aufgabe"} enthält diese Abschnitte, jeweils unter einer eigenen Überschrift: ${sections}${priority}`;
}

/**
 * The titled create instruction of `type`, as a person writes it after seeing the template: the
 * title, the named parents and the content of every section and required field the template asks
 * for, so that a conformant issue is possible without the model inventing anything. It offers no
 * way to stop at a refusal: a request that cannot be met is reported in words by the model itself.
 */
export function createPrompt(type, title, { epic, task }) {
  const tail = `${contentRequest(type)} Melde den Vorgangsschlüssel.`;
  const base = `Lege im Jira-Projekt REQ`;
  switch (type) {
    case "Epic":
      return `${base} ein Epic mit dem Titel ${quoted(title)} an. ${tail}`;
    case "Story":
      return `${base} eine Story mit dem Titel ${quoted(title)} im Epic ${epic} an. ${tail}`;
    case "Task":
      return `${base} eine Aufgabe (Vorgangstyp Task) mit dem Titel ${quoted(title)} im Epic ${epic} an. ${tail}`;
    case "Sub-task":
      return `${base} eine Teilaufgabe (Vorgangstyp Sub-task) mit dem Titel ${quoted(title)} unter der Aufgabe ${task} an. ${tail}`;
    default:
      return `${base} einen Fehler (Vorgangstyp Bug) mit dem Titel ${quoted(title)} im Epic ${epic} an und verknüpfe ihn über eine Vorgangsverknüpfung vom Typ „Relates“ mit der Aufgabe ${task}. ${tail}`;
  }
}

/**
 * A request nobody can repair alone: a Sub-task under a Story, although the template requires a
 * Task as parent. The content is complete; only the parent is wrong, and only the person can choose
 * another one. The model must say so in plain words, and nothing may be created.
 */
export function unrepairablePrompt(title, { story }) {
  return `Lege im Jira-Projekt REQ eine Teilaufgabe (Vorgangstyp Sub-task) mit dem Titel ${quoted(title)} unter dem Vorgang ${story} an. ${contentRequest("Sub-task")} Melde den Vorgangsschlüssel.`;
}

/**
 * A request that violates the type's template on purpose (a bare title and a one-line body), with
 * the repair path the person would give: after a refusal, correct the reported violations and use
 * the named epic or parent. The refusal itself must come before any card and any effect.
 */
export function violationPrompt(type, title, { epic, task }) {
  const parent = type === "Sub-task" ? `die Aufgabe ${task}` : `das Epic ${epic}`;
  return `Lege im Jira-Projekt REQ ${type === "Epic" ? "ein Epic" : `einen Vorgang vom Typ ${type}`} mit genau der Zusammenfassung ${quoted(title)} und genau der Beschreibung „Kurzer Test.“ an. Falls das Anlegen abgelehnt wird, korrigiere den Vorgang anhand der gemeldeten Verstöße${type === "Epic" ? "" : `, ordne ihn bei der Korrektur ${parent} zu`} und lege ihn erneut an. Für die Korrektur gilt: ${contentRequest(type)} Melde den Vorgangsschlüssel oder den genauen Fehler.`;
}
