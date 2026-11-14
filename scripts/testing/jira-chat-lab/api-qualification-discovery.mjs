// The discover -> describe -> dispatch proof of the qualification (#4357 AC2, #4369): before an
// operation is dispatched, the product's own `jira.discover` is asked for it in the words a person
// would use, the entry it returns is described by the identity it returned, and the described
// operation must be the one that is then offered and executed in the same accepted turn. Nothing is
// addressed by registry identity alone for the operations listed here.
import assert from "node:assert/strict";
import { createJiraCatalogDiscoveryProvider } from "../../../packages/keiko-server/dist/atlassian/jiraCatalogDiscovery.js";

/** What a person types to find an operation outside the base set: plain operation words, no tool name. */
export const DISCOVERY_QUERIES = Object.freeze({
  "jira.update-comment": "edit a comment",
  "jira.get-comment": "read one comment",
  "jira.create-issue-link": "link two issues",
  "jira.link-types": "issue link types",
  "jira.users": "search users",
  "jira.myself": "who am I",
  "jira.fields": "find a field by name",
  "jira.priorities": "priorities",
  "jira.statuses": "statuses",
  "jira.resolutions": "resolutions",
  "jira.project-statuses": "project statuses",
});

/** The most pages of hits the proof reads before it declares the operation not discoverable. */
const PAGES_MAX = 3;

/** The descriptor (tool reference included) the product declares for `jira.discover` or `jira.describe`. */
export async function discoveryDescriptor(name) {
  const tools = await createJiraCatalogDiscoveryProvider().tools({});
  const declared = tools.find((tool) => tool.name === name);
  assert.ok(declared, `The product declares no ${name}`);
  return declared.descriptor;
}

/**
 * Runs the proof for one operation through `call(name, args)` (the held turn's dispatcher for a
 * discovery tool, which returns the settled result's data) and returns its body-free record.
 */
export async function proveDiscovery(specification, call) {
  const query = DISCOVERY_QUERIES[specification.tool];
  assert.ok(query, `No discovery query is declared for ${specification.tool}`);
  let found;
  let rank = 0;
  let pages = 0;
  for (let startAt = 0; found === undefined && pages < PAGES_MAX; pages += 1) {
    const page = await call("jira.discover", { query, startAt });
    assert.equal(page.outcome, "succeeded", "jira.discover did not succeed");
    const items = Array.isArray(page.items) ? page.items : [];
    const at = items.findIndex((item) => item.identity === specification.identity);
    if (at >= 0) {
      found = items[at];
      rank = startAt + at + 1;
    }
    if (found !== undefined || page.nextStartAt === undefined) break;
    startAt = page.nextStartAt;
  }
  assert.ok(found, `jira.discover did not list ${specification.tool} for "${query}"`);
  // Described by the identity discover returned, exactly as a model copies it.
  const described = await call("jira.describe", { identities: [found.identity] });
  assert.equal(described.outcome, "succeeded", "jira.describe did not succeed");
  assert.equal(described.selectedFor, "next-round");
  assert.equal(described.deselected, undefined, "jira.describe replaced an earlier selection");
  assert.ok(
    (described.items ?? []).some((item) => item.identity === specification.identity),
    `jira.describe did not select ${specification.tool}`,
  );
  return {
    tool: specification.tool,
    identity: specification.identity,
    query,
    discoveredAtRank: rank,
    discoverPages: pages + 1,
    describedBy: "identity",
    selectedFor: described.selectedFor,
  };
}
