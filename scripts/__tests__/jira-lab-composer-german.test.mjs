// The Composer lane in a German-language session (#4369): the localized type names come from the
// language data the seed recorded, never from a word list; templates are written by that name or by
// id; requests speak German words; the template-recognition grader tells the customer's defect apart.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composerTemplates,
  createPrompt,
  unrepairablePrompt,
  violationPrompt,
} from "../testing/jira-chat-lab/requirements/composer-templates.mjs";
import { composerReader } from "../testing/jira-chat-lab/requirements/composer-run.mjs";
import { gradeTemplateRecognised } from "../testing/jira-chat-lab/requirements/composer-refusals.mjs";
import {
  isLocalized,
  languageData,
  typeLabel,
} from "../testing/jira-chat-lab/requirements/language-names.mjs";
import { languageTables, withActorLocale } from "../testing/jira-chat-lab/seed-language.mjs";

const TYPES = [
  { id: "10000", english: "Epic", localized: "Epic" },
  { id: "10001", english: "Story", localized: "Story" },
  { id: "10002", english: "Task", localized: "Aufgabe" },
  { id: "10003", english: "Sub-task", localized: "Sub-Task" },
  { id: "10004", english: "Bug", localized: "Bug" },
];
const GERMAN = { locale: "de_DE", issueTypes: TYPES, statuses: [] };

const directories = [];
const sessionWith = (language) => {
  const directory = mkdtempSync(join(tmpdir(), "composer-german-"));
  directories.push(directory);
  if (language !== undefined)
    writeFileSync(join(directory, "language.json"), JSON.stringify(language));
  return { directory };
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("the session's recorded type names", () => {
  it("are read from language.json and refused when absent or malformed", () => {
    expect(languageData(sessionWith({ locale: "de_DE", issueTypes: TYPES }))).toMatchObject({
      locale: "de_DE",
      issueTypes: TYPES,
    });
    expect(languageData(sessionWith(undefined))).toBeUndefined();
    expect(
      languageData(sessionWith({ locale: "de_DE", localizedIssueTypeNames: 2 })),
    ).toBeUndefined();
    expect(
      languageData(sessionWith({ locale: "de_DE", issueTypes: [{ id: "1" }] })),
    ).toBeUndefined();
    expect(languageData({})).toBeUndefined();
  });

  it("label a type by its localized name or its id, and are identity without data", () => {
    expect(typeLabel(GERMAN, "Task")).toBe("Aufgabe");
    expect(typeLabel(GERMAN, "Sub-task")).toBe("Sub-Task");
    expect(typeLabel(GERMAN, "Bug")).toBe("Bug");
    expect(typeLabel(GERMAN, "Task", "id")).toBe("10002");
    expect(typeLabel(undefined, "Task")).toBe("Task");
    expect(() => typeLabel(undefined, "Task", "id")).toThrow("no recorded issue type ids");
    expect(() => typeLabel(GERMAN, "Initiative")).toThrow("holds no type Initiative");
    expect(() => typeLabel(GERMAN, "Task", "slug")).toThrow("Unknown type label");
    expect(isLocalized(GERMAN)).toBe(true);
    expect(
      isLocalized({
        ...GERMAN,
        issueTypes: TYPES.map((row) => ({ ...row, localized: row.english })),
      }),
    ).toBe(false);
    expect(isLocalized(undefined)).toBe(false);
  });

  it("let a German session take every Composer journey, and keep the old guard without them", () => {
    expect(composerReader(sessionWith({ locale: "de_DE", issueTypes: TYPES }))).toBe("admin");
    expect(composerReader(sessionWith({ locale: "de_DE" }))).toBe("api");
    expect(composerReader(sessionWith({ locale: "en_US" }))).toBe("admin");
    expect(() => composerReader(sessionWith(undefined))).toThrow("no language.json");
    expect(() => composerReader(sessionWith({ locale: "fr_FR" }))).toThrow(
      "neither en_* nor de_DE",
    );
  });
});

describe("what seed-language records", () => {
  const port = (german) => ({
    async get(actor, path) {
      const localized = german && actor === "api";
      if (path === "/rest/api/2/issuetype")
        return {
          status: 200,
          value: TYPES.map((row) => ({
            id: row.id,
            name: localized ? row.localized : row.english,
          })),
        };
      if (path === "/rest/api/2/status")
        return {
          status: 200,
          value: [{ id: "1", name: localized ? "Zu erledigen" : "To Do" }, { name: "no id" }],
        };
      return { status: 404 };
    },
  });

  it("joins the administrator's names and the actor's by id and drops rows without one", async () => {
    const tables = await languageTables(port(true), "api");
    expect(tables.issueTypes).toEqual(TYPES);
    expect(tables.statuses).toEqual([{ id: "1", english: "To Do", localized: "Zu erledigen" }]);
    const english = await languageTables(port(false), "api");
    expect(english.issueTypes.every((row) => row.english === row.localized)).toBe(true);
  });

  it("sets an actor's profile language for one run and puts the previous one back, also on failure", async () => {
    const locales = new Map([["api", "de_DE"]]);
    const puts = [];
    const jira = {
      async get(actor) {
        return { status: 200, value: { locale: locales.get(actor) } };
      },
      async put(actor, _path, text) {
        puts.push(text);
        locales.set(actor, text);
        return { status: 204 };
      },
    };
    expect(await withActorLocale({}, "api", "en_US", async () => locales.get("api"), jira)).toBe(
      "en_US",
    );
    expect(locales.get("api")).toBe("de_DE");
    await expect(
      withActorLocale({}, "api", "en_US", async () => Promise.reject(new TypeError("boom")), jira),
    ).rejects.toThrow("boom");
    expect(locales.get("api")).toBe("de_DE");
    puts.length = 0;
    await withActorLocale({}, "api", "de_DE", async () => undefined, jira);
    expect(puts).toEqual([]);
    await expect(withActorLocale({}, "api", "fr_FR", async () => undefined, jira)).rejects.toThrow(
      "Unsupported",
    );
    // The refusal happens before anything is read or written.
    expect(puts).toEqual([]);
  });

  it("refuses a locale Jira does not take", async () => {
    const jira = {
      async get() {
        return { status: 200, value: { locale: "de_DE" } };
      },
      async put() {
        return { status: 400 };
      },
    };
    await expect(withActorLocale({}, "api", "en_US", async () => 1, jira)).rejects.toThrow(
      "refused",
    );
  });
});

describe("templates and requests in a German session", () => {
  const byLabel = (kind) =>
    composerTemplates("REQ", "customfield_1", { label: (type) => typeLabel(GERMAN, type, kind) });
  const task = (kind) => byLabel(kind).find((entry) => entry.issueType === "Task");
  const subtask = (kind) => byLabel(kind).find((entry) => entry.issueType === "Sub-task");

  it("write the type as the German session shows it, or as its id, and keep the English id of the lane", () => {
    expect(task("name").markdown).toContain('issueType: "Aufgabe"');
    expect(task("name").label).toBe("Aufgabe");
    expect(task("name").issueType).toBe("Task");
    expect(task("id").markdown).toContain('issueType: "10002"');
    expect(subtask("name").markdown).toContain('parentIssueTypes: ["Aufgabe"]');
    expect(subtask("id").markdown).toContain('parentIssueTypes: ["10002"]');
    // Without a label nothing changes: the English lane's templates are the lane's own.
    const plain = composerTemplates("REQ", "customfield_1").find(
      (entry) => entry.issueType === "Task",
    );
    expect(plain.markdown).toContain('issueType: "Task"');
  });

  it("are said in a German person's words, with no English type name, only when the session is German", () => {
    const fixture = { epic: "REQ-1", task: "REQ-2", story: "REQ-3" };
    const german = { ...fixture, german: true, label: (type) => typeLabel(GERMAN, type) };
    expect(createPrompt("Task", "T", german)).toContain("eine Aufgabe mit dem Titel");
    expect(createPrompt("Task", "T", german)).not.toContain("Vorgangstyp");
    expect(createPrompt("Sub-task", "T", german)).toContain("eine Teilaufgabe mit dem Titel");
    expect(createPrompt("Bug", "T", german)).toContain("einen Fehler mit dem Titel");
    expect(unrepairablePrompt("T", german)).not.toContain("Vorgangstyp");
    expect(violationPrompt("Task", "T", german)).toContain("vom Typ Aufgabe");
    expect(violationPrompt("Sub-task", "T", german)).toContain("vom Typ Sub-Task");
    // The English sessions' prompts are what they always were.
    expect(createPrompt("Task", "T", fixture)).toContain("eine Aufgabe (Vorgangstyp Task)");
    expect(createPrompt("Sub-task", "T", fixture)).toContain(
      "eine Teilaufgabe (Vorgangstyp Sub-task)",
    );
    expect(violationPrompt("Task", "T", fixture)).toContain("vom Typ Task");
  });
});

describe("the template is found for the type the person asked for", () => {
  const refusal = (...ruleIds) => ({
    call: { id: "c", name: "jira_create", arguments: {} },
    result: {
      toolRef: { canonicalId: "keiko.jira.create", contractVersion: 3 },
      status: "failed",
      data: {
        outcome: "rejected",
        reason: "field-validation",
        violations: ruleIds.map((ruleId) => ({ ruleId, subject: "REQ/Aufgabe" })),
      },
    },
  });
  const ports = { noTemplateRules: ["template-missing", "template-not-activated"] };
  const ran = { answer: "Fertig.", toolExchanges: [], failure: undefined };
  const grade = (overrides) =>
    gradeTemplateRecognised({ created: [], exchanges: [], turn: ran, ports, ...overrides });

  it("is green when a content rule of the template refused the violating create", () => {
    const result = grade({ exchanges: [refusal("section-missing", "section-empty")] });
    expect(result.status).toBe("green");
    expect(result.detail).toContain("section-missing");
  });

  it("is RED when the product answered that no template exists although one does (the customer's defect)", () => {
    const result = grade({ exchanges: [refusal("template-missing")] });
    expect(result.status).toBe("red");
    expect(result.detail).toContain("template-missing");
    expect(
      grade({ exchanges: [refusal("section-missing"), refusal("template-not-activated")] }).status,
    ).toBe("red");
  });

  it("is red when the violating request created an issue without any refusal, unverified when nothing was tried", () => {
    const created = [{ key: "REQ-9" }];
    const silent = grade({ created });
    expect(silent.status).toBe("red");
    expect(silent.detail).toContain("REQ-9");
    expect(grade({}).status).toBe("unverified");
    expect(grade({ turn: { answer: "", toolExchanges: [] } }).status).toBe("unverified");
    expect(grade({ turn: undefined }).status).toBe("unverified");
  });

  it("with a producer that defines no missing-template rule, only a content refusal is green", () => {
    const none = { noTemplateRules: [] };
    expect(grade({ ports: none, exchanges: [refusal("section-missing")] }).status).toBe("green");
  });
});
