import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { settleSync } from "./jira-fixture-settle.js";

const ACTOR = { key: "synthetic-actor", name: "operator" };
export const GROUP_MUTATION_USER = { key: "target-key", name: "Target User" };
const BASE = { expectedActorKey: ACTOR.key, groupName: "R&D team" };
export const GROUP_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.create-group",
    args: { expectedActorKey: ACTOR.key, groupName: "New & Group" },
    method: "POST",
    path: "group",
    body: { name: "New & Group" },
    confirmed: true,
    receipt: { userKey: ACTOR.key, groupName: "New & Group", groupPresent: true },
  },
  {
    name: "jira.delete-group",
    args: {
      ...BASE,
      swapGroupName: "Replacement",
      acceptGlobalPermissionChange: true,
      confirmUnverifiedDeletion: true,
    },
    method: "DELETE",
    path: "group?groupname=R%26D+team&swapGroup=Replacement",
    body: undefined,
    confirmed: false,
    receipt: {
      userKey: ACTOR.key,
      groupName: "R&D team",
      groupPresent: false,
      swapGroupName: "Replacement",
    },
  },
  {
    name: "jira.add-group-user",
    args: {
      ...BASE,
      user: GROUP_MUTATION_USER,
      expectedObservedMembership: false,
      acceptGlobalPermissionChange: true,
    },
    method: "POST",
    path: "group/user?groupname=R%26D+team",
    body: { name: "Target User" },
    confirmed: false,
    receipt: {
      userKey: ACTOR.key,
      groupName: "R&D team",
      groupPresent: true,
      targetUserKey: "target-key",
      requestedDirectMembership: true,
    },
  },
  {
    name: "jira.remove-group-user",
    args: {
      ...BASE,
      user: GROUP_MUTATION_USER,
      expectedObservedMembership: true,
      acceptGlobalPermissionChange: true,
    },
    method: "DELETE",
    path: "group/user?groupname=R%26D+team&username=Target+User",
    body: undefined,
    confirmed: false,
    receipt: {
      userKey: ACTOR.key,
      groupName: "R&D team",
      groupPresent: true,
      targetUserKey: "target-key",
      requestedDirectMembership: false,
    },
  },
] as const;
interface GroupMutationControls {
  lostAck: boolean;
  denyReadback: boolean;
  wrongReadback: boolean;
  missingAckName: boolean;
  throwReadback: boolean;
  aliasUser: boolean;
  actorKey: string;
  memberPageChange: ((body: Record<string, unknown>, start: number) => void) | undefined;
}
interface GroupMutationState {
  readonly groups: Set<string>;
  readonly members: CatalogJsonObject[];
  readonly controls: GroupMutationControls;
  readonly calls: { path: string; method: string; body: unknown; expect: string }[];
  affected: boolean;
}
export interface GroupMutationFixture {
  readonly request: JiraMutationRequest;
  readonly calls: GroupMutationState["calls"];
  readonly groups: Set<string>;
  readonly members: CatalogJsonObject[];
  readonly controls: GroupMutationControls;
  snapshot(): { groups: string[]; members: CatalogJsonObject[] };
}

function groupObject(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}

function groupBeforeRead(state: GroupMutationState): AtlassianWriteHttpOutcome | undefined {
  if (state.affected && state.controls.throwReadback) throw new TypeError("fixture post-ACK fault");
  return state.affected && state.controls.denyReadback
    ? { ok: false, reason: "permission-denied", httpStatus: 403 }
    : undefined;
}

function groupMemberPage(state: GroupMutationState, url: URL): AtlassianWriteHttpOutcome {
  const { controls, members } = state;
  const start = Number(url.searchParams.get("startAt"));
  const visible = controls.wrongReadback && state.affected ? [] : members;
  const rows = visible.slice(start, start + 50);
  const native: Record<string, unknown> = {
    startAt: start,
    maxResults: 50,
    isLast: start + rows.length >= visible.length,
    total: visible.length,
    values: rows,
  };
  controls.memberPageChange?.(native, start);
  return groupObject(native);
}

function groupPicker(state: GroupMutationState, url: URL): AtlassianWriteHttpOutcome {
  const query = url.searchParams.get("query") ?? "";
  const found = [...state.groups].filter((item) => item.includes(query));
  return groupObject({ groups: found.map((item) => ({ name: item })), total: found.length });
}

function groupRead(state: GroupMutationState, url: URL): AtlassianWriteHttpOutcome {
  const refused = groupBeforeRead(state);
  if (refused !== undefined) return refused;
  switch (url.pathname) {
    case "/myself":
      return groupObject({ ...ACTOR, key: state.controls.actorKey });
    case "/user":
      return groupObject({
        ...GROUP_MUTATION_USER,
        ...(state.controls.aliasUser ? { key: "other-key" } : {}),
      });
    case "/groups/picker":
      return groupPicker(state, url);
    case "/group/member":
      return groupMemberPage(state, url);
    default:
      throw new TypeError("Unexpected fixture group read");
  }
}

function groupApplyEffect(
  state: GroupMutationState,
  url: URL,
  method: string,
  body: unknown,
): void {
  const { groups, members } = state;
  const target = `${method} ${url.pathname}`;
  switch (target) {
    case "POST /group": {
      const parsed = body as Record<string, unknown>;
      if (typeof parsed.name !== "string") throw new TypeError("Missing native group name");
      groups.add(parsed.name);
      return;
    }
    case "DELETE /group":
      groups.delete(url.searchParams.get("groupname") ?? "");
      return;
    case "POST /group/user":
      if (!members.some((row) => row.key === GROUP_MUTATION_USER.key))
        members.push({ ...GROUP_MUTATION_USER });
      return;
    case "DELETE /group/user":
      members.splice(
        0,
        members.length,
        ...members.filter((row) => row.key !== GROUP_MUTATION_USER.key),
      );
      return;
    default:
      throw new TypeError("Unexpected native group effect");
  }
}

function groupEffect(
  state: GroupMutationState,
  url: URL,
  method: string,
  body: unknown,
): AtlassianWriteHttpOutcome {
  state.affected = true;
  groupApplyEffect(state, url, method, body);
  if (state.controls.lostAck) return { ok: false, reason: "timeout" };
  return url.pathname === "/group" && method === "POST"
    ? {
        ok: true,
        status: 201,
        body: state.controls.missingAckName ? {} : { name: (body as Record<string, unknown>).name },
      }
    : { ok: true, status: 200, body: undefined };
}

function groupResponse(
  state: GroupMutationState,
  path: string,
  method: string,
  body: unknown,
  expect: string,
): AtlassianWriteHttpOutcome {
  state.calls.push({
    path,
    method,
    body: body === undefined ? undefined : structuredClone(body),
    expect,
  });
  const url = new URL(`https://fixture.invalid/${path}`);
  return method === "GET" ? groupRead(state, url) : groupEffect(state, url, method, body);
}

export function groupMutationFixture(initiallyMember = false): GroupMutationFixture {
  const state: GroupMutationState = {
    groups: new Set(["R&D team", "Replacement"]),
    members: initiallyMember ? [{ ...GROUP_MUTATION_USER }] : [],
    controls: {
      lostAck: false,
      denyReadback: false,
      wrongReadback: false,
      missingAckName: false,
      throwReadback: false,
      aliasUser: false,
      actorKey: ACTOR.key,
      memberPageChange: undefined,
    },
    calls: [],
    affected: false,
  };
  const request: JiraMutationRequest = (path, method = "GET", body, expect = "json") =>
    settleSync(() => groupResponse(state, path, method, body, expect));
  return {
    request,
    calls: state.calls,
    groups: state.groups,
    members: state.members,
    controls: state.controls,
    snapshot: () => ({
      groups: [...state.groups],
      members: structuredClone(state.members),
    }),
  };
}
