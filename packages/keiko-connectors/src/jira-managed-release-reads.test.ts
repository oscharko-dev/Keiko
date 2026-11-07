import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraReleaseRead as read,
  isJiraReleaseRead,
} from "./jira-managed-release-reads.js";
import { executeJiraVersionRead } from "./jira-managed-versions.js";

const PROJECT = { id: "10000", key: "SYN", name: "Synthetic" };
const VERSION = { id: "42", name: "Release", projectId: 10000, released: false, archived: false, releaseDate: "2026-11-07" };
function response(body: Record<string, unknown>): Awaited<ReturnType<JiraMutationRequest>> {
  return { ok: true, status: 200, body };
}
function request(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue(response(body));
}
const COUNTS = [
  ["jira.component-related-issue-counts", { componentId: "42" }, "component/42/relatedIssueCounts", "component/42", "issueCount"],
  ["jira.version-related-issue-counts", { versionId: "42" }, "version/42/relatedIssueCounts", "version/42", "issuesFixedCount"],
  ["jira.version-unresolved-issue-count", { versionId: "42" }, "version/42/unresolvedIssueCount", "version/42", "issuesUnresolvedCount"],
] as const;

it.each(COUNTS)("retains a native zero and exact fixed target for %s", async (name, args, path, resource, metric) => {
  const port = request({ self: `http://proxy.invalid/context/rest/api/2/${resource}`, [metric]: 0 });
  expect((await read(name, args, port)).data).toEqual({
    outcome: "succeeded", ...args, countScope: "jira-response", [metric]: 0,
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json");
});
it.each(COUNTS)("keeps missing metrics unknown for %s", async (name, args) => {
  const result = await read(name, args, request({}));
  expect(result.data).toEqual({ outcome: "succeeded", ...args, countScope: "jira-response" });
});
it.each(COUNTS)("refuses a contradictory supplied identity for %s without following it", async (name, args) => {
  const port = request({ self: "https://remote.invalid/rest/api/2/version/999", issueCount: 7 });
  expect((await read(name, args, port)).data.reason).toBe("conflict");
  expect(port).toHaveBeenCalledTimes(1);
});
it.each(COUNTS)("refuses negative and rounded count data for %s", async (name, args, _path, _resource, metric) => {
  expect((await read(name, args, request({ [metric]: -1 }))).data.reason).toBe("malformed-payload");
  expect((await read(name, args, request({ [metric]: Number.MAX_SAFE_INTEGER + 1 }))).data.reason).toBe("bounds-exceeded");
});
it("preserves all three version count dimensions and bounded custom-field usage independently", async () => {
  const body = {
    issuesAffectedCount: 11, issuesFixedCount: 8, issueCountWithCustomFieldsShowingVersion: 4,
    customFieldNames: [
      { customFieldId: 10001, fieldName: "Delivery", issueCountWithVersionInCustomField: 0, self: "https://untrusted.invalid/field" },
      { customFieldId: "9223372036854775807", fieldName: "Audit" },
    ],
  };
  const result = await read("jira.version-related-issue-counts", { versionId: "42" }, request(body));
  expect(result.data).toEqual({
    outcome: "succeeded", versionId: "42", countScope: "jira-response",
    issuesAffectedCount: 11, issuesFixedCount: 8, issueCountWithCustomFieldsShowingVersion: 4,
    customFieldNames: [
      { customFieldId: "10001", fieldName: "Delivery", issueCountWithVersionInCustomField: 0 },
      { customFieldId: "9223372036854775807", fieldName: "Audit" },
    ],
  });
});
it("distinguishes an observed empty custom-field usage list from an absent one", async () => {
  const result = await read("jira.version-related-issue-counts", { versionId: "42" }, request({ customFieldNames: [] }));
  expect(result.data).toEqual({ outcome: "succeeded", versionId: "42", countScope: "jira-response", customFieldNames: [] });
});
it.each([
  { customFieldNames: {} },
  { customFieldNames: [{ customFieldId: 2, fieldName: "Field" }, { customFieldId: 2, fieldName: "Duplicate" }] },
  { customFieldNames: [{ customFieldId: 2, fieldName: "Field", issueCountWithVersionInCustomField: "0" }] },
])("refuses malformed custom-field usage: %j", async (body) => {
  expect((await read("jira.version-related-issue-counts", { versionId: "42" }, request(body))).data.reason).toBe("malformed-payload");
});
it("refuses over-budget custom-field usage without returning a prefix", async () => {
  const customFieldNames = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
    customFieldId: index + 1, fieldName: `Field ${index}`,
  }));
  expect((await read("jira.version-related-issue-counts", { versionId: "42" }, request({ customFieldNames }))).data.reason).toBe("bounds-exceeded");
});
function page(startAt: number, total: number | null, values: readonly unknown[]): Record<string, unknown> {
  return { startAt, maxResults: 1, total, isLast: total === null || startAt + values.length >= total, values };
}
it("reads two native version pages through the canonical project and preserves native continuation", async () => {
  const port = vi.fn<JiraMutationRequest>()
    .mockResolvedValueOnce(response(PROJECT))
    .mockResolvedValueOnce(response({ ...page(0, 2, [VERSION]), nextPage: "https://untrusted.invalid/next" }))
    .mockResolvedValueOnce(response(PROJECT))
    .mockResolvedValueOnce(response(page(1, 2, [{ ...VERSION, id: "43" }])));
  const first = await read("jira.project-version-page", { projectIdOrKey: "syn", maxResults: 1, orderBy: "+name" }, port);
  const second = await read("jira.project-version-page", { projectIdOrKey: "SYN", startAt: 1, maxResults: 1 }, port);
  expect(first.data).toMatchObject({ outcome: "succeeded", projectId: "10000", projectKey: "SYN", startAt: 0, total: 2, nextStartAt: 1, items: [{ versionId: "42", projectId: "10000" }] });
  expect(second.data).toMatchObject({ startAt: 1, total: 2, items: [{ versionId: "43" }] });
  expect(second.data).not.toHaveProperty("nextStartAt");
  expect(port.mock.calls.map(([path]) => path)).toEqual([
    "project/syn", "project/10000/version?startAt=0&maxResults=1&orderBy=%2Bname",
    "project/SYN", "project/10000/version?startAt=1&maxResults=1",
  ]);
});
it("does not invent an absent per-item projectId or page total", async () => {
  const port = vi.fn<JiraMutationRequest>()
    .mockResolvedValueOnce(response(PROJECT))
    .mockResolvedValueOnce(response(page(0, null, [{ id: "42", name: "Release", description: null, released: false }])));
  expect((await read("jira.project-version-page", { projectIdOrKey: "SYN", maxResults: 1 }, port)).data).toEqual({
    outcome: "succeeded", projectId: "10000", projectKey: "SYN", startAt: 0,
    items: [{ versionId: "42", name: "Release", released: false }],
  });
});
it("keeps the existing single-version project's numeric identity requirement", async () => {
  expect((await executeJiraVersionRead("jira.version", { versionId: "42" }, request({ ...VERSION, projectId: "10000" }))).data.reason).toBe("malformed-payload");
  expect((await executeJiraVersionRead("jira.version", { versionId: "42" }, request(VERSION))).data).toMatchObject({ projectId: "10000", versionId: "42" });
});
it.each([
  { values: [{ ...VERSION, projectId: 999 }] },
  { values: [{ ...VERSION, projectId: Number.MAX_SAFE_INTEGER + 1 }] },
  { values: [VERSION, VERSION] },
])("refuses unbound, inexact or oversized version pages: %#", async ({ values }) => {
  const port = vi.fn<JiraMutationRequest>().mockResolvedValueOnce(response(PROJECT))
    .mockResolvedValueOnce(response(page(0, values.length, values)));
  expect((await read("jira.project-version-page", { projectIdOrKey: "SYN", maxResults: 1 }, port)).isError).toBe(true);
});
const INVALID: readonly [Parameters<typeof read>[0], CatalogJsonObject][] = [
  ["jira.component-related-issue-counts", { componentId: "../42" }],
  ["jira.version-unresolved-issue-count", { versionId: "42", expand: "all" }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", orderBy: "arbitrary" }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", startAt: -1 }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", maxResults: 101 }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", expand: "remotelinks" }],
];
it.each(INVALID)("refuses unreviewed %s selectors before transport", async (name, args) => {
  const port = request({});
  expect((await read(name, args, port)).data.reason).toBe("invalid-input");
  expect(port).not.toHaveBeenCalled();
});
it.each(COUNTS)("preserves native denial for %s without another request", async (name, args) => {
  const port = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
  expect((await read(name, args, port)).data.reason).toBe("permission-denied");
  expect(port).toHaveBeenCalledTimes(1);
});
it("does not confuse an existing write or arbitrary route with a release read", () => {
  expect(isJiraReleaseRead("jira.project-version-page")).toBe(true);
  expect(isJiraReleaseRead("jira.update-version")).toBe(false);
  expect(isJiraReleaseRead("version/42")).toBe(false);
});
