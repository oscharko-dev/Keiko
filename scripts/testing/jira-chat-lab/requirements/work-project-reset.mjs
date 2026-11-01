// The seed contract says the work project REQ is empty when a creation journey starts (#4174), but
// every earlier round of both lanes left its epics, tasks and sub-tasks there. A journey then met
// whatever the last run happened to leave: on 2026-11-01 Gemma's S09 found the sub-tasks a run at
// 16:58 had created and correctly created none, Qwen's S05 only reconciled three earlier epics, and
// S18's Full access mode could not be judged. Every journey that writes REQ therefore empties it
// first, while it holds the work-project lock, so no other lane's journey is in REQ at that moment.
// The prompts create any epic or task they need when it is missing, so an empty start asks nothing
// a journey does not already ask.
import { basicAuth, labRequest } from "../lab-client.mjs";

/** The project every creation journey names in its prompt. */
export const WORK_PROJECT = "REQ";
/** More pages than any lab round leaves behind; a project that never empties is a lab error. */
const PAGE_LIMIT = 50;
const PAGE_SIZE = 100;

async function issueKeys(session, project, auth) {
  const jql = encodeURIComponent(`project = ${project} ORDER BY key ASC`);
  const path = `/rest/api/2/search?jql=${jql}&startAt=0&maxResults=${PAGE_SIZE}&fields=issuetype`;
  const page = await labRequest(session, "GET", path, auth);
  if (page.status !== 200) throw new TypeError(`Work-project read failed (${page.status})`);
  return page.value.issues.map((issue) => issue.key);
}

/** A sub-task deleted with its parent answers 404 afterwards; that is the state we want. */
async function deleteIssue(session, key, auth) {
  const path = `/rest/api/2/issue/${encodeURIComponent(key)}?deleteSubtasks=true`;
  const result = await labRequest(session, "DELETE", path, auth);
  if (result.status !== 204 && result.status !== 404) {
    throw new TypeError(`Work-project delete failed (${result.status})`);
  }
}

/** Deletes every issue of `project` through the admin REST API and logs how many it removed. */
export async function clearWorkProject(session, project, { log } = {}) {
  if (!/^[A-Z][A-Z0-9]{1,9}$/u.test(project)) throw new TypeError("Unexpected work-project key");
  const auth = basicAuth(session, "admin");
  let removed = 0;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const keys = await issueKeys(session, project, auth); // NOSONAR typescript:S9382 -- each page is read after the previous one is deleted
    if (keys.length === 0) {
      log?.({ operation: "requirements-work-project", project, state: "cleared", removed });
      return removed;
    }
    for (const key of keys) await deleteIssue(session, key, auth); // NOSONAR typescript:S9382 -- one delete at a time keeps parent and sub-task deletes from racing
    removed += keys.length;
  }
  throw new TypeError(`Work project ${project} did not empty within ${PAGE_LIMIT} pages`);
}
