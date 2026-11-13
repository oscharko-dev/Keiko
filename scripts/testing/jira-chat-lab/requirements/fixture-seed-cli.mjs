// The shared command of the lab's fixture seeds (#4369): one session, the administrator's native
// port, the qualification field lifted for the writes, one private truth receipt and one closed line.
import { join } from "node:path";
import { basicAuth, checked, labRequest, loadSession } from "../lab-client.mjs";
import { assertLabDirectoryOutsideTemporary } from "../lab-directory.mjs";
import { privateJson } from "../private-json.mjs";
import { withFixtureFieldOptional } from "../seed-fields.mjs";

/**
 * Runs `seed(context, jira, save)` for the session in `args[0]`. `jira.call` throws on an unexpected
 * status and `jira.request` never throws, as in the estimate seed.
 */
export async function runFixtureSeed({ args, name, receipt, operation, seed }) {
  const [directory, ...extra] = args;
  if (!directory || extra.length > 0) throw new TypeError(`Usage: ${name} <session-directory>`);
  assertLabDirectoryOutsideTemporary(directory);
  const session = loadSession(directory);
  const auth = basicAuth(session, "admin");
  const jira = {
    call: (step, method, path, body, expected) =>
      checked(session, step, method, path, auth, body, expected),
    request: (method, path, body) => labRequest(session, method, path, auth, body),
  };
  // The qualification field is required in Jira's one default field configuration.
  const summary = await withFixtureFieldOptional(session, () =>
    seed({ session, auth }, jira, (truth) => privateJson(join(session.directory, receipt), truth)),
  );
  console.log(JSON.stringify({ operation, ...summary }));
  return summary;
}
