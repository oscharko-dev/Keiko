// Natural-language catalog selection cases (#4327). A request names neither the tool nor its
// arguments, so the model has to find the operation in the Jira catalog itself (directly or through
// jira.discover / jira.describe) and build the arguments from the person's words. Every truth is an
// independent native Jira read with the lab actor's credentials, never Keiko's own answer.
import { basicAuth, checked } from "./lab-client.mjs";

const TRUTH_TOKENS_MAX = 20;
const native = (session, path, actor = "api") =>
  checked(session, "catalog-selection-truth", "GET", path, basicAuth(session, actor));
const names = (rows, key = "name") => rows.map((row) => String(row[key]));
const bounded = (tokens) => [...new Set(tokens)].slice(0, TRUTH_TOKENS_MAX);
const projectPath = (f, suffix = "") =>
  `/rest/api/2/project/${encodeURIComponent(f.project)}${suffix}`;
const issuePath = (f, suffix = "") =>
  `/rest/api/2/issue/${encodeURIComponent(f.selection.issueKey)}${suffix}`;
const countMatching = (rows, predicate) => rows.filter(predicate).length;

/** Read cases whose operation is reachable only through the catalog search. */
const DISCOVERY_READS = [
  {
    id: "priorities",
    tool: "jira.priorities",
    prompt: () => "Welche Prioritätsstufen sind in unserem Jira definiert? Nenne alle Namen.",
    truth: async (s) => names(await native(s, "/rest/api/2/priority")),
  },
  {
    id: "resolutions",
    tool: "jira.resolutions",
    prompt: () =>
      "Welche Lösungen (Resolutions) kann ein Vorgang in unserem Jira bekommen? Nenne alle Namen.",
    truth: async (s) => names(await native(s, "/rest/api/2/resolution")),
  },
  {
    id: "status-categories",
    tool: "jira.status-categories",
    prompt: () => "Welche Statuskategorien kennt unser Jira? Nenne alle.",
    truth: async (s) => names(await native(s, "/rest/api/2/statuscategory")),
  },
  {
    id: "project-statuses",
    tool: "jira.project-statuses",
    prompt: (f) => `Welche Status können Vorgänge im Jira-Projekt ${f.project} annehmen?`,
    truth: async (s, f) =>
      (await native(s, projectPath(f, "/statuses"))).flatMap((type) => names(type.statuses)),
  },
  {
    // Project roles need project administration, which the lab's api actor deliberately lacks, so
    // a roles case would measure a permission refusal instead of the model's selection.
    id: "link-types",
    tool: "jira.link-types",
    prompt: () =>
      "Welche Arten von Verknüpfungen zwischen Vorgängen gibt es in unserem Jira? Nenne alle Namen.",
    truth: async (s) => names((await native(s, "/rest/api/2/issueLinkType")).issueLinkTypes),
  },
  {
    id: "myself",
    tool: "jira.myself",
    prompt: () =>
      "Mit welchem Jira-Benutzerkonto bin ich gerade verbunden? Nenne den Benutzernamen.",
    truth: async (s) => [String((await native(s, "/rest/api/2/myself")).name)],
  },
  {
    id: "project-lead",
    tool: "jira.project",
    prompt: (f) => `Wer ist der Projektleiter des Jira-Projekts ${f.project}?`,
    truth: async (s, f) => [String((await native(s, projectPath(f))).lead.name)],
  },
  {
    id: "global-issue-types",
    tool: "jira.global-issue-types",
    prompt: () =>
      "Welche Vorgangstypen sind systemweit in unserem Jira angelegt? Nenne alle Namen.",
    truth: async (s) => names(await native(s, "/rest/api/2/issuetype")),
  },
  {
    id: "components",
    tool: "jira.components",
    prompt: (f) => `Welche Komponenten hat das Jira-Projekt ${f.project}?`,
    truth: async (_s, f) => [f.selection.componentName],
  },
  {
    id: "versions",
    tool: "jira.versions",
    prompt: (f) => `Welche Versionen sind im Jira-Projekt ${f.project} angelegt?`,
    truth: async (_s, f) => [f.selection.versionName],
  },
  {
    id: "remote-links",
    tool: "jira.remote-links",
    prompt: (f) =>
      `Welche externen Links (Remote Links) hängen am Vorgang ${f.selection.issueKey}?`,
    truth: async (_s, f) => [f.selection.remoteLinkTitle],
  },
  {
    id: "issue-property-keys",
    tool: "jira.issue-property-keys",
    prompt: (f) =>
      `Welche Entity-Properties sind am Vorgang ${f.selection.issueKey} gespeichert? Nenne die Schlüssel.`,
    truth: async (_s, f) => [f.selection.propertyKey],
  },
  {
    id: "favourite-filters",
    tool: "jira.favourite-filters",
    prompt: () => "Welche Jira-Filter habe ich als Favoriten markiert?",
    truth: async (_s, f) => [f.selection.filterName],
  },
  {
    id: "boards",
    tool: "jira.boards",
    prompt: () => "Welche Agile-Boards gibt es in unserem Jira?",
    truth: async (_s, f) => [f.selection.boardName],
  },
  {
    id: "sprints",
    tool: "jira.sprints",
    prompt: (f) => `Welche Sprints hat das Agile-Board "${f.selection.boardName}"?`,
    truth: async (_s, f) => [f.selection.sprintName],
  },
];

/** Controls on the curated base catalog, which the model sees without searching. */
const BASE_READS = [
  {
    id: "search",
    tool: "jira.search",
    prompt: (f) => `Welche Vorgänge gibt es im Jira-Projekt ${f.project}? Nenne die Schlüssel.`,
    truth: async (s, f) => {
      const jql = encodeURIComponent(`project = ${f.project} ORDER BY key ASC`);
      const page = await native(s, `/rest/api/2/search?jql=${jql}&fields=summary&maxResults=20`);
      return page.issues.map((issue) => issue.key);
    },
  },
  {
    id: "issue",
    tool: "jira.issue",
    prompt: (f) => `Wie lautet die Zusammenfassung des Vorgangs ${f.selection.issueKey}?`,
    truth: async (s, f) => [
      String((await native(s, issuePath(f, "?fields=summary"))).fields.summary),
    ],
  },
  {
    id: "transitions",
    tool: "jira.transitions",
    prompt: (f) =>
      `Welche Workflow-Übergänge kann ich am Vorgang ${f.selection.issueKey} ausführen?`,
    truth: async (s, f) => names((await native(s, issuePath(f, "/transitions"))).transitions),
  },
];

/** Owned rows by an exact marker, with the native paths that remove them again. */
function owned(rows, matches, path) {
  const hits = rows.filter(matches);
  return { effects: hits.length, cleanup: hits.map(path) };
}

/** Write cases on owned synthetic objects; the effect is verified natively and then removed. */
const WRITES = [
  {
    id: "create-component",
    tool: "jira.create-component",
    prompt: (f, m) =>
      `Lege im Jira-Projekt ${f.project} eine neue Komponente mit dem Namen "${m} K" an.`,
    verify: async (s, f, m) =>
      owned(
        await native(s, projectPath(f, "/components")),
        (row) => row.name === `${m} K`,
        (row) => `/rest/api/2/component/${row.id}`,
      ),
  },
  {
    id: "create-version",
    tool: "jira.create-version",
    prompt: (f, m) =>
      `Lege im Jira-Projekt ${f.project} eine neue Version mit dem Namen "${m} V" an.`,
    verify: async (s, f, m) =>
      owned(
        await native(s, projectPath(f, "/versions")),
        (row) => row.name === `${m} V`,
        (row) => `/rest/api/2/version/${row.id}`,
      ),
  },
  {
    id: "remote-link",
    tool: "jira.upsert-remote-link",
    prompt: (f, m, tag) =>
      `Füge dem Vorgang ${f.selection.issueKey} einen externen Link auf https://example.invalid/${tag} mit dem Titel "${m} L" hinzu.`,
    verify: async (s, f, m) =>
      owned(
        await native(s, issuePath(f, "/remotelink")),
        (row) => row.object?.title === `${m} L`,
        (row) => issuePath(f, `/remotelink/${row.id}`),
      ),
  },
  {
    id: "issue-property",
    tool: "jira.set-issue-property",
    prompt: (f, _m, tag) =>
      `Speichere am Vorgang ${f.selection.issueKey} die Entity-Property "keiko.selection.${tag}" mit dem JSON-Wert {"geprueft": true}.`,
    verify: async (s, f, _m, tag) => {
      const key = `keiko.selection.${tag}`;
      const listed = await native(s, issuePath(f, "/properties"));
      if (countMatching(listed.keys ?? [], (row) => row.key === key) === 0)
        return { effects: 0, cleanup: [] };
      const value = await native(s, issuePath(f, `/properties/${key}`));
      const correct = value.value?.geprueft === true;
      return {
        effects: correct ? 1 : 0,
        wrongValue: !correct,
        cleanup: [issuePath(f, `/properties/${key}`)],
      };
    },
  },
  {
    id: "worklog",
    tool: "jira.create-worklog",
    prompt: (f, m) =>
      `Buche auf den Vorgang ${f.selection.issueKey} 30 Minuten Arbeitszeit mit dem Kommentar "${m} W".`,
    verify: async (s, f, m) => {
      const page = await native(s, issuePath(f, "/worklog"));
      const rows = page.worklogs.filter((row) => row.comment === `${m} W`);
      return {
        effects: countMatching(rows, (row) => row.timeSpentSeconds === 1800),
        wrongValue: rows.some((row) => row.timeSpentSeconds !== 1800),
        cleanup: rows.map((row) => issuePath(f, `/worklog/${row.id}`)),
      };
    },
  },
  {
    id: "watch",
    tool: "jira.watch",
    prompt: (f) =>
      `Setze den Jira-Benutzer ${f.selection.watcherName} als Beobachter auf den Vorgang ${f.selection.issueKey}.`,
    verify: async (s, f) => {
      const page = await native(s, issuePath(f, "/watchers"));
      const name = f.selection.watcherName;
      const present = countMatching(page.watchers, (row) => row.name === name);
      const removal = issuePath(f, `/watchers?username=${encodeURIComponent(name)}`);
      return { effects: present, cleanup: present > 0 ? [removal] : [] };
    },
  },
];

export const SELECTION_CASES = Object.freeze([
  ...DISCOVERY_READS.map((entry) => ({ ...entry, effect: "read", catalog: "discovery" })),
  ...BASE_READS.map((entry) => ({ ...entry, effect: "read", catalog: "base" })),
  ...WRITES.map((entry) => ({ ...entry, effect: "write", catalog: "discovery" })),
]);

/** The bounded set of native tokens a correct read result must carry. */
export async function selectionTruth(session, fixture, entry) {
  return bounded(await entry.truth(session, fixture));
}
