import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCase } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { COLLECTION_SEED_STEPS } from "../testing/jira-chat-lab/api-qualification-collection-seeds.mjs";
import { vacuousReads } from "../testing/jira-chat-lab/api-qualification-evidence.mjs";
import {
  QualificationPreparationError,
  hiddenFormFields,
  runPreparationSteps,
} from "../testing/jira-chat-lab/api-qualification-operator-fixtures.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import {
  QUALIFICATION_EXTRA,
  ensureFixturePermissions,
  qualificationGrantKeys,
  verifyQualificationSeparation,
} from "../testing/jira-chat-lab/seed-permissions.mjs";

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function sessionContext() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-repair-"));
  directories.push(directory);
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const session = { ...DEFAULT_LAB_CONNECTION, directory };
  return { session, context: { actor: "admin", session } };
}

describe("complete native paging", () => {
  const rows = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: from + i }));
  function pagedFetch(total) {
    const calls = [];
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = new URL(url);
      const startAt = Number(target.searchParams.get("startAt") ?? 0);
      calls.push(startAt);
      const end = Math.min(startAt + 100, total);
      return new globalThis.Response(
        JSON.stringify({ startAt, maxResults: 100, total, values: rows(startAt, end) }),
        { status: 200 },
      );
    });
    return { calls, mock };
  }
  const entry = () =>
    readCase("jira.x-page", "/rest/api/2/x?startAt=0&maxResults=100", ["id"], {
      args: () => ({ maxResults: 100 }),
      nativeRoot: "values",
    });
  it("reads every native page and records the complete count", async () => {
    const { context } = sessionContext();
    const { calls } = pagedFetch(250);
    const result = await entry().readback(context, { items: rows(0, 100) }, {});
    expect(calls).toEqual([0, 100, 200]);
    expect(result).toMatchObject({ matched: true, nativeCount: 250, projectedCount: 100 });
  });
  it("still refuses a product page that is not the requested prefix", async () => {
    const { context } = sessionContext();
    pagedFetch(250);
    await expect(entry().readback(context, { items: rows(0, 99) }, {})).rejects.toThrow();
    await expect(entry().readback(context, { items: rows(1, 101) }, {})).rejects.toThrow();
  });
  it("fails closed when the collection exceeds the paging bound", async () => {
    const { context } = sessionContext();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new globalThis.Response(
          JSON.stringify({ startAt: 0, total: 1e9, isLast: false, values: [{ id: 1 }] }),
          { status: 200 },
        ),
    );
    await expect(entry().readback(context, { items: [] }, {})).rejects.toThrow(/paging bound/u);
  });
});

describe("vacuous evidence", () => {
  it("lists only the reads that matched an empty collection under a declaration", () => {
    const operations = [
      { identity: "GET /b", readback: { matched: true, vacuous: true } },
      { identity: "GET /a", readback: { matched: true, vacuous: true } },
      { identity: "GET /c", readback: { matched: true, nativeCount: 3 } },
      { identity: "GET /d" },
    ];
    expect(vacuousReads(operations)).toEqual(["GET /a", "GET /b"]);
  });
});

describe("preparation steps", () => {
  it("runs every independent step and skips only the dependents of a failed one", async () => {
    const saved = [];
    const ran = [];
    const step = (name, run, needs) => ({
      name,
      needs,
      run: async () => {
        ran.push(name);
        return run();
      },
    });
    const { manifest, outcomes } = await runPreparationSteps(
      [
        step("a", () => ({ a: 1 })),
        step("b", () => {
          throw new QualificationPreparationError("sprint-not-synced", 400);
        }),
        step("c", () => ({ c: 3 }), ["b"]),
        step("d", () => {
          throw new TypeError("secret detail");
        }),
        step("e", () => ({ e: 5 }), ["c"]),
        step("f", () => ({ f: 6 })),
      ],
      { start: true },
      (value) => saved.push(value),
    );
    expect(ran).toEqual(["a", "b", "d", "f"]);
    expect(manifest).toEqual({ start: true, a: 1, f: 6 });
    expect(saved).toHaveLength(2);
    expect(outcomes).toEqual([
      { step: "a", outcome: "completed" },
      { step: "b", outcome: "failed", reason: "sprint-not-synced", status: 400 },
      { step: "c", outcome: "skipped", reason: "dependency-failed", dependency: "b" },
      { step: "d", outcome: "failed", reason: "step-unexpected-error" },
      { step: "e", outcome: "skipped", reason: "dependency-failed", dependency: "c" },
      { step: "f", outcome: "completed" },
    ]);
  });
});

describe("collection seeds", () => {
  /** A scripted Jira: each collection is empty until its seeding write happens. */
  function lab() {
    const state = new Set();
    const writes = [];
    const WRITES = {
      "POST /rest/api/2/filter": "fav",
      "POST /rest/api/2/projectCategory": "cat",
      "DELETE /rest/api/2/issue/KEIKO-1/worklog/9": "del",
      "POST /rest/api/2/index-snapshot": "snap",
    };
    const reads = {
      "GET /rest/api/2/filter/favourite": ["fav", [{ id: 1 }]],
      "GET /rest/api/2/projectCategory": ["cat", [{ id: 1 }]],
      "GET /rest/api/2/worklog/deleted?since=0": ["del", { values: [{ worklogId: 1 }] }],
      "GET /rest/api/2/index-snapshot": ["snap", [{ p: 1 }]],
    };
    const rule = (method, path) => {
      const key = `${method} ${path}`;
      if (WRITES[key] !== undefined) state.add(WRITES[key]);
      if (key === "POST /rest/api/2/issue/KEIKO-1/worklog") return { id: "9" };
      const read = reads[key];
      if (read === undefined) return undefined;
      const empty = Array.isArray(read[1]) ? [] : { values: [] };
      return state.has(read[0]) ? read[1] : empty;
    };
    return {
      writes,
      io: {
        sleep: async () => undefined,
        request: async (method, path) => {
          if (method !== "GET") writes.push(`${method} ${path}`);
          const value = rule(method, path);
          const status = { DELETE: 204, POST: 201 }[method] ?? 200;
          return { status, value };
        },
      },
    };
  }
  const fixture = { issueKeys: ["KEIKO-1"], issueTypeId: "10002" };
  const step = (name) => COLLECTION_SEED_STEPS.find(([key]) => key === name)[1];
  it("seeds an empty collection once and leaves a populated one alone", async () => {
    const { io, writes } = lab();
    await step("seed-favourite-filter")(io, fixture);
    await step("seed-favourite-filter")(io, fixture);
    expect(writes).toEqual(["POST /rest/api/2/filter"]);
  });
  it("creates and then natively deletes a worklog so Jira lists a deleted one", async () => {
    const { io, writes } = lab();
    expect(await step("seed-deleted-worklog")(io, fixture)).toEqual({ seedDeletedWorklog: true });
    expect(writes).toEqual([
      "POST /rest/api/2/issue/KEIKO-1/worklog",
      "DELETE /rest/api/2/issue/KEIKO-1/worklog/9",
    ]);
  });
  it("waits for a snapshot to appear and fails closed when it never does", async () => {
    const { io } = lab();
    expect(await step("seed-index-snapshot")(io, fixture)).toEqual({ seedIndexSnapshot: true });
    const never = {
      sleep: async () => undefined,
      request: async (method) => ({ status: method === "GET" ? 200 : 202, value: [] }),
    };
    await expect(step("seed-index-snapshot")(never, fixture)).rejects.toMatchObject({
      reason: "collection-seed-not-observed",
    });
  });
  it("fails closed when a write is accepted but the record stays invisible", async () => {
    const blind = {
      sleep: async () => undefined,
      request: async (method) => ({ status: method === "GET" ? 200 : 201, value: [] }),
    };
    await expect(step("seed-project-category")(blind, fixture)).rejects.toMatchObject({
      reason: "collection-seed-not-observed",
    });
  });
  it("refuses a fixture manifest without its first issue key", async () => {
    await expect(step("seed-remote-link")(lab().io, {})).rejects.toMatchObject({
      reason: "fixture-manifest-invalid",
    });
  });
});

describe("form fields", () => {
  it("collects only hidden inputs and decodes their entities", () => {
    const html =
      '<input type="hidden" name="atl_token" value="a&amp;b|c"><input type="text" name="x" value="1">' +
      '<INPUT TYPE="HIDDEN" NAME="inline" VALUE="true"><input type="hidden" value="orphan">';
    expect(hiddenFormFields(html)).toEqual({ atl_token: "a&b|c", inline: "true" });
  });
});

describe("qualification permissions", () => {
  const inventory = (omit = []) => ({
    permissions: Object.fromEntries(
      [
        ...QUALIFICATION_EXTRA.filter((key) => !omit.includes(key)),
        "MANAGE_SPRINTS_PERMISSION",
      ].map((key) => [
        key,
        {
          key,
          name: key === "MANAGE_SPRINTS_PERMISSION" ? "Manage Sprints" : key,
          type: "PROJECT",
        },
      ]),
    ),
  });
  it("adds worklog, comment deletion, sprint and voter grants with Jira's own sprint key", () => {
    const keys = qualificationGrantKeys(inventory());
    for (const key of ["WORK_ISSUES", "DELETE_OWN_COMMENTS", "SCHEDULE_ISSUES"])
      expect(keys).toContain(key);
    expect(keys).toContain("VIEW_VOTERS_AND_WATCHERS");
    expect(keys).toContain("MANAGE_SPRINTS_PERMISSION");
    expect(keys).toContain("BROWSE_PROJECTS");
  });
  it("names the grant Jira does not offer, and refuses an ambiguous sprint permission", () => {
    expect(() => qualificationGrantKeys(inventory(["WORK_ISSUES"]))).toThrow(/WORK_ISSUES/u);
    const twice = inventory();
    twice.permissions.OTHER = { key: "OTHER", name: "manage sprints", type: "PROJECT" };
    expect(() => qualificationGrantKeys(twice)).toThrow(/ambiguous/u);
    expect(() => qualificationGrantKeys({})).toThrow(/unavailable/u);
  });
  it("grants the extras to admin and api only, never to the narrow actors", async () => {
    const { session } = sessionContext();
    const created = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = new URL(url);
      const path = target.pathname;
      const respond = (value, status = 200) =>
        new globalThis.Response(JSON.stringify(value), { status });
      if (path === "/rest/api/2/permissions") return respond(inventory());
      if (path === "/rest/api/2/permissionscheme" && init.method === "GET")
        return respond({ permissionSchemes: [] });
      if (path === "/rest/api/2/permissionscheme" && init.method === "POST") {
        created.push(JSON.parse(init.body));
        return respond({ id: created.length });
      }
      if (path.startsWith("/rest/api/2/permissionscheme/"))
        return respond({ permissions: created[Number(path.split("/")[5]) - 1].permissions });
      return respond({ id: 1 });
    });
    // The scripted lab answers every native permission probe with "no", so the original
    // separation guard stops the run right after the schemes were written.
    await expect(ensureFixturePermissions(session, {})).rejects.toThrow();
    const keiko = created.find((scheme) => scheme.name.includes("KEIKO"));
    const holders = (permission) =>
      keiko.permissions
        .filter((grant) => grant.permission === permission)
        .map((grant) => grant.holder.parameter)
        .sort();
    for (const permission of QUALIFICATION_EXTRA)
      expect(holders(permission)).toEqual(["keiko-admin", "keiko-api"]);
    expect(holders("MANAGE_SPRINTS_PERMISSION")).toEqual(["keiko-admin", "keiko-api"]);
    expect(holders("BROWSE_PROJECTS")).toContain("keiko-editor");
    const isolated = created.find((scheme) => scheme.name.includes("ISOLATED"));
    expect(isolated.permissions.map((grant) => grant.permission)).not.toContain("WORK_ISSUES");
  });
  it("proves every narrow actor holds none of the extras and the api actor all of them", async () => {
    const { session } = sessionContext();
    const keys = qualificationGrantKeys(inventory());
    const answer = (holds) => (permissions) =>
      Object.fromEntries(permissions.map((key) => [key, { havePermission: holds }]));
    const run = async (apiHolds, editorHolds) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const names = new URL(_url).searchParams.get("permissions").split(",");
        const holds = init.headers.Authorization === "Bearer api" ? apiHolds : editorHolds;
        return new globalThis.Response(JSON.stringify({ permissions: answer(holds)(names) }), {
          status: 200,
        });
      });
      await verifyQualificationSeparation(
        session,
        {
          api: "Bearer api",
          editor: "Bearer e",
          assignee: "Bearer e",
          restricted: "Bearer e",
        },
        keys,
      );
    };
    await expect(run(true, false)).resolves.toBeUndefined();
    await expect(run(false, false)).rejects.toThrow(/separate/u);
    await expect(run(true, true)).rejects.toThrow(/separate/u);
  });
});
