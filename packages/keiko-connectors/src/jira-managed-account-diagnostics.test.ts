import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { requestFor } from "./jira-managed-mutations.js";
import {
  executeJiraAccountDiagnosticRead as read,
  isJiraAccountDiagnosticRead,
  JIRA_ACCOUNT_DIAGNOSTIC_READS,
} from "./jira-managed-account-diagnostics.js";

const port = (response: AtlassianWriteHttpOutcome) =>
  vi.fn<JiraMutationRequest>().mockResolvedValue(response);
it.each([0, 12, Number.MAX_SAFE_INTEGER])(
  "retains observed cached duplicate-account count %s without flushing",
  async (count) => {
    const request = port({ ok: true, status: 200, body: { count, hostname: "private.invalid" } });
    expect((await read("jira.duplicate-user-count", {}, request)).data).toEqual({
      outcome: "succeeded",
      count,
      observationScope: "cached-duplicate-accounts",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "user/duplicated/count?flush=false",
      "GET",
      undefined,
      "json",
    );
  },
);
it.each([undefined, null, "0", -1, 1.5, Number.NaN, Infinity])(
  "does not invent a zero count from malformed %s",
  async (count) => {
    expect(
      (
        await read(
          "jira.duplicate-user-count",
          {},
          port({ ok: true, status: 200, body: { count } }),
        )
      ).data.reason,
    ).toBe("malformed-payload");
  },
);
it("distinguishes a valid native count above exact numeric bounds", async () => {
  expect(
    (
      await read(
        "jira.duplicate-user-count",
        {},
        port({ ok: true, status: 200, body: { count: Number.MAX_SAFE_INTEGER + 1 } }),
      )
    ).data.reason,
  ).toBe("bounds-exceeded");
});
it("locally pages native user mappings and omits unrelated response fields", async () => {
  const request = port({
    ok: true,
    status: 200,
    body: {
      first: [
        {
          directoryId: 1,
          directoryName: "ldap.private.invalid",
          userActive: false,
          password: "omitted",
        },
      ],
      second: [
        {
          directoryId: "9223372036854775807",
          directoryName: "Secondary directory",
          userActive: true,
        },
        { directoryId: 3 },
      ],
    },
  });
  expect((await read("jira.duplicate-users", { startAt: 1, maxResults: 1 }, request)).data).toEqual(
    {
      outcome: "succeeded",
      startAt: 1,
      total: 2,
      observationScope: "cached-duplicate-accounts",
      items: [
        {
          username: "second",
          directories: [
            {
              directoryId: "9223372036854775807",
              directoryName: "Secondary directory",
              userActive: true,
            },
            { directoryId: "3" },
          ],
        },
      ],
    },
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/duplicated/list?flush=false",
    "GET",
    undefined,
    "json",
  );
});
it("preserves false versus omitted account activity and an explicit empty directory list", async () => {
  const result = await read(
    "jira.duplicate-users",
    {},
    port({
      ok: true,
      status: 200,
      body: {
        first: [
          { directoryId: 1, userActive: false },
          { directoryId: 2, userActive: null },
        ],
        second: [],
      },
    }),
  );
  expect(result.data.items).toEqual([
    {
      username: "first",
      directories: [{ directoryId: "1", userActive: false }, { directoryId: "2" }],
    },
    { username: "second", directories: [] },
  ]);
});
it.each([
  { first: null },
  { first: {} },
  { first: [{ directoryId: 0 }] },
  { first: [{ directoryId: 1, userActive: "false" }] },
  { first: [{ directoryId: 1 }, { directoryId: "1" }] },
  { "\ud800": [] },
])("refuses malformed native mappings without a successful prefix: %j", async (body) => {
  expect(
    (await read("jira.duplicate-users", {}, port({ ok: true, status: 200, body }))).data.reason,
  ).toBe("malformed-payload");
});
it("refuses oversized native mappings and directory collections in full", async () => {
  const tooMany = Array.from(
    { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
    (_, index) => index + 1,
  );
  for (const body of [
    Object.fromEntries(tooMany.map((id) => [String(id), []])),
    { one: tooMany.map((directoryId) => ({ directoryId })) },
  ]) {
    expect(
      (await read("jira.duplicate-users", {}, port({ ok: true, status: 200, body }))).data.reason,
    ).toBe("bounds-exceeded");
  }
});
it.each([false, true])(
  "reads policy requirement messages for hasOldPassword=%s without any credential input",
  async (hasOldPassword) => {
    const request = port({
      ok: true,
      status: 200,
      body: undefined,
      items: ["At least ten characters.", "Avoid the account name."],
    });
    expect(
      (await read("jira.password-policy", { hasOldPassword, maxResults: 1 }, request)).data,
    ).toEqual({
      outcome: "succeeded",
      hasOldPassword,
      policyScope: "requirements-only",
      startAt: 0,
      total: 2,
      nextStartAt: 1,
      items: [{ requirement: "At least ten characters." }],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `password/policy?hasOldPassword=${String(hasOldPassword)}`,
      "GET",
      undefined,
      "json-array",
    );
  },
);
it("keeps an explicit empty policy requirement list empty", async () => {
  expect(
    (
      await read(
        "jira.password-policy",
        {},
        port({ ok: true, status: 200, body: undefined, items: [] }),
      )
    ).data,
  ).toMatchObject({ items: [], total: 0, hasOldPassword: false, policyScope: "requirements-only" });
});
it.each([null, 0, "false"])(
  "rejects an untyped hasOldPassword selector %j before dispatch",
  async (hasOldPassword) => {
    const request = port({ ok: false, reason: "timeout" });
    expect((await read("jira.password-policy", { hasOldPassword }, request)).data.reason).toBe(
      "invalid-input",
    );
    expect(request).not.toHaveBeenCalled();
  },
);
it.each(JIRA_ACCOUNT_DIAGNOSTIC_READS)(
  "rejects cache flush, credential, target and method fields on %s",
  async (name) => {
    const selections: readonly CatalogJsonObject[] = [
      { flush: true },
      { password: "never-sent" },
      { url: "https://untrusted.invalid" },
      { method: "POST" },
    ];
    for (const args of selections) {
      const request = port({ ok: false, reason: "timeout" });
      expect((await read(name, args, request)).data.reason).toBe("invalid-input");
      expect(request).not.toHaveBeenCalled();
    }
  },
);
it.each(JIRA_ACCOUNT_DIAGNOSTIC_READS)(
  "preserves native permission failures for %s without alternate requests",
  async (name) => {
    const request = port({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await read(name, {}, request)).data.reason).toBe("permission-denied");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("preserves a native search error as text without following embedded URLs", async () => {
  const message = "Search unavailable; see https://jira.example.invalid/help";
  const request = port({ ok: true, status: 200, body: { errorStringI18n: message } });
  expect((await read("jira.search-error", {}, request)).data).toEqual({
    outcome: "succeeded",
    scope: "current-user-http-context",
    errorPresent: true,
    message,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("search/error/lookup", "GET", undefined, "json");
});
it("treats only native204 as an explicit absent search error", async () => {
  expect(
    (await read("jira.search-error", {}, port({ ok: true, status: 204, body: undefined }))).data,
  ).toEqual({ outcome: "succeeded", scope: "current-user-http-context", errorPresent: false });
});
it("handles native204 through the actual strict JSON transport without relaxing other JSON reads", async () => {
  const http = vi.fn<AtlassianHttpBodyPort>().mockResolvedValue({
    kind: "response",
    status: 204,
    bodyText: "",
    bodyBytes: 0,
    truncated: false,
  });
  const request = requestFor(
    { deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http },
    {
      invocationId: "search-error-204",
      correlationId: "search-error-204",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
  );
  expect((await read("jira.search-error", {}, request)).data).toEqual({
    outcome: "succeeded",
    scope: "current-user-http-context",
    errorPresent: false,
  });
  expect(http).toHaveBeenCalledTimes(1);
  expect(http.mock.calls[0]?.[0]).toMatchObject({
    method: "GET",
    url: "https://jira.example.invalid/context/rest/api/2/search/error/lookup",
  });
});
it.each([Number.MAX_SAFE_INTEGER + 1, "A".repeat(256)])(
  "refuses native directory precision/text bounds without returning a prefix: %#",
  async (entry) => {
    const directory =
      typeof entry === "number" ? { directoryId: entry } : { directoryId: 1, directoryName: entry };
    expect(
      (
        await read(
          "jira.duplicate-users",
          {},
          port({ ok: true, status: 200, body: { user: [directory] } }),
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  },
);
it("refuses an oversized requirement message before returning a deceptively complete list", async () => {
  expect(
    (
      await read(
        "jira.password-policy",
        {},
        port({ ok: true, status: 200, body: undefined, items: ["A".repeat(1025)] }),
      )
    ).data.reason,
  ).toBe("bounds-exceeded");
});
it.each([undefined, null, ""])(
  "keeps a missing native200 search message unavailable: %j",
  async (errorStringI18n) => {
    expect(
      (
        await read(
          "jira.search-error",
          {},
          port({ ok: true, status: 200, body: { errorStringI18n } }),
        )
      ).data.reason,
    ).toBe("unavailable");
  },
);
it("has only the four fixed observations", () => {
  expect(JIRA_ACCOUNT_DIAGNOSTIC_READS).toHaveLength(4);
  expect(isJiraAccountDiagnosticRead("jira.reset-password")).toBe(false);
  expect(isJiraAccountDiagnosticRead("jira.flush-users")).toBe(false);
});
