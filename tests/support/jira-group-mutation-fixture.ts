import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

const ACTOR = { key: "synthetic-actor", name: "operator" };
export const GROUP_MUTATION_USER = { key: "target-key", name: "Target User" };
const BASE = { expectedActorKey: ACTOR.key, groupName: "R&D team" };
export const GROUP_MUTATION_FIXTURE_CASES = [
  { name: "jira.create-group", args: { expectedActorKey: ACTOR.key, groupName: "New & Group" }, method: "POST", path: "group", body: { name: "New & Group" }, confirmed: true,
    receipt: { userKey: ACTOR.key, groupName: "New & Group", groupPresent: true } },
  { name: "jira.delete-group", args: { ...BASE, swapGroupName: "Replacement", acceptGlobalPermissionChange: true, confirmUnverifiedDeletion: true }, method: "DELETE", path: "group?groupname=R%26D+team&swapGroup=Replacement", body: undefined, confirmed: false,
    receipt: { userKey: ACTOR.key, groupName: "R&D team", groupPresent: false, swapGroupName: "Replacement" } },
  { name: "jira.add-group-user", args: { ...BASE, user: GROUP_MUTATION_USER, expectedObservedMembership: false, acceptGlobalPermissionChange: true }, method: "POST", path: "group/user?groupname=R%26D+team", body: { name: "Target User" }, confirmed: false,
    receipt: { userKey: ACTOR.key, groupName: "R&D team", groupPresent: true, targetUserKey: "target-key", requestedDirectMembership: true } },
  { name: "jira.remove-group-user", args: { ...BASE, user: GROUP_MUTATION_USER, expectedObservedMembership: true, acceptGlobalPermissionChange: true }, method: "DELETE", path: "group/user?groupname=R%26D+team&username=Target+User", body: undefined, confirmed: false,
    receipt: { userKey: ACTOR.key, groupName: "R&D team", groupPresent: true, targetUserKey: "target-key", requestedDirectMembership: false } },
] as const;
export function groupMutationFixture(initiallyMember = false) {
  const groups = new Set(["R&D team", "Replacement"]);
  const members: CatalogJsonObject[] = initiallyMember ? [{ ...GROUP_MUTATION_USER }] : [];
  const controls = { lostAck: false, denyReadback: false, wrongReadback: false, missingAckName: false,
    throwReadback: false, aliasUser: false, actorKey: ACTOR.key, memberPageChange: undefined as ((body: Record<string, unknown>, start: number) => void) | undefined };
  const calls: { path: string; method: string; body: unknown; expect: string }[] = [];
  let affected = false;
  const object = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({ ok: true, status: 200, body });
  function beforeRead(): AtlassianWriteHttpOutcome | undefined {
    if (affected && controls.throwReadback) throw new TypeError("fixture post-ACK fault");
    return affected && controls.denyReadback ? { ok: false, reason: "permission-denied", httpStatus: 403 } : undefined;
  }
  function memberPage(url: URL): AtlassianWriteHttpOutcome {
    const start = Number(url.searchParams.get("startAt"));
    const visible = controls.wrongReadback && affected ? [] : members;
    const rows = visible.slice(start, start + 50);
    const native: Record<string, unknown> = { startAt: start, maxResults: 50, isLast: start + rows.length >= visible.length, total: visible.length, values: rows };
    controls.memberPageChange?.(native, start); return object(native);
  }
  function read(url: URL): AtlassianWriteHttpOutcome {
    const refused = beforeRead();
    if (refused !== undefined) return refused;
    switch (url.pathname) {
      case "/myself": return object({ ...ACTOR, key: controls.actorKey });
      case "/user": return object({ ...GROUP_MUTATION_USER, ...(controls.aliasUser ? { key: "other-key" } : {}) });
      case "/groups/picker": {
        const query = url.searchParams.get("query") ?? "";
        const found = [...groups].filter((item) => item.includes(query));
        return object({ groups: found.map((item) => ({ name: item })), total: found.length });
      }
      case "/group/member": return memberPage(url);
      default: throw new TypeError("Unexpected fixture group read");
    }
  }
  function applyEffect(url: URL, method: string, body: unknown): void {
    const target = `${method} ${url.pathname}`;
    switch (target) {
      case "POST /group": {
        const parsed = body as Record<string, unknown>;
        if (typeof parsed.name !== "string") throw new TypeError("Missing native group name");
        groups.add(parsed.name); return;
      }
      case "DELETE /group": groups.delete(url.searchParams.get("groupname") ?? ""); return;
      case "POST /group/user":
        if (!members.some((row) => row.key === GROUP_MUTATION_USER.key)) members.push({ ...GROUP_MUTATION_USER });
        return;
      case "DELETE /group/user": members.splice(0, members.length, ...members.filter((row) => row.key !== GROUP_MUTATION_USER.key)); return;
      default: throw new TypeError("Unexpected native group effect");
    }
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect = "json") => {
    calls.push({ path, method, body: body === undefined ? undefined : structuredClone(body), expect });
    const url = new URL(`https://fixture.invalid/${path}`);
    if (method === "GET") return read(url);
    affected = true; applyEffect(url, method, body);
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    return url.pathname === "/group" && method === "POST"
      ? { ok: true, status: 201, body: controls.missingAckName ? {} : { name: (body as Record<string, unknown>).name } }
      : { ok: true, status: 200, body: undefined };
  };
  return { request, calls, groups, members, controls, snapshot: () => ({ groups: [...groups], members: structuredClone(members) }) };
}
