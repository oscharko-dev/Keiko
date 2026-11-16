import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  JIRA_CORE_METADATA_READS,
  executeJiraCoreMetadataRead,
  isJiraCoreMetadataRead,
} from "./jira-managed-core-metadata.js";

type Read = (typeof JIRA_CORE_METADATA_READS)[number];
const ISSUE_TYPE = {
  id: "1",
  name: "Bug",
  description: "Problem",
  subtask: false,
  avatarId: 10002,
};
const PRIORITY = { id: "2", name: "High", description: "Urgent", statusColor: "red" };
const RESOLUTION = { id: "3", name: "Fixed", description: "Completed" };
const CATEGORY = { id: 4, key: "indeterminate", name: "In Progress", colorName: "yellow" };
const STATUS = { id: "5", name: "In Progress", statusCategory: CATEGORY };
const PROJECT_CATEGORY = { id: "6", name: "Engineering", description: "Delivery" };
const PROJECT_TYPE = {
  key: "software",
  formattedKey: "Software",
  descriptionI18nKey: "project.type.software",
  color: "#ffffff",
};
const PROJECT_STATUS = { id: "1", name: "Bug", subtask: false, statuses: [STATUS] };
const PROJECT = { id: "10001", key: "SYN", name: "Synthetic" };
function single(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function list(items: readonly unknown[]): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: undefined, items };
}
function page(value: Record<string, unknown>, total: number | null = 1): AtlassianWriteHttpOutcome {
  return single({
    values: [value],
    startAt: 0,
    maxResults: 25,
    isLast: true,
    ...(total === null ? {} : { total }),
  });
}
interface Scenario {
  readonly args: CatalogJsonObject;
  readonly path: string;
  readonly response: AtlassianWriteHttpOutcome;
  readonly expect: "json" | "json-array";
}
const SCENARIOS: Readonly<Record<Read, Scenario>> = {
  "jira.global-issue-types": {
    args: {},
    path: "issuetype",
    response: list([ISSUE_TYPE]),
    expect: "json-array",
  },
  "jira.issue-type": {
    args: { issueTypeId: "1" },
    path: "issuetype/1",
    response: single(ISSUE_TYPE),
    expect: "json",
  },
  "jira.issue-type-page": {
    args: {},
    path: "issuetype/page?startAt=0&maxResults=25",
    response: page(ISSUE_TYPE),
    expect: "json",
  },
  "jira.issue-type-alternatives": {
    args: { issueTypeId: "9" },
    path: "issuetype/9/alternatives",
    response: list([ISSUE_TYPE]),
    expect: "json-array",
  },
  "jira.priorities": {
    args: {},
    path: "priority",
    response: list([PRIORITY]),
    expect: "json-array",
  },
  "jira.priority": {
    args: { priorityId: "2" },
    path: "priority/2",
    response: single(PRIORITY),
    expect: "json",
  },
  "jira.priority-page": {
    args: {},
    path: "priority/page?startAt=0&maxResults=25",
    response: page(PRIORITY),
    expect: "json",
  },
  "jira.resolutions": {
    args: {},
    path: "resolution",
    response: list([RESOLUTION]),
    expect: "json-array",
  },
  "jira.resolution": {
    args: { resolutionId: "3" },
    path: "resolution/3",
    response: single(RESOLUTION),
    expect: "json",
  },
  "jira.resolution-page": {
    args: {},
    path: "resolution/page?startAt=0&maxResults=25",
    response: page(RESOLUTION),
    expect: "json",
  },
  "jira.statuses": { args: {}, path: "status", response: list([STATUS]), expect: "json-array" },
  "jira.status": {
    args: { statusIdOrName: "5" },
    path: "status/5",
    response: single(STATUS),
    expect: "json",
  },
  "jira.status-page": {
    args: {},
    path: "status/page?startAt=0&maxResults=25",
    response: page(STATUS),
    expect: "json",
  },
  "jira.status-categories": {
    args: {},
    path: "statuscategory",
    response: list([CATEGORY]),
    expect: "json-array",
  },
  "jira.status-category": {
    args: { statusCategoryIdOrKey: "4" },
    path: "statuscategory/4",
    response: single(CATEGORY),
    expect: "json",
  },
  "jira.project-categories": {
    args: {},
    path: "projectCategory",
    response: list([PROJECT_CATEGORY]),
    expect: "json-array",
  },
  "jira.project-category": {
    args: { projectCategoryId: "6" },
    path: "projectCategory/6",
    response: single(PROJECT_CATEGORY),
    expect: "json",
  },
  "jira.project-statuses": {
    args: { projectIdOrKey: "syn" },
    path: "project/10001/statuses",
    response: list([PROJECT_STATUS]),
    expect: "json-array",
  },
  "jira.project-types": {
    args: {},
    path: "project/type",
    response: list([PROJECT_TYPE]),
    expect: "json-array",
  },
  "jira.project-type-definition": {
    args: { projectTypeKey: "software" },
    path: "project/type/software",
    response: single(PROJECT_TYPE),
    expect: "json",
  },
};
function requestFor(
  response: AtlassianWriteHttpOutcome,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue(response);
}
describe("closed native issue and project metadata reads", () => {
  it.each(JIRA_CORE_METADATA_READS)("uses the exact typed native route for %s", async (name) => {
    const scenario = SCENARIOS[name];
    const request = requestFor(scenario.response);
    if (name === "jira.project-statuses") request.mockResolvedValueOnce(single(PROJECT));
    expect((await executeJiraCoreMetadataRead(name, scenario.args, request)).data.outcome).toBe(
      "succeeded",
    );
    expect(request.mock.calls.at(-1)).toEqual([scenario.path, "GET", undefined, scenario.expect]);
    expect(request).toHaveBeenCalledTimes(name === "jira.project-statuses" ? 2 : 1);
  });
  it("retains unknown classification rather than inventing subtask=false", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.issue-type",
      { issueTypeId: "1" },
      requestFor(single({ id: "1", name: "Bug", subtask: null, avatarId: null })),
    );
    expect(result.data).toEqual({ outcome: "succeeded", id: "1", name: "Bug" });
  });
  it.each([null, ""])(
    "exposes the exact shared review snapshot for observed description %j",
    async (description) => {
      const native = {
        id: "1",
        name: "Bug",
        subtask: false,
        description,
        avatarId: "9223372036854775807",
      };
      const result = await executeJiraCoreMetadataRead(
        "jira.issue-type",
        { issueTypeId: "1" },
        requestFor(single(native)),
      );
      expect(result.data.reviewSnapshot).toEqual(native);
      expect(Object.hasOwn(result.data, "description")).toBe(description !== null);
    },
  );
  it("keeps ordinary metadata readable while an incomplete review snapshot stays unavailable", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.issue-type",
      { issueTypeId: "1" },
      requestFor(single({ id: "1", name: "Bug", subtask: false })),
    );
    expect(result.data).toEqual({ outcome: "succeeded", id: "1", name: "Bug", subtask: false });
    expect(Object.hasOwn(result.data, "reviewSnapshot")).toBe(false);
  });
  it("projects exact avatar identity and strips icon URLs/expansions", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.issue-type",
      { issueTypeId: "1" },
      requestFor(
        single({
          ...ISSUE_TYPE,
          avatarId: "9223372036854775807",
          self: "https://untrusted.invalid/type",
          iconUrl: "https://untrusted.invalid/icon",
          fields: { secret: "unprojected" },
        }),
      ),
    );
    const observed = { ...ISSUE_TYPE, avatarId: "9223372036854775807" };
    expect(result.data).toEqual({ outcome: "succeeded", ...observed, reviewSnapshot: observed });
  });
  it("returns only the observed bound resolution identity", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.resolution",
      { resolutionId: "3" },
      requestFor(
        single({
          id: "3",
          name: "Fixed",
          description: "",
          self: "https://untrusted.invalid/resolution/999",
        }),
      ),
    );
    expect(result.data).toEqual({ outcome: "succeeded", id: "3", name: "Fixed", description: "" });
  });
  it("retains bound resolution IDs when the native page omits its total", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.resolution-page",
      {},
      requestFor(page({ id: "3", name: "Fixed" }, null)),
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [{ id: "3", name: "Fixed" }],
      startAt: 0,
    });
  });
  it.each([
    [
      "jira.resolution",
      { resolutionId: "3" },
      single({ name: "Fixed", self: "https://untrusted.invalid/resolution/3" }),
    ],
    ["jira.resolution", { resolutionId: "3" }, single({ id: null, name: "Fixed" })],
    ["jira.resolutions", {}, list([{ name: "Fixed" }])],
    ["jira.resolution-page", {}, page({ name: "Fixed" })],
  ] as const)(
    "refuses missing observed identity for %s without synthesizing it from input or a URL",
    async (name, args, response) => {
      const request = requestFor(response);
      expect((await executeJiraCoreMetadataRead(name, args, request)).data).toEqual({
        outcome: "failed",
        reason: "malformed-payload",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("binds a literal status name while encoding the one selected path segment", async () => {
    const request = requestFor(single(STATUS));
    expect(
      (await executeJiraCoreMetadataRead("jira.status", { statusIdOrName: STATUS.name }, request))
        .data.id,
    ).toBe("5");
    expect(request.mock.calls[0]?.[0]).toBe("status/In%20Progress");
  });
  it("selects a category by its exact native key and preserves a missing display name", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.status-category",
      { statusCategoryIdOrKey: "indeterminate" },
      requestFor(single({ id: 4, key: "indeterminate", name: null })),
    );
    expect(result.data).toEqual({ outcome: "succeeded", id: "4", key: "indeterminate" });
  });
  it("returns a project type's native facts without decoding the embedded SVG", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.project-type-definition",
      { projectTypeKey: "software" },
      requestFor(single({ ...PROJECT_TYPE, icon: "PHN2Zz5hcmJpdHJhcnk8L3N2Zz4=" })),
    );
    expect(result.data).toEqual({ outcome: "succeeded", ...PROJECT_TYPE });
  });
  it("pages complete local collections without sending unpublished pagination", async () => {
    const request = requestFor(list([PRIORITY, { ...PRIORITY, id: "7", name: "Low" }]));
    const result = await executeJiraCoreMetadataRead(
      "jira.priorities",
      { startAt: 1, maxResults: 1 },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [{ ...PRIORITY, id: "7", name: "Low" }],
      startAt: 1,
      total: 2,
    });
    expect(request.mock.calls[0]?.[0]).toBe("priority");
  });
  it("retains the selected source type when reading compatible alternatives", async () => {
    const result = await executeJiraCoreMetadataRead(
      "jira.issue-type-alternatives",
      { issueTypeId: "9" },
      requestFor(list([])),
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      issueTypeId: "9",
      items: [],
      startAt: 0,
      total: 0,
    });
  });
  it("sends typed native filters as repeated query values without rounding IDs", async () => {
    const request = requestFor(page(STATUS));
    await executeJiraCoreMetadataRead(
      "jira.status-page",
      {
        query: "In Progress",
        projectIds: ["9223372036854775807", "10001"],
        issueTypeIds: ["1", "2"],
      },
      request,
    );
    expect(request.mock.calls[0]?.[0]).toBe(
      "status/page?startAt=0&maxResults=25&query=In+Progress&projectIds=9223372036854775807&projectIds=10001&issueTypeIds=1&issueTypeIds=2",
    );
  });
  it("retains a native continuation while keeping a missing total unknown", async () => {
    const request = requestFor(
      single({
        values: [PRIORITY],
        startAt: 5,
        maxResults: 1,
        isLast: false,
        total: null,
        nextPage: "https://untrusted.invalid/next",
      }),
    );
    const result = await executeJiraCoreMetadataRead(
      "jira.priority-page",
      { startAt: 5, maxResults: 1 },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [PRIORITY],
      startAt: 5,
      nextStartAt: 6,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("distinguishes omitted project-status collections from explicitly empty collections", async () => {
    const request = requestFor(
      list([
        { id: "1", name: "Bug" },
        { id: "2", name: "Task", statuses: [] },
      ]),
    ).mockResolvedValueOnce(single(PROJECT));
    const result = await executeJiraCoreMetadataRead(
      "jira.project-statuses",
      { projectIdOrKey: "syn" },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      projectId: "10001",
      projectKey: "SYN",
      items: [
        { id: "1", name: "Bug" },
        { id: "2", name: "Task", statuses: [] },
      ],
      startAt: 0,
      total: 2,
    });
    expect(request.mock.calls[0]).toEqual(["project/syn"]);
  });
  it("refuses a mismatched project before requesting associated statuses", async () => {
    const request = requestFor(single({ ...PROJECT, key: "OTHER", id: "10002" }));
    expect(
      (
        await executeJiraCoreMetadataRead(
          "jira.project-statuses",
          { projectIdOrKey: "SYN" },
          request,
        )
      ).data.reason,
    ).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["jira.issue-type", { issueTypeId: "1" }, { ...ISSUE_TYPE, id: "2" }],
    ["jira.resolution", { resolutionId: "3" }, { ...RESOLUTION, id: "4" }],
    ["jira.status", { statusIdOrName: "Open" }, STATUS],
    ["jira.status-category", { statusCategoryIdOrKey: "new" }, CATEGORY],
    ["jira.project-type-definition", { projectTypeKey: "business" }, PROJECT_TYPE],
  ] as const)("refuses mismatched native identity for %s", async (name, args, body) => {
    expect(
      (await executeJiraCoreMetadataRead(name, args, requestFor(single(body)))).data.reason,
    ).toBe("malformed-payload");
  });
  it.each([
    ["jira.issue-type", { issueTypeId: "01" }],
    ["jira.status", { statusIdOrName: ".." }],
    ["jira.status", { statusIdOrName: "other/status" }],
    ["jira.status", { statusIdOrName: "other\\status" }],
    ["jira.status", { statusIdOrName: " In Progress" }],
    ["jira.status-category", { statusCategoryIdOrKey: ".." }],
    ["jira.project-types", { request: "untrusted" }],
    ["jira.status-categories", { uriInfo: "untrusted" }],
    ["jira.priorities", { query: "unpublished" }],
    ["jira.priority-page", { projectIds: ["1", "1"] }],
    ["jira.priority-page", { projectIds: [9007199254740992] }],
    ["jira.resolution-page", { projectIds: ["1"] }],
    ["jira.issue-type-page", { issueTypeIds: ["1"] }],
    ["jira.status-page", { maxResults: 101 }],
    ["jira.status-page", { startAt: null }],
    ["jira.status-page", { query: null }],
    ["jira.status-page", { path: "myself" }],
  ] as const)(
    "refuses undeclared or invalid selectors before transport for %s",
    async (name, args) => {
      const request = requestFor(list([]));
      expect((await executeJiraCoreMetadataRead(name, args, request)).data.reason).toBe(
        "invalid-input",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    list([PRIORITY, PRIORITY]),
    list([{ ...PRIORITY, id: 2 }]),
    list([{ ...PRIORITY, name: null }]),
    list([{ ...PRIORITY, description: false }]),
  ])("refuses malformed native collections", async (response) => {
    expect(
      (await executeJiraCoreMetadataRead("jira.priorities", {}, requestFor(response))).data.reason,
    ).toBe("malformed-payload");
  });
  it("uses the existing keyed collection owner to reject duplicate project types", async () => {
    expect(
      (
        await executeJiraCoreMetadataRead(
          "jira.project-types",
          {},
          requestFor(list([PROJECT_TYPE, PROJECT_TYPE])),
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("refuses duplicate observed resolution IDs even when display names differ", async () => {
    expect(
      (
        await executeJiraCoreMetadataRead(
          "jira.resolutions",
          {},
          requestFor(list([RESOLUTION, { ...RESOLUTION, name: "Other" }])),
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("classifies oversized collections as a bound refusal", async () => {
    const values = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
      ...PRIORITY,
      id: String(index + 1),
    }));
    expect(
      (await executeJiraCoreMetadataRead("jira.priorities", {}, requestFor(list(values)))).data
        .reason,
    ).toBe("bounds-exceeded");
  });
  it("classifies excessive projected description bytes separately from malformed data", async () => {
    expect(
      (
        await executeJiraCoreMetadataRead(
          "jira.priority",
          { priorityId: "2" },
          requestFor(single({ ...PRIORITY, description: "界".repeat(30000) })),
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it("applies the same collection bound to nested project statuses", async () => {
    const request = requestFor(
      list([
        {
          ...PROJECT_STATUS,
          statuses: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
            ...STATUS,
            id: String(index + 1),
          })),
        },
      ]),
    ).mockResolvedValueOnce(single(PROJECT));
    expect(
      (
        await executeJiraCoreMetadataRead(
          "jira.project-statuses",
          { projectIdOrKey: "SYN" },
          request,
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it.each([
    { values: [PRIORITY], startAt: 1, maxResults: 25, isLast: true },
    { values: [], startAt: 0, maxResults: 25, isLast: false },
    { values: [PRIORITY], startAt: 0, maxResults: 25, isLast: false, total: 1 },
  ])("refuses contradictory page metadata rather than claiming completeness", async (body) => {
    expect(
      (await executeJiraCoreMetadataRead("jira.priority-page", {}, requestFor(single(body)))).data
        .reason,
    ).toBe("malformed-payload");
  });
  it("preserves permission refusal without an alternate endpoint", async () => {
    const request = requestFor({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect(
      (await executeJiraCoreMetadataRead("jira.global-issue-types", {}, request)).data,
    ).toEqual({ outcome: "failed", reason: "permission-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("recognizes exactly this closed operation family", () => {
    for (const name of JIRA_CORE_METADATA_READS) expect(isJiraCoreMetadataRead(name)).toBe(true);
    expect(isJiraCoreMetadataRead("jira.project-type")).toBe(false);
    expect(isJiraCoreMetadataRead("jira.issue-types")).toBe(false);
    expect(isJiraCoreMetadataRead("GET /rest/api/2/status")).toBe(false);
  });
});
