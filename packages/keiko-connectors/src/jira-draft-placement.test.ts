import { describe, expect, it } from "vitest";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { resolveJiraDraftPlacementWith } from "./jira-draft-placement.js";

const TYPES = [
  { id: "10005", name: "Epic", subtask: false },
  { id: "10004", name: "Sub-task", subtask: true },
  { id: "10003", name: "Bug", subtask: false },
  { id: "10002", name: "task", subtask: false },
  { id: "10001", name: "Story", subtask: false },
];

function project(body: Record<string, unknown> | undefined, status = 200): JiraMutationRequest {
  return (path) => {
    expect(path).toMatch(/^project\//u);
    return Promise.resolve(
      status === 200
        ? { ok: true, status, body }
        : { ok: false, reason: status === 404 ? "not-found" : "unavailable", httpStatus: status },
    );
  };
}
const OK_BODY = { id: "10000", key: "KER", issueTypes: TYPES };

describe("resolveJiraDraftPlacementWith (#4173)", () => {
  it("resolves a project key and an issue type id from one read", async () => {
    let reads = 0;
    const request: JiraMutationRequest = (path, ...rest) => {
      reads += 1;
      return project(OK_BODY)(path, ...rest);
    };
    expect(await resolveJiraDraftPlacementWith(request, "KER", "10003")).toEqual({
      ok: true,
      projectId: "10000",
      projectKey: "KER",
      issueTypeId: "10003",
      issueTypeName: "Bug",
    });
    expect(reads).toBe(1);
  });

  it("matches an issue type name without regard to case", async () => {
    expect(await resolveJiraDraftPlacementWith(project(OK_BODY), "10000", " bUG ")).toMatchObject({
      ok: true,
      issueTypeId: "10003",
    });
  });

  it("prefers Story, then Task, then the first type that is not an Epic or subtask", async () => {
    const story = await resolveJiraDraftPlacementWith(project(OK_BODY), "KER", undefined);
    expect(story).toMatchObject({ ok: true, issueTypeName: "Story" });
    const withoutStory = { ...OK_BODY, issueTypes: TYPES.filter((t) => t.name !== "Story") };
    expect(
      await resolveJiraDraftPlacementWith(project(withoutStory), "KER", undefined),
    ).toMatchObject({ ok: true, issueTypeName: "task" });
    const onlyOthers = { ...OK_BODY, issueTypes: [TYPES[0], TYPES[1], TYPES[2]] };
    expect(
      await resolveJiraDraftPlacementWith(project(onlyOthers), "KER", undefined),
    ).toMatchObject({ ok: true, issueTypeName: "Bug" });
  });

  it("never chooses a subtask type, even when named", async () => {
    const result = await resolveJiraDraftPlacementWith(project(OK_BODY), "KER", "Sub-task");
    expect(result).toEqual({
      ok: false,
      reason: "issue-type-not-found",
      issueTypeNames: ["Epic", "Bug", "task", "Story"],
    });
  });

  it("bounds the names it offers", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: String(i + 1),
      name: `T${String(i)}`,
    }));
    const result = await resolveJiraDraftPlacementWith(
      project({ ...OK_BODY, issueTypes: many }),
      "KER",
      "nope",
    );
    expect(!result.ok && result.issueTypeNames).toHaveLength(20);
  });

  it("upper-cases a project key for the read and leaves a numeric id alone", async () => {
    const paths: string[] = [];
    const request: JiraMutationRequest = (path, ...rest) => {
      paths.push(path);
      return project(OK_BODY)(path, ...rest);
    };
    await resolveJiraDraftPlacementWith(request, "ker", undefined);
    await resolveJiraDraftPlacementWith(request, "10000", undefined);
    expect(paths).toEqual(["project/KER", "project/10000"]);
  });

  it("names a project with only subtask types as having no usable issue type", async () => {
    const onlySubtasks = { ...OK_BODY, issueTypes: [TYPES[1]] };
    for (const type of [undefined, "Story"])
      expect(await resolveJiraDraftPlacementWith(project(onlySubtasks), "KER", type)).toEqual({
        ok: false,
        reason: "no-usable-issue-type",
      });
  });

  it("refuses an unknown project, an unreadable one and a malformed body", async () => {
    expect(await resolveJiraDraftPlacementWith(project(undefined, 404), "ZZZ", undefined)).toEqual({
      ok: false,
      reason: "project-not-found",
    });
    expect(await resolveJiraDraftPlacementWith(project(undefined, 503), "ZZZ", undefined)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    for (const body of [{}, { id: "1", key: "K" }, { id: "x", key: "K", issueTypes: [] }]) {
      expect(await resolveJiraDraftPlacementWith(project(body), "K", undefined)).toEqual({
        ok: false,
        reason: "malformed-payload",
      });
    }
  });
});
