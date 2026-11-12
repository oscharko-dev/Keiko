// Natural-language catalog selection cases (#4327). A request names neither the tool nor its
// arguments, so the model has to find the operation in the Jira catalog itself (directly or through
// jira.discover / jira.describe) and build the arguments from the person's words. Every truth is an
// independent native Jira read with the lab actor's credentials, never Keiko's own answer; a read
// that cannot see an owned object, or a list beyond the tools' first page, makes the attempt invalid.
import { voteKey } from "./catalog-selection-objects.mjs";
import { actorDetails, basicAuth, checked } from "./lab-client.mjs";

const TRUTH_TOKENS_MAX = 20;
const native = (session, path, actor = "api") =>
  checked(session, "catalog-selection-truth", "GET", path, basicAuth(session, actor));
const names = (rows, key = "name") => rows.map((row) => String(row[key]));
const bounded = (tokens) => [...new Set(tokens)].slice(0, TRUTH_TOKENS_MAX);
const projectPath = (f, suffix = "") =>
  `/rest/api/2/project/${encodeURIComponent(f.project)}${suffix}`;
const issuePath = (f, suffix = "") =>
  `/rest/api/2/issue/${encodeURIComponent(f.selection.issueKey)}${suffix}`;
const utcDay = () => new Date().toISOString().slice(0, 10);
// The day a worklog request named, by its unique marker, so the check cannot drift across midnight.
const requestedDays = new Map();
const START_HOUR = "T09:00:00.000Z";
/** Jira writes the start as `…+0000`, which Date.parse refuses without a colon in the offset. */
const startedInstant = (started) =>
  Date.parse(String(started).replace(/([+-]\d\d)(\d\d)$/u, "$1:$2"));
const countMatching = (rows, predicate) => rows.filter(predicate).length;
// The catalog's list reads return 25 rows unless asked for more; a longer native list could hide
// the owned object from a correct call, so such a truth is refused instead of graded.
const TOOL_PAGE_ROWS = 25;

/** The owned object's name, after the native read proved it visible on the tools' first page. */
function ownedName(rows, name, read = (row) => row.name) {
  if (rows.length > TOOL_PAGE_ROWS) throw new TypeError("The native list exceeds one tool page");
  if (!rows.some((row) => String(read(row)) === name))
    throw new TypeError("An owned object is not visible to the api actor");
  return [name];
}

/** Read cases whose operation is reachable only through the catalog search. */
const DISCOVERY_READS = [
  {
    id: "priorities",
    tool: "jira.priorities",
    alternatives: ["jira.priority-page"],
    prompt: () => "Welche Prioritätsstufen sind in unserem Jira definiert? Nenne alle Namen.",
    truth: async (s) => names(await native(s, "/rest/api/2/priority")),
  },
  {
    id: "resolutions",
    tool: "jira.resolutions",
    alternatives: ["jira.resolution-page"],
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
    // Not "Vorgänge im Projekt": that wording asks about issues, which jira.report answers from the
    // statuses issues currently have, not from the project's configuration.
    prompt: (f) =>
      `Welche Status sind für das Jira-Projekt ${f.project} im Workflow konfiguriert? Nenne alle Namen.`,
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
    // The session read names the connected account just as well (reviewed 2026-11-12).
    alternatives: ["jira.current-session"],
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
    alternatives: ["jira.issue-type-page"],
    prompt: () =>
      "Welche Vorgangstypen sind systemweit in unserem Jira angelegt? Nenne alle Namen.",
    truth: async (s) => names(await native(s, "/rest/api/2/issuetype")),
  },
  {
    id: "components",
    tool: "jira.components",
    prompt: (f) => `Welche Komponenten hat das Jira-Projekt ${f.project}?`,
    truth: async (s, f) =>
      ownedName(await native(s, projectPath(f, "/components")), f.selection.componentName),
  },
  {
    id: "versions",
    tool: "jira.versions",
    alternatives: ["jira.project-version-page"],
    prompt: (f) => `Welche Versionen sind im Jira-Projekt ${f.project} angelegt?`,
    truth: async (s, f) =>
      ownedName(await native(s, projectPath(f, "/versions")), f.selection.versionName),
  },
  {
    id: "remote-links",
    tool: "jira.remote-links",
    prompt: (f) =>
      `Welche externen Links (Remote Links) hängen am Vorgang ${f.selection.issueKey}?`,
    truth: async (s, f) =>
      ownedName(
        await native(s, issuePath(f, "/remotelink")),
        f.selection.remoteLinkTitle,
        (row) => row.object?.title,
      ),
  },
  {
    id: "issue-property-keys",
    tool: "jira.issue-property-keys",
    prompt: (f) =>
      `Welche Entity-Properties sind am Vorgang ${f.selection.issueKey} gespeichert? Nenne die Schlüssel.`,
    truth: async (s, f) =>
      ownedName(
        (await native(s, issuePath(f, "/properties"))).keys ?? [],
        f.selection.propertyKey,
        (row) => row.key,
      ),
  },
  {
    id: "favourite-filters",
    tool: "jira.favourite-filters",
    prompt: () => "Welche Jira-Filter habe ich als Favoriten markiert?",
    truth: async (s, f) =>
      ownedName(await native(s, "/rest/api/2/filter/favourite"), f.selection.filterName),
  },
  {
    id: "boards",
    tool: "jira.boards",
    prompt: () => "Welche Agile-Boards gibt es in unserem Jira?",
    truth: async (s, f) =>
      ownedName(
        (await native(s, "/rest/agile/1.0/board?maxResults=50")).values ?? [],
        f.selection.boardName,
      ),
  },
  {
    id: "sprints",
    tool: "jira.sprints",
    prompt: (f) => `Welche Sprints hat das Agile-Board "${f.selection.boardName}"?`,
    truth: async (s, f) =>
      ownedName(
        (await native(s, `/rest/agile/1.0/board/${f.selection.boardId}/sprint?maxResults=50`))
          .values ?? [],
        f.selection.sprintName,
      ),
  },
];

/** Controls on the curated base catalog, which the model sees without searching. */
const BASE_READS = [
  {
    id: "search",
    tool: "jira.search",
    alternatives: ["jira.search-post"],
    prompt: (f) => `Welche Vorgänge gibt es im Jira-Projekt ${f.project}? Nenne die Schlüssel.`,
    // Every key while the project fits one truth page; otherwise only the two owned issues, which
    // any complete answer names, because a longer listing's first page depends on the tool's order.
    truth: async (s, f) => {
      const jql = encodeURIComponent(`project = ${f.project} ORDER BY key ASC`);
      const page = await native(s, `/rest/api/2/search?jql=${jql}&fields=summary&maxResults=20`);
      return page.total <= page.issues.length
        ? page.issues.map((issue) => issue.key)
        : [f.selection.issueKey, f.selection.linkTargetKey];
    },
  },
  {
    id: "issue",
    tool: "jira.issue",
    // A key search returns the summary just as well (reviewed 2026-11-12). A broader search that
    // merely lists the issue also carries it; both count as an alternative, never as selected.
    alternatives: ["jira.search", "jira.search-post"],
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

/** Write cases on owned synthetic objects; the effect is verified natively and then removed. */
const WRITES = [
  // Components and versions need project administration, which the lab's api actor deliberately
  // lacks; their cases measured a 403/404 refusal. Linking and voting are within its grants.
  {
    id: "issue-link",
    tool: "jira.create-issue-link",
    prompt: (f) =>
      `Verknüpfe den Vorgang ${f.selection.issueKey} mit dem Vorgang ${f.selection.linkTargetKey} über die Verknüpfungsart "Relates".`,
    verify: async (s, f) => {
      const issue = await native(s, issuePath(f, "?fields=issuelinks"));
      const target = f.selection.linkTargetKey;
      const rows = (issue.fields?.issuelinks ?? []).filter(
        (row) => row.outwardIssue?.key === target || row.inwardIssue?.key === target,
      );
      return {
        effects: countMatching(rows, (row) => row.type?.name === "Relates"),
        wrongValue: rows.some((row) => row.type?.name !== "Relates"),
        cleanup: rows.map((row) => `/rest/api/2/issueLink/${row.id}`),
      };
    },
  },
  {
    id: "vote",
    tool: "jira.vote",
    prompt: (f) => `Stimme in Jira für den Vorgang ${f.selection.issueKey} ab.`,
    verify: async (s, f) => {
      const name = actorDetails("api").name;
      const votes = await native(s, issuePath(f, "/votes"));
      const present = countMatching(votes.voters ?? [], (row) => row.name === name);
      // Only the voter can withdraw a vote, so the removal runs as the api actor.
      const removal = {
        key: voteKey(issuePath(f), name),
        path: issuePath(f, "/votes"),
        actor: "api",
      };
      return { effects: present, cleanup: present > 0 ? [removal] : [] };
    },
  },
  {
    id: "remote-link",
    tool: "jira.upsert-remote-link",
    prompt: (f, m, tag) =>
      `Füge dem Vorgang ${f.selection.issueKey} einen externen Link auf https://example.invalid/${tag} mit dem Titel "${m} L" hinzu.`,
    verify: async (s, f, m, tag) => {
      const rows = (await native(s, issuePath(f, "/remotelink"))).filter(
        (row) => row.object?.title === `${m} L`,
      );
      const url = `https://example.invalid/${tag}`;
      return {
        effects: countMatching(rows, (row) => row.object?.url === url),
        wrongValue: rows.some((row) => row.object?.url !== url),
        cleanup: rows.map((row) => issuePath(f, `/remotelink/${row.id}`)),
      };
    },
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
    prompt: (f, m) => {
      // The tool requires a start time, which the request has to supply; "Kommentar" alone would
      // also fit an issue comment, so the text is named as the worklog's description.
      const day = utcDay();
      requestedDays.set(m, day);
      return `Buche auf den Vorgang ${f.selection.issueKey} 30 Minuten Arbeitszeit, begonnen am ${day} um 09:00 Uhr UTC, mit der Beschreibung "${m} W" für die Zeitbuchung.`;
    },
    verify: async (s, f, m) => {
      const page = await native(s, issuePath(f, "/worklog"));
      const rows = page.worklogs.filter((row) => row.comment === `${m} W`);
      const start = Date.parse(`${requestedDays.get(m) ?? utcDay()}${START_HOUR}`);
      const correct = (row) =>
        row.timeSpentSeconds === 1800 && startedInstant(row.started) === start;
      return {
        effects: countMatching(rows, correct),
        wrongValue: rows.some((row) => !correct(row)),
        cleanup: rows.map((row) => issuePath(f, `/worklog/${row.id}`)),
      };
    },
  },
  {
    id: "watch",
    tool: "jira.watch",
    prompt: (f) =>
      `Ich möchte über Änderungen am Vorgang ${f.selection.issueKey} informiert werden. Beobachte ihn ab jetzt für mich.`,
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
