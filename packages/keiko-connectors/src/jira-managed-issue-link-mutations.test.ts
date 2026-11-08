import { expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { executeJiraIssueLinkMutation, isJiraIssueLinkMutation } from "./jira-managed-issue-link-mutations.js";

const TYPE = { id: "9", name: "Blocks", inward: "is blocked by", outward: "blocks" };
const FIRST = { id: "10001", key: "SYN-1" };
const SECOND = { id: "10002", key: "SYN-2" };
const ID = "9007199254740993";
const INPUT: CatalogJsonObject = { inwardIssueIdOrKey: FIRST.key, outwardIssueIdOrKey: SECOND.key, expectedActorKey: "synthetic-actor", linkType: TYPE };
function adjacency(inward: boolean, id = ID): Record<string, unknown> {
  return { id, type: TYPE, [inward ? "outwardIssue" : "inwardIssue"]: inward ? SECOND : FIRST };
}
function response(body: Record<string, unknown> | undefined, status = 200): AtlassianWriteHttpOutcome { return { ok: true, status, body }; }
interface Scenario {
  readonly deleting?: boolean;
  readonly before?: readonly unknown[];
  readonly after?: readonly unknown[];
  readonly missingField?: boolean;
  readonly type?: Record<string, unknown>;
  readonly actor?: string;
  readonly afterActor?: string;
  readonly write?: AtlassianWriteHttpOutcome;
  readonly afterRead?: AtlassianWriteHttpOutcome | Error;
  readonly direct?: Record<string, unknown>;
  readonly extraRelation?: boolean;
  readonly recheckChanged?: boolean;
}
function fixture(options: Scenario = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let written = false;
  let issueReads = 0;
  return vi.fn<JiraMutationRequest>(async (path, method = "GET") => {
    if (method !== "GET") {
      written = true;
      return options.write ?? response(undefined, options.deleting ? 204 : 201);
    }
    if (path === "myself") return response({ key: written ? options.afterActor ?? "synthetic-actor" : options.actor ?? "synthetic-actor", name: "synthetic.user" });
    if (written && options.afterRead !== undefined) {
      if (options.afterRead instanceof Error) throw options.afterRead;
      return options.afterRead;
    }
    if (path === "issueLinkType/9") return response(options.type ?? TYPE);
    if (path === `issueLink/${ID}`) return response(options.direct ?? { id: ID, type: TYPE, inwardIssue: FIRST, outwardIssue: SECOND });
    const selected = path.split("?")[0];
    const inward = selected === `issue/${FIRST.id}` || selected?.toUpperCase() === `ISSUE/${FIRST.key}`;
    const outward = selected === `issue/${SECOND.id}` || selected?.toUpperCase() === `ISSUE/${SECOND.key}`;
    if (!inward && !outward) throw new TypeError(`Unexpected native request: ${path}`);
    issueReads++;
    const present = written ? !options.deleting : options.deleting === true;
    const edges = (written ? options.after : options.before) ?? (present ? [adjacency(inward)] : []);
    const added = options.extraRelation ? [adjacency(inward, "777")] : [];
    const changed = options.recheckChanged && issueReads > 2 && !written ? [adjacency(inward, "888")] : [];
    return response({ ...(inward ? FIRST : SECOND), fields: { summary: "Synthetic", description: "", labels: [], project: { key: "SYN" }, issuetype: { id: "10", name: "Story" },
      ...(options.missingField ? {} : { issuelinks: [...edges, ...added, ...changed] }) } });
  });
}
function effects(request: ReturnType<typeof fixture>): readonly Parameters<JiraMutationRequest>[] { return request.mock.calls.filter(([, method = "GET"]) => method !== "GET"); }
function run(request: JiraMutationRequest, deleting = false, args: CatalogJsonObject = INPUT, check = false, templates?: JiraIssueTemplateSource) {
  return executeJiraIssueLinkMutation(deleting ? "jira.delete-issue-link" : "jira.create-issue-link", deleting ? { ...args, linkId: ID } : args, request, check, templates);
}
function requiredLinkTemplate(): JiraIssueTemplateSource {
  const parsed = parseJiraIssueTemplate("---\nkeiko: jira-issue-template\nversion: 1\nproject: SYN\nissueType: Story\nactivateOn: [edit]\nparentLink: Blocks\n---\n");
  if (!parsed.ok) throw new TypeError("Invalid synthetic template");
  return () => ({ templates: [parsed.template], unreadable: 0 });
}

it("exposes only the two fixed issue-link effects", () => {
  expect(isJiraIssueLinkMutation("jira.create-issue-link")).toBe(true);
  expect(isJiraIssueLinkMutation("jira.delete-issue-link-type")).toBe(false);
});
it.each([FIRST.key.toLowerCase(), FIRST.id])("binds %s to canonical numeric parents and confirms one new relation ID", async (inwardIssueIdOrKey) => {
  const request = fixture();
  expect(await run(request, false, { ...INPUT, inwardIssueIdOrKey })).toEqual({ ok: true, receipt: {
    issueId: FIRST.id, issueKey: FIRST.key, linkedIssueId: SECOND.id, linkedIssueKey: SECOND.key, linkTypeId: TYPE.id, linkId: ID, userKey: "synthetic-actor", linkPresent: true,
  } });
  expect(effects(request)).toEqual([["issueLink", "POST", { type: { id: "9" }, inwardIssue: { id: FIRST.id }, outwardIssue: { id: SECOND.id } }, "none"]]);
  expect(request.mock.calls.at(-1)?.[0]).toBe(`issueLink/${ID}`);
});
it("deletes exactly the bound link and proves complete absence on both parents", async () => {
  const request = fixture({ deleting: true });
  expect(await run(request, true)).toMatchObject({ ok: true, receipt: { linkId: ID, linkPresent: false } });
  expect(effects(request)).toEqual([[`issueLink/${ID}`, "DELETE", undefined, "none"]]);
});
it.each([false, true])("dry-run %s sends no POST or DELETE", async (deleting) => {
  const request = fixture({ deleting });
  expect(await run(request, deleting, INPUT, true)).toEqual({ ok: true, receipt: {} });
  expect(effects(request)).toHaveLength(0);
});
it("refuses the last required parent relation using the planned complete post-delete state", async () => {
  const request = fixture({ deleting: true });
  expect(await run(request, true, INPUT, false, requiredLinkTemplate())).toMatchObject({ ok: false, reason: "field-validation" });
  expect(effects(request)).toHaveLength(0);
});
it("admits deletion when another observed required relation remains", async () => {
  const request = fixture({ deleting: true, extraRelation: true });
  expect(await run(request, true, INPUT, false, requiredLinkTemplate())).toMatchObject({ ok: true, receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(1);
});
it("admits the new required relation in the same template owner rather than the prior empty state", async () => {
  const request = fixture();
  expect(await run(request, false, INPUT, false, requiredLinkTemplate())).toMatchObject({ ok: true });
  expect(effects(request)).toHaveLength(1);
});
it.each([
  { actor: "changed-actor" }, { type: { ...TYPE, name: "Changed" } }, { missingField: true }, { recheckChanged: true },
])("refuses changed or unavailable admission evidence before the effect: %j", async (scenario) => {
  const request = fixture(scenario);
  expect(await run(request)).toMatchObject({ ok: false });
  expect(effects(request)).toHaveLength(0);
});
it("does not turn a duplicate relation into another POST", async () => {
  const request = fixture({ deleting: true });
  expect(await run(request)).toMatchObject({ ok: false, detail: { unchanged: true }, receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(0);
});
it("does not use a contradictory selected link to delete a relation", async () => {
  const request = fixture({ deleting: true, direct: { id: ID, type: TYPE, inwardIssue: SECOND, outwardIssue: FIRST } });
  expect(await run(request, true)).toMatchObject({ ok: false, reason: "conflict" });
  expect(effects(request)).toHaveLength(0);
});
it.each(["unavailable", "timeout"] as const)("retains parent identities after lost %s acknowledgement without rereading or replaying", async (reason) => {
  const request = fixture({ write: { ok: false, reason } });
  expect(await run(request)).toMatchObject({ ok: false, reason, receipt: { issueId: FIRST.id, linkedIssueId: SECOND.id, linkPresent: true } });
  expect(effects(request)).toHaveLength(1);
  expect(request.mock.calls.at(-1)?.[1]).toBe("POST");
});
it.each([false, true])("a denied or missing post-ACK state never proves success for delete=%s", async (deleting) => {
  const request = fixture({ deleting, afterRead: { ok: false, reason: "not-found" } });
  expect(await run(request, deleting)).toMatchObject({ ok: false, reason: "not-found", receipt: { linkPresent: !deleting } });
  expect(effects(request)).toHaveLength(1);
});
it("retains a freshly observed native link ID when its independent detail contradicts the parents", async () => {
  const request = fixture({ direct: { id: ID, type: TYPE, inwardIssue: SECOND, outwardIssue: FIRST } });
  expect(await run(request)).toMatchObject({ ok: false, reason: "conflict", receipt: { linkId: ID } });
});
it("does not swallow a post-ACK programming error or discard the known delete ID", async () => {
  const cause = new TypeError("Synthetic readback error");
  const request = fixture({ deleting: true, afterRead: cause });
  await expect(run(request, true)).rejects.toMatchObject({ name: "JiraAcknowledgedMutationError", cause, receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(1);
});
it.each([
  { ...INPUT, comment: "Second effect" }, { ...INPUT, linkType: { ...TYPE, self: "https://example.invalid" } },
  { ...INPUT, inwardIssueIdOrKey: "../issue" }, { ...INPUT, method: "DELETE" },
])("refuses widened inputs without any request", async (args) => {
  const request = fixture();
  expect(await run(request, false, args)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(request).not.toHaveBeenCalled();
});
