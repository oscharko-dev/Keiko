import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraAdministrativeObservationRead as read } from "./jira-managed-administrative-observations.js";

it("binds a permission scheme before reading its exact attribute and preserves empty text", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValueOnce({ ok: true, status: 200, body: { id: 37, name: "Engineering" } })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { key: "review ~state", value: "", defaultValue: "not copied" },
    });
  expect(
    (
      await read(
        "jira.permission-scheme-attribute",
        { schemeId: "37", attributeKey: "review ~state" },
        request,
      )
    ).data,
  ).toEqual({
    outcome: "succeeded",
    schemeId: "37",
    attributeKey: "review ~state",
    attributeScope: "permission-scheme-configuration",
    valueState: "observed",
    textValue: "",
  });
  expect(request.mock.calls).toEqual([
    ["permissionscheme/37", "GET", undefined, "json"],
    ["permissionscheme/37/attribute/review%20~state", "GET", undefined, "json"],
  ]);
});
it.each([undefined, null])("keeps an absent attribute value unknown: %j", async (value) => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValueOnce({ ok: true, status: 200, body: { id: 37, name: "Engineering" } })
    .mockResolvedValueOnce({ ok: true, status: 200, body: { key: "review", value } });
  expect(
    (
      await read(
        "jira.permission-scheme-attribute",
        { schemeId: "37", attributeKey: "review" },
        request,
      )
    ).data,
  ).toMatchObject({ valueState: "unknown" });
});
it("refuses a different native parent before reading the attribute", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: { id: 38, name: "Other" } });
  expect(
    (
      await read(
        "jira.permission-scheme-attribute",
        { schemeId: "37", attributeKey: "review" },
        request,
      )
    ).data.reason,
  ).toBe("malformed-payload");
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  { key: "foreign", value: "true" },
  { key: "review", value: false },
  { key: "review", value: {} },
  { key: "review", value: "\ud800" },
])("refuses mismatched or malformed attribute data: %j", async (body) => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValueOnce({ ok: true, status: 200, body: { id: 37, name: "Engineering" } })
    .mockResolvedValueOnce({ ok: true, status: 200, body });
  expect(
    (
      await read(
        "jira.permission-scheme-attribute",
        { schemeId: "37", attributeKey: "review" },
        request,
      )
    ).data.reason,
  ).toBe("malformed-payload");
});
it.each([".", "..", "a/b", "a%2fb", "a\\b"])(
  "refuses unsafe attribute selector %s before any request",
  async (attributeKey) => {
    const request = vi.fn<JiraMutationRequest>();
    expect(
      (await read("jira.permission-scheme-attribute", { schemeId: "37", attributeKey }, request))
        .data.reason,
    ).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  },
);
it("retains distinct native email formats with the same event ID and drops recipient information", async () => {
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      userEmailAddress: "discarded@example.invalid",
      emailTypes: [
        {
          id: 1,
          eventName: "Issue created",
          templateName: "issuecreated.vm",
          active: false,
          batchedNotification: false,
          html: true,
          text: false,
        },
        { id: 1, templateName: "issuecreated-text.vm", text: true },
      ],
    },
  });
  const first = await read("jira.email-template-types", { maxResults: 1 }, request);
  expect(first.data).toEqual({
    outcome: "succeeded",
    templateScope: "notification-type-metadata",
    startAt: 0,
    total: 2,
    nextStartAt: 1,
    items: [
      {
        id: "1",
        eventName: "Issue created",
        templateName: "issuecreated.vm",
        active: false,
        batchedNotification: false,
        html: true,
        text: false,
      },
    ],
  });
  const second = await read("jira.email-template-types", { startAt: 1, maxResults: 1 }, request);
  expect(second.data.items).toEqual([
    { id: "1", templateName: "issuecreated-text.vm", text: true },
  ]);
  expect(request).toHaveBeenCalledWith("email-templates/types", "GET", undefined, "json");
  expect(JSON.stringify([first, second])).not.toContain("discarded@example.invalid");
});
it("distinguishes known empty email metadata from an unavailable collection", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: { emailTypes: [] } });
  expect((await read("jira.email-template-types", {}, request)).data).toMatchObject({
    items: [],
    total: 0,
  });
  request.mockResolvedValue({ ok: true, status: 200, body: {} });
  expect((await read("jira.email-template-types", {}, request)).data.reason).toBe(
    "malformed-payload",
  );
});
it.each([
  { emailTypes: [{ id: 0 }] },
  { emailTypes: [{ id: 1, active: "false" }] },
  { emailTypes: null },
])("refuses a malformed email metadata collection without a partial prefix: %j", async (body) => {
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
  expect((await read("jira.email-template-types", {}, request)).data.reason).toBe(
    "malformed-payload",
  );
});
it("refuses email collection bounds in full", async () => {
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      emailTypes: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
        id: index + 1,
      })),
    },
  });
  expect((await read("jira.email-template-types", {}, request)).data.reason).toBe(
    "bounds-exceeded",
  );
});
it("returns native permission refusal without export, send or fallback effects", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
  expect((await read("jira.email-template-types", {}, request)).data.reason).toBe(
    "permission-denied",
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "email-templates/types",
    "GET",
    undefined,
    "json",
  );
});
it("refuses unsupported mail actions and caller-controlled targets before dispatch", async () => {
  const inputs: readonly CatalogJsonObject[] = [
    { send: true },
    { export: true },
    { url: "https://untrusted.invalid" },
    { maxResults: 101 },
  ];
  for (const args of inputs) {
    const request = vi.fn<JiraMutationRequest>();
    expect((await read("jira.email-template-types", args, request)).data.reason).toBe(
      "invalid-input",
    );
    expect(request).not.toHaveBeenCalled();
  }
});
