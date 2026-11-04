// Gives the report project RPT a real estimate field so scenario S10 can grade estimate totals.
// Usage: node seed-estimates.mjs <private-session-directory>
// Idempotent: run it after seed-projects.mjs; a second run changes nothing. See estimate-field.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { basicAuth, checked, labRequest, loadSession } from "../lab-client.mjs";
import { privateJson } from "../private-json.mjs";
import { seedEstimates } from "./estimate-field.mjs";

const [directory] = process.argv.slice(2);
if (!directory) throw new TypeError("Usage: seed-estimates.mjs <session-directory>");
const session = loadSession(directory);
const auth = basicAuth(session, "admin");
const truthPath = join(session.directory, "requirements-truth.json");
const truth = JSON.parse(readFileSync(truthPath, "utf8"));

const jira = {
  call: (name, method, path, body, expected) =>
    checked(session, name, method, path, auth, body, expected),
  request: (method, path, body) => labRequest(session, method, path, auth, body),
};

const summary = await seedEstimates(jira, truth, (updated) => privateJson(truthPath, updated));
console.log(JSON.stringify({ operation: "requirements-estimates", ...summary }));
