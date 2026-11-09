import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  executeJiraJobObservationRead as read,
  isJiraJobObservationRead,
} from "./jira-managed-job-observations.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

interface FixturePayload {
  readonly body?: Record<string, unknown> | undefined;
  readonly items?: readonly unknown[] | undefined;
  readonly scalar?: string | number | boolean | null | undefined;
}
function response(payload: FixturePayload): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true,
    status: 200,
    body: payload.body,
    ...(payload.items === undefined ? {} : { items: payload.items }),
    ...(payload.scalar === undefined ? {} : { scalar: payload.scalar }),
  });
}

it.each([
  ["jira.reindex-status", "reindex"],
  ["jira.reindex-progress", "reindex/progress"],
] as const)(
  "observes %s without starting a task or converting progress into a percentage",
  async (name, path) => {
    const request = response({
      body: {
        currentProgress: 0,
        currentSubTask: "",
        success: false,
        type: "BACKGROUND_PREFERRED",
        startTime: "2026-11-07T00:00:00Z",
        progressUrl: "https://untrusted.invalid",
        unrelated: true,
      },
    });
    expect((await read(name, {}, request)).data).toEqual({
      outcome: "succeeded",
      taskSelection: "active-or-latest",
      currentProgress: 0,
      currentSubTask: "",
      success: false,
      type: "BACKGROUND_PREFERRED",
      startTime: "2026-11-07T00:00:00Z",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json");
  },
);

it("preserves a selected task ID as requested context because ReindexBean has no observed ID", async () => {
  const request = response({ body: { success: true } });
  const result = await read("jira.reindex-progress", { taskId: "9223372036854775807" }, request);
  expect(result.data).toEqual({
    outcome: "succeeded",
    taskSelection: "selected-task",
    selectedTaskId: "9223372036854775807",
    success: true,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "reindex/progress?taskId=9223372036854775807",
    "GET",
    undefined,
    "json",
  );
});

it("requires an observed matching ID for one reindex request", async () => {
  const request = response({ body: { id: 7, status: "PENDING", type: "DELAYED" } });
  expect((await read("jira.reindex-request", { requestId: "7" }, request)).data).toEqual({
    outcome: "succeeded",
    id: "7",
    status: "PENDING",
    type: "DELAYED",
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("reindex/request/7", "GET", undefined, "json");
});

it.each([{ status: "PENDING" }, { id: null }, { id: 8 }, { id: 9007199254740992 }])(
  "does not borrow a request ID to repair absent, conflicting or imprecise native identity: %#",
  async (body) => {
    expect(
      (await read("jira.reindex-request", { requestId: "7" }, response({ body }))).data.reason,
    ).toBe("malformed-payload");
  },
);

it("uses repeated requestId values and explicitly reports unreturned selected requests", async () => {
  const request = response({
    items: [
      { id: 9, status: "COMPLETE" },
      { id: 7, status: "ACTIVE" },
    ],
  });
  expect(
    (
      await read(
        "jira.reindex-requests",
        {
          requestIds: ["7", "8", "9"],
          maxResults: 1,
        },
        request,
      )
    ).data,
  ).toEqual({
    outcome: "succeeded",
    requestScope: "selected-requests",
    requestedRequestIds: ["7", "8", "9"],
    unreturnedRequestIds: ["8"],
    startAt: 0,
    total: 2,
    nextStartAt: 1,
    items: [{ id: "9", status: "COMPLETE" }],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "reindex/request/bulk?requestId=7&requestId=8&requestId=9",
    "GET",
    undefined,
    "json-array",
  );
});

it("does not call absent bulk results nonexistent or turn them into completed tasks", async () => {
  expect(
    (await read("jira.reindex-requests", { requestIds: ["7"] }, response({ items: [] }))).data,
  ).toEqual({
    outcome: "succeeded",
    requestScope: "selected-requests",
    requestedRequestIds: ["7"],
    unreturnedRequestIds: ["7"],
    startAt: 0,
    total: 0,
    items: [],
  });
});

it.each([
  { items: [{ id: 7 }, { id: 7 }] },
  { items: [{ id: 8 }] },
  { items: [{ status: "COMPLETE" }] },
])(
  "refuses duplicated, unrelated or missing request IDs without returning a partial prefix: %#",
  async ({ items }) => {
    expect(
      (await read("jira.reindex-requests", { requestIds: ["7"] }, response({ items }))).data.reason,
    ).toBe("malformed-payload");
  },
);
it("accepts the matching observed request ID as a positive control for identity refusals", async () => {
  expect(
    (await read("jira.reindex-requests", { requestIds: ["7"] }, response({ items: [{ id: 7 }] })))
      .data,
  ).toEqual({
    outcome: "succeeded",
    requestScope: "selected-requests",
    requestedRequestIds: ["7"],
    unreturnedRequestIds: [],
    startAt: 0,
    total: 1,
    items: [{ id: "7" }],
  });
});

it("distinguishes execution of the read from the remote upgrade's outcome", async () => {
  const request = response({
    body: {
      outcome: "FAILED",
      duration: 0,
      message: "",
      startTime: "2026-11-07T00:00:00Z",
      private: "discard",
    },
  });
  expect((await read("jira.upgrade-result", {}, request)).data).toEqual({
    outcome: "succeeded",
    upgradeState: "result",
    upgradeOutcome: "FAILED",
    duration: 0,
    message: "",
    startTime: "2026-11-07T00:00:00Z",
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("upgrade", "GET", undefined, "json");
});

it.each([
  [303, "running"],
  [404, "no-prior-result"],
] as const)(
  "uses the documented upgrade HTTP %s observation without following a location or starting work",
  async (httpStatus, upgradeState) => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "unavailable", httpStatus });
    expect((await read("jira.upgrade-result", {}, request)).data).toEqual({
      outcome: "succeeded",
      upgradeState,
    });
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("preserves a missing selected reindex task as a native not-found refusal", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "not-found", httpStatus: 404 });
  expect((await read("jira.reindex-status", { taskId: "7" }, request)).data.reason).toBe(
    "not-found",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("returns snapshot paths as observed metadata and keeps a missing timestamp unknown", async () => {
  const request = response({
    items: [
      { absolutePath: "/server/snapshots/a.tar", timestamp: 0, self: "https://untrusted.invalid" },
      { absolutePath: "/server/snapshots/b.tar" },
    ],
  });
  expect((await read("jira.index-snapshots", {}, request)).data).toEqual({
    outcome: "succeeded",
    startAt: 0,
    total: 2,
    items: [
      { absolutePath: "/server/snapshots/a.tar", timestamp: 0 },
      { absolutePath: "/server/snapshots/b.tar" },
    ],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("index-snapshot", "GET", undefined, "json-array");
});

it.each(["jira.app-monitoring", "jira.ipd-monitoring"] as const)(
  "keeps false and unavailable monitoring states distinct for %s",
  async (name) => {
    expect((await read(name, {}, response({ body: { enabled: false } }))).data).toEqual({
      outcome: "succeeded",
      enabled: false,
    });
    expect((await read(name, {}, response({ body: { enabled: null } }))).data).toEqual({
      outcome: "succeeded",
    });
    expect((await read(name, {}, response({ body: { enabled: "false" } }))).data.reason).toBe(
      "malformed-payload",
    );
  },
);

it("retains the documented native metric description without executing or reparsing it", async () => {
  const request = response({ scalar: "metric.a\nmetric.b" });
  expect((await read("jira.jmx-metrics", {}, request)).data).toEqual({
    outcome: "succeeded",
    metricsText: "metric.a\nmetric.b",
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "monitoring/jmx/getAvailableMetrics",
    "GET",
    undefined,
    "text-scalar",
  );
  expect((await read("jira.jmx-metrics", {}, response({ scalar: "" }))).data.metricsText).toBe("");
  expect((await read("jira.jmx-metrics", {}, response({ scalar: false }))).data.reason).toBe(
    "malformed-payload",
  );
});

it("refuses oversized snapshot collections without returning a deceptively complete prefix", async () => {
  const items = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
    absolutePath: `/server/${String(index)}`,
  }));
  expect((await read("jira.index-snapshots", {}, response({ items }))).data.reason).toBe(
    "bounds-exceeded",
  );
});

it.each([
  [{ currentProgress: 0.5 }, "malformed-payload"],
  [{ success: "true" }, "malformed-payload"],
  [{ currentProgress: 9007199254740992 }, "bounds-exceeded"],
] as const)("refuses malformed or imprecise native progress: %#", async (body, reason) => {
  expect((await read("jira.reindex-progress", {}, response({ body }))).data.reason).toBe(reason);
});

const INVALID: readonly [Parameters<typeof read>[0], CatalogJsonObject][] = [
  ["jira.reindex-status", { taskId: "0" }],
  ["jira.reindex-progress", { taskId: "7/progress" }],
  ["jira.reindex-request", {}],
  ["jira.reindex-request", { requestId: "9223372036854775808" }],
  ["jira.reindex-requests", { requestIds: [] }],
  ["jira.reindex-requests", { requestIds: ["7", "7"] }],
  ["jira.reindex-requests", { requestIds: [7] }],
  ["jira.reindex-requests", { requestIds: ["7"], maxResults: 101 }],
  ["jira.upgrade-result", { start: true }],
  ["jira.index-snapshots", { path: "/server/private" }],
  ["jira.jmx-metrics", { url: "https://untrusted.invalid" }],
  ["jira.app-monitoring", { enabled: true }],
];
it.each(INVALID)("refuses unsupported %s inputs before transport", async (name, args) => {
  const request = response({ body: {} });
  expect((await read(name, args, request)).data.reason).toBe("invalid-input");
  expect(request).not.toHaveBeenCalled();
});

it.each(["jira.index-snapshots", "jira.app-monitoring", "jira.upgrade-result"] as const)(
  "preserves permission refusal for %s without trying a mutation or another endpoint",
  async (name) => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await read(name, {}, request)).data.reason).toBe("permission-denied");
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("recognizes only the closed on-demand diagnostic identities", () => {
  expect(isJiraJobObservationRead("jira.reindex-requests")).toBe(true);
  expect(isJiraJobObservationRead("constructor")).toBe(false);
  expect(isJiraJobObservationRead("jira.reindex-start")).toBe(false);
});

// Only the documented unselected current/latest resource has this absence meaning.
it("labels no previous reindex task without inventing progress, completion or zero counts", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "not-found", httpStatus: 404 });
  expect(await read("jira.reindex-status", {}, request)).toEqual({
    data: { outcome: "succeeded", taskSelection: "active-or-latest", taskState: "no-prior-task" },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("reindex", "GET", undefined, "json");
});
it.each([
  { name: "jira.reindex-status", args: { taskId: "7" } },
  { name: "jira.reindex-progress", args: {} },
  { name: "jira.reindex-progress", args: { taskId: "7" } },
] as const)("does not borrow no-prior-task semantics for $name %#", async ({ name, args }) => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "not-found", httpStatus: 404 });
  const result = await read(name, args, request);
  expect(result.isError).toBe(true);
  expect(result.data).not.toHaveProperty("taskState");
  expect(request).toHaveBeenCalledTimes(1);
});
