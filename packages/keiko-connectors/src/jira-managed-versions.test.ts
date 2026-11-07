import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraObjectMutationBody } from "./jira-test-request/_support.js";
import {
  executeJiraVersionMutation,
  executeJiraVersionRead,
  isJiraVersionMutation,
  isJiraVersionRead,
} from "./jira-managed-versions.js";

const VERSION = {
  id: "12000",
  projectId: 10000,
  name: "Release 1",
  description: "Original description",
  startDate: "2026-11-01",
  releaseDate: "2026-11-30",
  released: false,
  archived: false,
  self: "https://untrusted.invalid/version/12000",
  moveUnfixedIssuesTo: "https://untrusted.invalid/move",
};
function answer(
  body: Record<string, unknown> | undefined,
  status = 200,
): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
interface OverrideContext {
  readonly path: string;
  readonly method: string;
  readonly written: boolean;
  readonly version: Record<string, unknown>;
}
type Override = (context: OverrideContext) => AtlassianWriteHttpOutcome | undefined;
function fixtureRead(path: string, version: Record<string, unknown>): AtlassianWriteHttpOutcome {
  if (path === "project/10000" || path === "project/REP")
    return answer({ id: "10000", key: "REP" });
  if (path === "project/10000/versions")
    return { ok: true, status: 200, body: undefined, items: [version] };
  return path === "version/12000" ? answer(version) : { ok: false, reason: "not-found" };
}
function fixture(override?: Override): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let version: Record<string, unknown> = { ...VERSION };
  let written = false;
  const request = vi.fn<JiraMutationRequest>((path, method = "GET", body) => {
    const replacement = override?.({ path, method, written, version });
    if (replacement !== undefined) return Promise.resolve(replacement);
    if (method !== "GET") {
      written = true;
      version = { ...version, ...jiraObjectMutationBody(body) };
      return Promise.resolve(
        answer(method === "POST" ? version : undefined, method === "POST" ? 201 : 200),
      );
    }
    return Promise.resolve(fixtureRead(path, version));
  });
  return request;
}
const CREATE = { projectId: "10000", name: "Release 2" };

describe("native Jira version reads", () => {
  it("lists only the selected project's versions and never exposes remote URLs", async () => {
    const request = fixture();
    const result = await executeJiraVersionRead(
      "jira.versions",
      { projectIdOrKey: "REP" },
      request,
    );
    expect(result).toEqual({
      data: {
        outcome: "succeeded",
        startAt: 0,
        total: 1,
        items: [
          {
            versionId: "12000",
            projectId: "10000",
            name: VERSION.name,
            description: VERSION.description,
            startDate: VERSION.startDate,
            releaseDate: VERSION.releaseDate,
            released: false,
            archived: false,
          },
        ],
      },
    });
    expect(request.mock.calls).toEqual([
      ["project/REP"],
      ["project/10000/versions", "GET", undefined, "json-array"],
    ]);
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });

  it("keeps absent release state and dates unknown instead of making them false or null", async () => {
    const request = fixture(({ path }) =>
      path.startsWith("version/")
        ? answer({ id: "12000", projectId: 10000, name: "Unknown state" })
        : undefined,
    );
    expect(await executeJiraVersionRead("jira.version", { versionId: "12000" }, request)).toEqual({
      data: { outcome: "succeeded", versionId: "12000", projectId: "10000", name: "Unknown state" },
    });
  });

  it("projects explicitly unset native dates without inventing calendar values", async () => {
    const request = fixture(() => answer({ ...VERSION, startDate: null, releaseDate: null }));
    const result = await executeJiraVersionRead("jira.version", { versionId: "12000" }, request);
    expect(result.data.outcome).toBe("succeeded");
    expect(result.data).not.toHaveProperty("startDate");
    expect(result.data).not.toHaveProperty("releaseDate");
  });

  it.each([
    ["another identity", { ...VERSION, id: "12001" }, "conflict"],
    ["a malformed release state", { ...VERSION, released: "false" }, "malformed-payload"],
    ["an unsafe numeric project", { ...VERSION, projectId: 9007199254740992 }, "malformed-payload"],
    ["an impossible date", { ...VERSION, releaseDate: "2026-02-29" }, "malformed-payload"],
  ] as const)("refuses %s", async (_label, value, reason) => {
    const request = fixture(() => answer(value));
    expect(
      await executeJiraVersionRead("jira.version", { versionId: "12000" }, request),
    ).toMatchObject({ isError: true, data: { reason } });
  });

  it.each([
    ["another project's version", [{ ...VERSION, projectId: 10001 }], "conflict"],
    ["duplicate versions", [VERSION, VERSION], "conflict"],
    ["an oversized collection", Array.from({ length: 1001 }, () => VERSION), "bounds-exceeded"],
  ] as const)(
    "refuses %s without reporting a partial collection",
    async (_label, items, reason) => {
      const request = fixture(({ path }) =>
        path.endsWith("/versions") ? { ok: true, status: 200, body: undefined, items } : undefined,
      );
      expect(
        await executeJiraVersionRead("jira.versions", { projectIdOrKey: "REP" }, request),
      ).toMatchObject({ isError: true, data: { reason } });
    },
  );

  it("accepts an explicitly empty native collection", async () => {
    const request = fixture(({ path }) =>
      path.endsWith("/versions")
        ? { ok: true, status: 200, body: undefined, items: [] }
        : undefined,
    );
    expect(
      await executeJiraVersionRead("jira.versions", { projectIdOrKey: "REP" }, request),
    ).toEqual({ data: { outcome: "succeeded", startAt: 0, total: 0, items: [] } });
  });

  it("pages a validated native collection without treating the first local page as complete", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({
      ...VERSION,
      id: String(12000 + index),
    }));
    const request = fixture(({ path }) =>
      path.endsWith("/versions") ? { ok: true, status: 200, body: undefined, items } : undefined,
    );
    const first = await executeJiraVersionRead(
      "jira.versions",
      { projectIdOrKey: "REP", maxResults: 2 },
      request,
    );
    expect(first.data).toMatchObject({ startAt: 0, total: 3, nextStartAt: 2 });
    expect(first.data.items).toHaveLength(2);
    const last = await executeJiraVersionRead(
      "jira.versions",
      { projectIdOrKey: "REP", startAt: 2, maxResults: 2 },
      request,
    );
    expect(last.data).toMatchObject({ startAt: 2, total: 3 });
    expect(last.data.items).toHaveLength(1);
    expect(last.data).not.toHaveProperty("nextStartAt");
  });

  it("refuses null or out-of-bound page coordinates before any request", async () => {
    const request = fixture();
    for (const page of [
      { startAt: -1 },
      { maxResults: 101 },
      { maxResults: 0 },
      { startAt: 0.5 },
      { startAt: null },
    ])
      expect(
        await executeJiraVersionRead("jira.versions", { projectIdOrKey: "REP", ...page }, request),
      ).toMatchObject({ isError: true, data: { reason: "invalid-input" } });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("native Jira version create and metadata update", () => {
  it("creates with a native numeric project, calendar dates and independent readback", async () => {
    const request = fixture();
    const args = {
      ...CREATE,
      description: "",
      startDate: "2028-02-29",
      releaseDate: "2028-03-01",
      released: false,
      archived: false,
    };
    expect(await executeJiraVersionMutation("jira.create-version", args, request)).toEqual({
      ok: true,
      receipt: { versionId: "12000" },
    });
    expect(request.mock.calls).toEqual([
      ["project/10000"],
      ["version", "POST", { ...args, projectId: 10000 }],
      ["version/12000"],
    ]);
  });

  it("refuses a different numeric project even if its key echoes the requested identifier", async () => {
    const request = fixture(() => answer({ id: "20000", key: "10000" }));
    expect(await executeJiraVersionMutation("jira.create-version", CREATE, request)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(request.mock.calls).toHaveLength(1);
  });

  it("releases only the bound version and checks explicit true in a separate GET", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionMutation(
        "jira.update-version",
        { versionId: "12000", released: true },
        request,
      ),
    ).toEqual({ ok: true, receipt: { versionId: "12000" } });
    expect(request.mock.calls).toEqual([
      ["version/12000"],
      ["version/12000", "PUT", { released: true }, "none"],
      ["version/12000"],
    ]);
  });

  it.each([
    ["a contradictory release", { ...VERSION, released: false }],
    ["a moved project", { ...VERSION, released: true, projectId: 10001 }],
    ["an omitted release state", { id: "12000", projectId: 10000, name: VERSION.name }],
  ] as const)("does not confirm %s after the effect", async (_label, current) => {
    const request = fixture(({ method, written }) =>
      method === "GET" && written ? answer(current) : undefined,
    );
    expect(
      await executeJiraVersionMutation(
        "jira.update-version",
        { versionId: "12000", released: true },
        request,
      ),
    ).toEqual({ ok: false, reason: "conflict", receipt: { versionId: "12000" } });
    expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
  });

  it("keeps an observed receipt when readback is unavailable", async () => {
    const request = fixture(({ method, written }) =>
      method === "GET" && written ? { ok: false, reason: "permission-denied" } : undefined,
    );
    expect(await executeJiraVersionMutation("jira.create-version", CREATE, request)).toEqual({
      ok: false,
      reason: "permission-denied",
      receipt: { versionId: "12000" },
    });
  });

  it.each(["jira.create-version", "jira.update-version"] as const)(
    "never replays %s after a lost acknowledgement",
    async (operation) => {
      const request = fixture(({ method }) =>
        method !== "GET" ? { ok: false, reason: "timeout" } : undefined,
      );
      const args =
        operation === "jira.create-version" ? CREATE : { versionId: "12000", released: true };
      const result = await executeJiraVersionMutation(operation, args, request);
      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expect(request.mock.calls).toHaveLength(2);
      if (operation === "jira.create-version") {
        expect(result).toHaveProperty("receipt.projectId", "10000");
        expect(result).not.toHaveProperty("receipt.versionId");
      } else expect(result).toHaveProperty("receipt.versionId", "12000");
    },
  );

  it("does not fabricate an identity from a malformed successful creation response", async () => {
    const request = fixture(({ method }) =>
      method === "POST" ? answer({ id: 0 }, 201) : undefined,
    );
    expect(await executeJiraVersionMutation("jira.create-version", CREATE, request)).toEqual({
      ok: false,
      reason: "malformed-payload",
      receipt: { projectId: "10000" },
    });
    expect(request.mock.calls).toHaveLength(2);
  });

  it("keeps a string int64 version identity exact during update", async () => {
    const id = "9223372036854775807";
    const request = fixture(({ path, written }) =>
      path === `version/${id}` ? answer({ ...VERSION, id, released: written }) : undefined,
    );
    // Use an explicit response queue because the native target is deliberately outside the fixture.
    request
      .mockResolvedValueOnce(answer({ ...VERSION, id }))
      .mockResolvedValueOnce(answer(undefined))
      .mockResolvedValueOnce(answer({ ...VERSION, id, released: true }));
    expect(
      await executeJiraVersionMutation(
        "jira.update-version",
        { versionId: id, released: true },
        request,
      ),
    ).toEqual({ ok: true, receipt: { versionId: id } });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      `version/${id}`,
      `version/${id}`,
      `version/${id}`,
    ]);
  });

  it.each(["jira.create-version", "jira.update-version"] as const)(
    "checks %s without dispatching an effect",
    async (operation) => {
      const request = fixture();
      const args =
        operation === "jira.create-version" ? CREATE : { versionId: "12000", released: true };
      expect(await executeJiraVersionMutation(operation, args, request, true)).toEqual({
        ok: true,
        receipt: {},
      });
      expect(request.mock.calls).toHaveLength(1);
      expect(request.mock.calls[0]?.[1]).toBeUndefined();
    },
  );

  it("refuses an already released version without another PUT", async () => {
    const request = fixture(() => answer({ ...VERSION, released: true }));
    expect(
      await executeJiraVersionMutation(
        "jira.update-version",
        { versionId: "12000", released: true },
        request,
      ),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      detail: { unchanged: true },
      receipt: { versionId: "12000" },
    });
    expect(request.mock.calls).toHaveLength(1);
  });
});

describe("version arguments remain closed and lossless", () => {
  const invalid: readonly CatalogJsonObject[] = [
    { versionId: "12000" },
    { versionId: "12000", projectId: "20000" },
    { versionId: "12000", project: "OTHER" },
    { versionId: "12000", moveUnfixedIssuesTo: "https://untrusted.invalid" },
    { versionId: "12000", released: "true" },
    { versionId: "12000", releaseDate: "2026-02-29" },
    { versionId: "12000", startDate: "2028-02-30" },
    { versionId: "12000", releaseDate: "30/Nov/2026" },
    { versionId: "12000", releaseDate: "2026-11-30T23:00:00-03:00" },
    { versionId: "12000", releaseDate: null },
    { versionId: "../12000", released: true },
    { versionId: "9223372036854775808", released: true },
  ];
  it.each(invalid)("refuses unsupported update arguments before I/O: %j", async (args) => {
    const request = fixture();
    expect(await executeJiraVersionMutation("jira.update-version", args, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["9007199254740992", "01", "0"])(
    "refuses an unsafe native project identifier %s",
    async (projectId) => {
      const request = fixture();
      expect(
        await executeJiraVersionMutation("jira.create-version", { ...CREATE, projectId }, request),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("exposes only the four approved operation names", () => {
    expect(isJiraVersionRead("jira.versions")).toBe(true);
    expect(isJiraVersionRead("jira.version")).toBe(true);
    expect(isJiraVersionMutation("jira.create-version")).toBe(true);
    expect(isJiraVersionMutation("jira.update-version")).toBe(true);
    expect(isJiraVersionMutation("jira.delete-version")).toBe(false);
    expect(isJiraVersionRead("jira.version-remotelink")).toBe(false);
  });
});

describe("version native normalization and retained acknowledgements", () => {
  it.each(["jira.version", "jira.versions"] as const)(
    "treats a native null description as absent in %s",
    async (operation) => {
      const request = fixture(({ path }) => fixtureRead(path, { ...VERSION, description: null }));
      const result = await executeJiraVersionRead(
        operation,
        operation === "jira.version" ? { versionId: "12000" } : { projectIdOrKey: "REP" },
        request,
      );
      expect(result.data.outcome).toBe("succeeded");
      expect(JSON.stringify(result.data)).not.toContain('"description"');
    },
  );
  it.each([null, undefined])(
    "confirms an explicit description clear returned as %s",
    async (description) => {
      const request = fixture(({ written, method }) =>
        written && method === "GET" ? answer({ ...VERSION, description }) : undefined,
      );
      expect(
        await executeJiraVersionMutation(
          "jira.update-version",
          { versionId: "12000", description: "" },
          request,
        ),
      ).toMatchObject({ ok: true });
      expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
    },
  );
  it("refuses surrounding name whitespace before transport", async () => {
    const request = fixture();
    expect(
      await executeJiraVersionMutation(
        "jira.create-version",
        { ...CREATE, name: " Release " },
        request,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([200, 202])(
    "retains a readable creation id and confirms an unexpected successful status %s",
    async (status) => {
      const request = fixture(({ path, method }) =>
        method === "POST"
          ? answer({ id: "12000" }, status)
          : path === "version/12000"
            ? answer({ ...VERSION, name: CREATE.name })
            : undefined,
      );
      expect(
        await executeJiraVersionMutation("jira.create-version", CREATE, request),
      ).toMatchObject({ ok: true, receipt: { versionId: "12000" } });
      expect(request.mock.calls.at(-1)?.[0]).toBe("version/12000");
      expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
    },
  );
  it("retains the id when unusual acknowledgement readback is denied", async () => {
    const request = fixture(({ path, method }) =>
      method === "POST"
        ? answer({ id: "12000" }, 202)
        : path === "version/12000"
          ? { ok: false, reason: "permission-denied" }
          : undefined,
    );
    expect(await executeJiraVersionMutation("jira.create-version", CREATE, request)).toMatchObject({
      ok: false,
      receipt: { versionId: "12000" },
    });
    expect(request.mock.calls.at(-1)?.[0]).toBe("version/12000");
    expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
  });
  it("names the description character ceiling before any I/O", async () => {
    const request = fixture();
    const result = await executeJiraVersionMutation(
      "jira.update-version",
      { versionId: "12000", description: "a".repeat(32769) },
      request,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { messages: [expect.stringContaining("descriptions of at most 32768 characters")] },
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("names the safe native project-number ceiling before dispatch", async () => {
    const request = fixture();
    const result = await executeJiraVersionMutation(
      "jira.create-version",
      { ...CREATE, projectId: "9007199254740992" },
      request,
    );
    expect(result).toMatchObject({
      ok: false,
      detail: { fieldId: "projectId", messages: [expect.stringContaining("9007199254740991")] },
    });
    expect(request).not.toHaveBeenCalled();
  });
});
