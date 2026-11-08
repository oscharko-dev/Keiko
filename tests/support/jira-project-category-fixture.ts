import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";

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
export function projectCategoryFixture() {
  const actor = { key: "synthetic-actor", name: "synthetic-user" };
  const categories: Record<string, unknown>[] = [{ ...ORIGINAL }];
  const calls: {
    readonly path: string;
    readonly method: string;
    readonly body: unknown;
    readonly expect: string;
  }[] = [];
  const controls = {
    denyReadback: false,
    loseAck: false,
    ackIdOnly: false,
    malformedAck: false,
    wrongReadback: false,
    nullDescription: false,
  };
  let wrote = false;
  function read(path: string): AtlassianWriteHttpOutcome {
    if (wrote && controls.denyReadback)
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
      ...(wrote && controls.wrongReadback ? { name: "Concurrent change" } : {}),
    });
  }
  function create(body: unknown): AtlassianWriteHttpOutcome {
    const target = targetFields(body);
    categories.push({ id: "9007199254740993", ...target });
    wrote = true;
    if (controls.loseAck) return { ok: false, reason: "timeout" };
    if (controls.malformedAck) return success({}, 201);
    return success(controls.ackIdOnly ? { id: "9007199254740993" } : { ...categories.at(-1) }, 201);
  }
  function modify(path: string, method: string, body: unknown): AtlassianWriteHttpOutcome {
    const selected = /^projectCategory\/([1-9][0-9]*)$/u.exec(path)?.[1];
    const current = categories.find((item) => item.id === selected);
    if (current === undefined) return { ok: false, reason: "not-found", httpStatus: 404 };
    if (method === "PUT") {
      const target = targetFields(body);
      current.name = target.name;
      current.description = target.description;
      wrote = true;
      return controls.loseAck ? { ok: false, reason: "timeout" } : success({ ...current });
    }
    if (method === "DELETE") {
      categories.splice(categories.indexOf(current), 1);
      wrote = true;
      return controls.loseAck ? { ok: false, reason: "timeout" } : success(undefined, 204);
    }
    return { ok: false, reason: "unavailable" };
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect = "json") => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (method === "GET") return read(path);
    return method === "POST" && path === "projectCategory"
      ? create(body)
      : modify(path, method, body);
  };
  return {
    actor,
    categories,
    controls,
    calls,
    request,
    snapshot: () => structuredClone(categories),
  };
}
