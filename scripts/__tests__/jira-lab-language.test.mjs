// The German-language lab session (#4369): per-actor locale, proven natively, administrator untouched.
import { describe, expect, it } from "vitest";
import {
  LAB_LOCALES,
  LOCALIZED_ACTORS,
  ensureLabLocale,
  presentActors,
} from "../testing/jira-chat-lab/seed-language.mjs";

const ENGLISH = ["To Do", "In Progress", "Done"];
const GERMAN = ["Zu erledigen", "In Arbeit", "Fertig"];
const TYPES_EN = ["Task", "Bug"];
const TYPES_DE = ["Aufgabe", "Bug"];

/** A fake Jira: locale per actor; the status names follow the actor's locale, as Jira's do. */
function fakeJira({ initial = {}, refuse = false, localizes = true, typesLocalized = true } = {}) {
  const locales = new Map(Object.entries(initial));
  const puts = [];
  const localeOf = (actor) => locales.get(actor) ?? "en_US";
  return {
    puts,
    async get(actor, path) {
      if (path === "/rest/api/2/myself") return { status: 200, value: { locale: localeOf(actor) } };
      if (path === "/rest/api/2/status") {
        const german = localizes && localeOf(actor) === "de_DE";
        return { status: 200, value: (german ? GERMAN : ENGLISH).map((name) => ({ name })) };
      }
      if (path === "/rest/api/2/issuetype") {
        const german = typesLocalized && localizes && localeOf(actor) === "de_DE";
        return { status: 200, value: (german ? TYPES_DE : TYPES_EN).map((name) => ({ name })) };
      }
      return { status: 404 };
    },
    async put(actor, path, text) {
      puts.push([actor, path, text]);
      if (refuse) return { status: 400 };
      locales.set(actor, text);
      return { status: 204 };
    },
  };
}

describe("ensureLabLocale", () => {
  it("sets the bare locale for each actor and proves German names natively", async () => {
    const jira = fakeJira();
    expect(await ensureLabLocale(jira, LAB_LOCALES.de, ["api", "editor"])).toEqual({
      locale: "de_DE",
      actors: 2,
      localizedStatusNames: 3,
      localizedIssueTypeNames: 1,
    });
    expect(jira.puts).toEqual([
      ["api", "/rest/api/2/mypreferences?key=jira.user.locale", "de_DE"],
      ["editor", "/rest/api/2/mypreferences?key=jira.user.locale", "de_DE"],
    ]);
  });

  it("is idempotent and never touches an actor that already has the locale", async () => {
    const jira = fakeJira({ initial: { api: "de_DE" } });
    await ensureLabLocale(jira, LAB_LOCALES.de, ["api"]);
    expect(jira.puts).toEqual([]);
  });

  it("restores English and proves the names equal the administrator's", async () => {
    const jira = fakeJira({ initial: { api: "de_DE" } });
    expect(await ensureLabLocale(jira, LAB_LOCALES.en, ["api"])).toMatchObject({
      locale: "en_US",
      localizedStatusNames: 0,
      localizedIssueTypeNames: 0,
    });
  });

  it("fails closed when Jira refuses the locale", async () => {
    await expect(
      ensureLabLocale(fakeJira({ refuse: true }), LAB_LOCALES.de, ["api"]),
    ).rejects.toThrow("refused");
  });

  it("fails closed when the locale is set but Jira shows no German names", async () => {
    await expect(
      ensureLabLocale(fakeJira({ localizes: false }), LAB_LOCALES.de, ["api"]),
    ).rejects.toThrow("names of the requested language");
  });

  it("fails closed when status names are German but issue type names are not", async () => {
    await expect(
      ensureLabLocale(fakeJira({ typesLocalized: false }), LAB_LOCALES.de, ["api"]),
    ).rejects.toThrow("names of the requested language");
  });

  it("refuses an unsupported locale before any write", async () => {
    const jira = fakeJira();
    await expect(ensureLabLocale(jira, "fr_FR", ["api"])).rejects.toThrow(TypeError);
    expect(jira.puts).toEqual([]);
  });
});

describe("actor selection", () => {
  it("never includes the administrator, whose labelled English pages the lab automates", () => {
    expect(LOCALIZED_ACTORS).not.toContain("admin");
    expect(LOCALIZED_ACTORS).toContain("api");
  });

  it("lists only actors the session holds credentials for", () => {
    const present = new Set(["api-user-password", "editor-password"]);
    const exists = (path) => present.has(path.split("/").at(-1));
    expect(presentActors({ directory: "/s" }, exists)).toEqual(["api", "editor"]);
  });
});
