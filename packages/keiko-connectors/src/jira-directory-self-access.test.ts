import { describe, expect, it } from "vitest";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { guardJiraDirectorySelfAccess } from "./jira-directory-self-access.js";
const actor = { key: "actor-key", name: "operator" };
const change = { kind: "roles" as const, actor: actor.key, bulk: false, roles: [{
  expected: { key: "jira-software", groups: ["admins", "retained"], defaultGroups: [] },
  value: { key: "jira-software", groups: ["retained"], defaultGroups: [] },
}] };
describe("directory role self-access dependency guard", () => {
  it("refuses an observed actor group removal before any write", async () => {
    const calls: string[] = [];
    const request: JiraMutationRequest = async (path, method) => {
      calls.push(`${method} ${path}`);
      return { ok: true, status: 200, body: { ...actor, groups: { size: 1, items: [{ name: "admins" }] } } };
    };
    const result = await guardJiraDirectorySelfAccess(request, change, actor);
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(JSON.stringify(result)).toContain("different authorized Jira administrator");
    expect(calls).toEqual(["GET user?key=actor-key&expand=groups"]);
  });
  it.each([
    { groups: undefined }, { groups: null }, { groups: { size: 1, items: [] } },
    { groups: { size: 0 } }, { groups: { size: 2, items: [{ name: "other" }, { name: "other" }] } },
    { key: "foreign", groups: { size: 0, items: [] } },
  ])("never turns incomplete or foreign actor evidence into safe absence %#", async (patch) => {
    const request: JiraMutationRequest = async () => ({ ok: true, status: 200, body: { ...actor, ...patch } });
    expect(await guardJiraDirectorySelfAccess(request, change, actor)).toMatchObject({ ok: false, reason: "unavailable" });
  });
  it("admits only a complete observed disjoint group set", async () => {
    const request: JiraMutationRequest = async () => ({ ok: true, status: 200, body: { ...actor, groups: { size: 1, items: [{ name: "retained" }] } } });
    expect(await guardJiraDirectorySelfAccess(request, change, actor)).toBeUndefined();
  });
  it("adds no actor expansion when a role only adds groups or changes future defaults", async () => {
    const request: JiraMutationRequest = async () => { throw new TypeError("No expansion expected"); };
    const role = { key: "jira-software", groups: ["admins"], defaultGroups: [] };
    expect(await guardJiraDirectorySelfAccess(request,
      { ...change, roles: [{ expected: role, value: { ...role, groups: ["admins", "new"] } }] }, actor)).toBeUndefined();
  });
});
