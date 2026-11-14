// Gives a lab session a German-language Jira (#4369). A German customer instance has localized
// issue types, statuses and resolutions: they reach JQL by name, the report counts by status and the
// template matching. Jira Data Center localizes per user, and every product call runs as the lab
// actor whose Personal Access Token Keiko holds, so the actors' locale decides what Keiko sees.
// The administrator stays English: the lab's administration automation drives labelled English
// pages. Usage: node seed-language.mjs <private-session-directory> [de|en]   (default de)
// Idempotent. `en` restores the English default. Nothing is stored beyond a private receipt.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { actorDetails, basicAuth, labSessionConnection, loadSession } from "./lab-client.mjs";
import { assertLabDirectoryOutsideTemporary } from "./lab-directory.mjs";
import { privateJson } from "./private-json.mjs";

export const LAB_LOCALES = Object.freeze({ de: "de_DE", en: "en_US" });
/** The actors that call Jira for the product or the oracles; the administrator is never switched. */
export const LOCALIZED_ACTORS = Object.freeze([
  "api",
  "restricted",
  "editor",
  "assignee",
  "projectLead",
  "developer",
  "techLead",
]);
const PREFERENCE = "/rest/api/2/mypreferences?key=jira.user.locale";

/** The port to a lab Jira: `get`/`put` take the actor name; `put` sends a bare text body. */
function nativeLocalePort(session) {
  const origin = labSessionConnection(session).origin;
  const call = async (actor, method, path, text) => {
    const response = await globalThis.fetch(new globalThis.URL(path, origin), {
      method,
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(session, actor),
        ...(text === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(text === undefined ? {} : { body: text }),
    });
    const body = await response.text();
    return { status: response.status, value: body === "" ? undefined : JSON.parse(body) };
  };
  return {
    get: (actor, path) => call(actor, "GET", path),
    // Jira reads the preference as the bare locale text, not as a JSON string.
    put: (actor, path, text) => call(actor, "PUT", path, text),
  };
}

const names = (rows) => new Set(rows.map((row) => String(row.name)));

async function expectOk(port, actor, path) {
  const result = await port.get(actor, path);
  if (result.status !== 200) throw new TypeError(`Native read of ${path.split("?")[0]} failed`);
  return result.value;
}

/** How many names an actor sees that the (English) administrator does not. */
async function localizedCount(port, actor, path) {
  const seen = names(await expectOk(port, actor, path));
  const baseline = names(await expectOk(port, "admin", path));
  return [...seen].filter((name) => !baseline.has(name)).length;
}

/**
 * Sets the locale of every present actor and proves it natively: each actor reports the locale,
 * and the localized names visible to the api actor differ from the administrator's (German) or
 * equal them (English). Returns closed counts only.
 */
export async function ensureLabLocale(port, locale, actors) {
  if (!Object.values(LAB_LOCALES).includes(locale)) throw new TypeError("Unsupported lab locale");
  for (const actor of actors) {
    const current = (await expectOk(port, actor, "/rest/api/2/myself")).locale;
    if (current === locale) continue;
    const put = await port.put(actor, PREFERENCE, locale);
    if (put.status !== 204) throw new TypeError(`Jira refused the locale ${locale} for an actor`);
  }
  for (const actor of actors) {
    const reported = (await expectOk(port, actor, "/rest/api/2/myself")).locale;
    if (reported !== locale) throw new TypeError("An actor does not report the requested locale");
  }
  const localizedStatusNames = await localizedCount(port, actors[0], "/rest/api/2/status");
  const localizedIssueTypeNames = await localizedCount(port, actors[0], "/rest/api/2/issuetype");
  // Both kinds of name reach JQL and the template matching, so both must differ (or both equal).
  for (const count of [localizedStatusNames, localizedIssueTypeNames])
    if (locale === LAB_LOCALES.de ? count === 0 : count !== 0)
      throw new TypeError("Jira does not present the names of the requested language");
  return { locale, actors: actors.length, localizedStatusNames, localizedIssueTypeNames };
}

/** The actors this session holds credentials for. */
export function presentActors(session, exists = existsSync) {
  return LOCALIZED_ACTORS.filter((actor) =>
    exists(join(session.directory, "secrets", actorDetails(actor).passwordFile)),
  );
}

export async function main(args) {
  const [directory, language = "de", ...extra] = args;
  if (!directory || extra.length > 0 || !Object.hasOwn(LAB_LOCALES, language))
    throw new TypeError("Usage: seed-language.mjs <session-directory> [de|en]");
  assertLabDirectoryOutsideTemporary(directory);
  const session = loadSession(directory);
  const actors = presentActors(session);
  if (!actors.includes("api")) throw new TypeError("The session holds no api actor to localize");
  const facts = await ensureLabLocale(nativeLocalePort(session), LAB_LOCALES[language], actors);
  privateJson(join(session.directory, "language.json"), { schemaVersion: 1, ...facts });
  console.log(JSON.stringify({ operation: "jira-lab-language", ...facts }));
  return facts;
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
