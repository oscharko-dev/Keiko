import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";

const ORIGINAL = { id: "7", name: "Delivery", description: "Current category" };
export const PROJECT_CATEGORY_FIXTURE_CASES = [
  {
    name: "jira.create-project-category",
    args: {
      expectedActorKey: "synthetic-actor",
      name: "Planning",
      description: "Created category",
    },
    method: "POST",
    path: "/rest/api/2/projectCategory",
    body: { name: "Planning", description: "Created category" },
  },
  {
    name: "jira.update-project-category",
    args: {
      expectedActorKey: "synthetic-actor",
      expectedCategory: ORIGINAL,
      name: "Delivery revised",
      description: "",
    },
    method: "PUT",
    path: "/rest/api/2/projectCategory/7",
    body: { name: "Delivery revised", description: "" },
  },
  {
    name: "jira.delete-project-category",
    args: {
      expectedActorKey: "synthetic-actor",
      expectedCategory: ORIGINAL,
      confirmUnverifiedDeletion: true,
    },
    method: "DELETE",
    path: "/rest/api/2/projectCategory/7",
    body: undefined,
  },
] as const;
function success(body?: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
function targetFields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new TypeError("Synthetic category effect requires the exact native object body");
  return { name: Reflect.get(body, "name"), description: Reflect.get(body, "description") };
}
interface CategoryControls {
  denyReadback: boolean;
  loseAck: boolean;
  ackIdOnly: boolean;
  malformedAck: boolean;
  wrongReadback: boolean;
  nullDescription: boolean;
}
interface CategoryCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly expect: string;
}
interface CategoryState {
  readonly actor: { key: string; name: string };
  readonly categories: Record<string, unknown>[];
  readonly controls: CategoryControls;
  wrote: boolean;
}
function categoryRead(state: CategoryState, path: string): AtlassianWriteHttpOutcome {
  const { actor, categories, controls } = state;
  if (state.wrote && controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (path === "myself") return success({ ...actor });
  if (path === "projectCategory")
    return {
      ok: true,
      status: 200,
      body: undefined,
      items: structuredClone(categories),
    };
  const selected = /^projectCategory\/([1-9][0-9]*)$/u.exec(path)?.[1];
  const current = categories.find((item) => item.id === selected);
  if (current === undefined) return { ok: false, reason: "not-found", httpStatus: 404 };
  return success({
    ...current,
    ...(controls.nullDescription ? { description: null } : {}),
    ...(state.wrote && controls.wrongReadback ? { name: "Concurrent change" } : {}),
  });
}
function categoryCreate(state: CategoryState, body: unknown): AtlassianWriteHttpOutcome {
  const { categories, controls } = state;
  const target = targetFields(body);
  categories.push({ id: "9007199254740993", ...target });
  state.wrote = true;
  if (controls.loseAck) return { ok: false, reason: "timeout" };
  if (controls.malformedAck) return success({}, 201);
  return success(controls.ackIdOnly ? { id: "9007199254740993" } : { ...categories.at(-1) }, 201);
}
function categoryModify(
  state: CategoryState,
  path: string,
  method: string,
  body: unknown,
): AtlassianWriteHttpOutcome {
  const { categories, controls } = state;
  const selected = /^projectCategory\/([1-9][0-9]*)$/u.exec(path)?.[1];
  const current = categories.find((item) => item.id === selected);
  if (current === undefined) return { ok: false, reason: "not-found", httpStatus: 404 };
  if (method === "PUT") {
    const target = targetFields(body);
    current.name = target.name;
    current.description = target.description;
    state.wrote = true;
    return controls.loseAck ? { ok: false, reason: "timeout" } : success({ ...current });
  }
  if (method === "DELETE") {
    categories.splice(categories.indexOf(current), 1);
    state.wrote = true;
    return controls.loseAck ? { ok: false, reason: "timeout" } : success(undefined, 204);
  }
  return { ok: false, reason: "unavailable" };
}
function categoryEffect(
  state: CategoryState,
  path: string,
  method: string,
  body: unknown,
): AtlassianWriteHttpOutcome {
  return method === "POST" && path === "projectCategory"
    ? categoryCreate(state, body)
    : categoryModify(state, path, method, body);
}
export function projectCategoryFixture(): {
  readonly actor: { key: string; name: string };
  readonly categories: Record<string, unknown>[];
  readonly controls: CategoryControls;
  readonly calls: CategoryCall[];
  readonly request: JiraMutationRequest;
  readonly snapshot: () => Record<string, unknown>[];
} {
  const state: CategoryState = {
    actor: { key: "synthetic-actor", name: "synthetic-user" },
    categories: [{ ...ORIGINAL }],
    controls: {
      denyReadback: false,
      loseAck: false,
      ackIdOnly: false,
      malformedAck: false,
      wrongReadback: false,
      nullDescription: false,
    },
    wrote: false,
  };
  const { actor, categories, controls } = state;
  const calls: CategoryCall[] = [];
  const request: JiraMutationRequest = (path, method = "GET", body, expect = "json") =>
    settleSync(() => {
      calls.push({ path, method, body: structuredClone(body), expect });
      return method === "GET"
        ? categoryRead(state, path)
        : categoryEffect(state, path, method, body);
    });
  return {
    actor,
    categories,
    controls,
    calls,
    request,
    snapshot: () => structuredClone(categories),
  };
}
