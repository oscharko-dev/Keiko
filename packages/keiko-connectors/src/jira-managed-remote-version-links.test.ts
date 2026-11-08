import { expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraRemoteVersionLinkRead as read,
  isJiraRemoteVersionLinkRead,
} from "./jira-managed-remote-version-links.js";

const VERSION = { id: "42", name: "Release", projectId: 10000 };
function port(
  body: Record<string, unknown>,
  version: Record<string, unknown> = VERSION,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>((path) =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: path === "version/42" ? version : body,
    }),
  );
}
function link(value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Observed link", link: JSON.stringify(value), ...extra };
}
it("binds a version before reading its fixed link resource and preserves typed null/empty/false/zero", async () => {
  const request = port(
    link(
      { "": [], "a~/b": false, empty: {}, nil: null, zero: 0, text: "" },
      {
        self: "http://proxy.invalid/context/rest/api/2/version/42/remotelink/selected",
      },
    ),
  );
  const result = await read(
    "jira.version-remote-link",
    { versionId: "42", globalId: "selected" },
    request,
  );
  expect(result.data).toMatchObject({
    outcome: "succeeded",
    linkScope: "native-version-links",
    versionId: "42",
    versionName: "Release",
    selectedGlobalId: "selected",
  });
  expect(result.data.items).toEqual([
    {
      name: "Observed link",
      reviewIdentityAvailable: true,
      globalId: "selected",
      valueAvailable: true,
      valueNodes: [
        { path: "", kind: "object", childCount: 6 },
        { path: "/", kind: "array", childCount: 0 },
        { path: "/a~0~1b", kind: "boolean", booleanValue: false },
        { path: "/empty", kind: "object", childCount: 0 },
        { path: "/nil", kind: "null" },
        { path: "/zero", kind: "number", numberValue: 0 },
        { path: "/text", kind: "string", textValue: "" },
      ],
    },
  ]);
  expect(request.mock.calls).toEqual([
    ["version/42", "GET", undefined, "json"],
    ["version/42/remotelink/selected", "GET", undefined, "json"],
  ]);
});
it("uses a global-ID query without inventing version identity or following encoded URLs", async () => {
  const globalId = "system=https://support.invalid&id=1";
  const request = port({
    links: [
      link("native text", {
        self: `https://proxy.invalid/rest/api/2/version/42/remotelink/${encodeURIComponent(globalId)}`,
      }),
    ],
  });
  const result = await read("jira.remote-version-links", { globalId }, request);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    `version/remotelink?${new URLSearchParams({ globalId }).toString()}`,
    "GET",
    undefined,
    "json",
  );
  expect(result.data.selectedGlobalId).toBe(globalId);
  expect(result.data).not.toHaveProperty("versionId");
  expect(result.data.items).toEqual([
    {
      name: "Observed link",
      reviewIdentityAvailable: true,
      globalId,
      valueAvailable: true,
      valueNodes: [{ path: "", kind: "string", textValue: "native text" }],
    },
  ]);
});
it("locally pages the validated collection without changing the native request", async () => {
  const request = port({ links: [link(0), link(false), link(null)] });
  const result = await read(
    "jira.version-remote-links",
    { versionId: "42", startAt: 1, maxResults: 1 },
    request,
  );
  expect(request.mock.calls[1]).toEqual(["version/42/remotelink", "GET", undefined, "json"]);
  expect(result.data).toMatchObject({ startAt: 1, total: 3, nextStartAt: 2 });
  expect(result.data.items).toEqual([
    {
      name: "Observed link",
      reviewIdentityAvailable: false,
      valueAvailable: true,
      valueNodes: [{ path: "", kind: "boolean", booleanValue: false }],
    },
  ]);
});
it("keeps missing link content unknown and actual encoded null observed", async () => {
  const request = port({
    links: [{ name: "No content" }, { name: "Null field", link: null }, link(null)],
  });
  expect(
    (await read("jira.remote-version-links", { globalId: "selected" }, request)).data.items,
  ).toEqual([
    { name: "No content", reviewIdentityAvailable: false, valueAvailable: false },
    { name: "Null field", reviewIdentityAvailable: false, valueAvailable: false },
    {
      name: "Observed link",
      reviewIdentityAvailable: false,
      valueAvailable: true,
      valueNodes: [{ path: "", kind: "null" }],
    },
  ]);
});
it("decodes the documented native JSON string only once", async () => {
  const text = '{"nested":"plain text, not another parse"}';
  const result = await read(
    "jira.version-remote-link",
    { versionId: "42", globalId: "selected" },
    port(link(text)),
  );
  expect(result.data.items).toEqual([
    {
      name: "Observed link",
      reviewIdentityAvailable: false,
      valueAvailable: true,
      valueNodes: [{ path: "", kind: "string", textValue: text }],
    },
  ]);
});
it("exposes a collection review identity only when native payload identity matches its exact self resource", async () => {
  const request = port({
    links: [
      link(
        { globalId: "release:link", flag: false },
        { self: "https://proxy.invalid/context/rest/api/2/version/42/remotelink/release%3Alink" },
      ),
      link(
        { globalId: "another:link" },
        { self: "https://proxy.invalid/context/rest/api/2/version/42/remotelink/opaque" },
      ),
      link(null, {
        name: "not-an-identity",
        self: "https://proxy.invalid/context/rest/api/2/version/42/remotelink/not-an-identity",
      }),
    ],
  });
  const result = await read("jira.version-remote-links", { versionId: "42" }, request);
  expect(result.data.items).toMatchObject([
    { reviewIdentityAvailable: true, globalId: "release:link" },
    { reviewIdentityAvailable: false },
    { reviewIdentityAvailable: false },
  ]);
  expect(result.data.items).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ globalId: "opaque" }),
      expect.objectContaining({ globalId: "not-an-identity" }),
    ]),
  );
  expect(request.mock.calls).toHaveLength(2);
});
it.each([
  "https://remote.invalid/rest/api/2/version/999/remotelink/selected",
  "https://remote.invalid/rest/api/2/version/42/remotelink/another",
  "https://remote.invalid/rest/api/2/version/42/remotelink/selected?expand=anything",
  "https://user:password@remote.invalid/rest/api/2/version/42/remotelink/selected",
])("refuses a contradictory supplied native self: %s", async (self) => {
  const request = port(link({}, { self }));
  expect(
    (await read("jira.version-remote-link", { versionId: "42", globalId: "selected" }, request))
      .data.reason,
  ).toBe("conflict");
  expect(request).toHaveBeenCalledTimes(2);
});
it("rejects a mismatched native version before reading its link collection", async () => {
  for (const version of [
    { ...VERSION, id: "43" },
    { ...VERSION, self: "https://proxy.invalid/rest/api/2/version/43" },
  ]) {
    const request = port({ links: [] }, version);
    expect(
      (await read("jira.version-remote-links", { versionId: "42" }, request)).data.reason,
    ).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(1);
  }
});
it.each([".", "..", "a/b", "a\\b", "a%2Fb", "a\n", "\ud800"])(
  "refuses an unaddressable path global ID %j before version lookup",
  async (globalId) => {
    const request = port(link({}));
    expect(
      (await read("jira.version-remote-link", { versionId: "42", globalId }, request)).data.reason,
    ).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  },
);
it.each(["", "{", "undefined", 7, {}])(
  "refuses malformed native encoded link content: %j",
  async (value) => {
    const result = await read(
      "jira.remote-version-links",
      { globalId: "selected" },
      port({ links: [{ link: value }] }),
    );
    expect(result.data.reason).toBe("malformed-payload");
  },
);
it("rejects oversized link values and native collections without pretending the value is complete", async () => {
  const oversized = await read(
    "jira.remote-version-links",
    { globalId: "selected" },
    port({ links: [link("x".repeat(32769))] }),
  );
  expect(oversized.data.reason).toBe("bounds-exceeded");
  const collection = await read(
    "jira.remote-version-links",
    { globalId: "selected" },
    port({ links: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => link(0)) }),
  );
  expect(collection.data.reason).toBe("bounds-exceeded");
});
it("validates even a malformed row outside the requested local page", async () => {
  const result = await read(
    "jira.remote-version-links",
    { globalId: "selected", maxResults: 1 },
    port({ links: [link(0), { link: "{" }] }),
  );
  expect(result.data.reason).toBe("malformed-payload");
});
it("propagates native access failures and recognizes only the three fixed read names", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "permission-denied" });
  expect((await read("jira.version-remote-links", { versionId: "42" }, request)).data.reason).toBe(
    "permission-denied",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(isJiraRemoteVersionLinkRead("jira.version-remote-link")).toBe(true);
  expect(isJiraRemoteVersionLinkRead("jira.create-version-remote-link")).toBe(false);
});
