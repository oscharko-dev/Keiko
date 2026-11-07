import { describe, expect, it, vi } from "vitest";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraComponentMutation,
  executeJiraComponentRead,
  isJiraComponentMutation,
  isJiraComponentRead,
} from "./jira-managed-components.js";

const PROJECT = { id: "10000", key: "SYN" };
const COMPONENT = {
  id: "9007199254740993",
  name: "Engine",
  project: "SYN",
  description: "Before",
  lead: { name: "owner", emailAddress: "not-for-projection@example.invalid" },
  assigneeType: "PROJECT_LEAD",
  archived: false,
  deleted: false,
  self: "https://untrusted.example.invalid/component",
};
function response(body: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
interface FixtureCall {
  readonly path: string;
  readonly method: string;
  readonly written: boolean;
  readonly body: Readonly<Record<string, unknown>> | undefined;
}
function readResponse(path: string, component: Record<string, unknown>): AtlassianWriteHttpOutcome {
  if (path === "project/SYN" || path === "project/10000") return response(PROJECT);
  if (path === "project/10000/components")
    return { ok: true, status: 200, body: undefined, items: [component] };
  if (path === `component/${COMPONENT.id}`) return response(component);
  return { ok: false, reason: "not-found", httpStatus: 404 };
}
function fixture(override?: (call: FixtureCall) => AtlassianWriteHttpOutcome | undefined): {
  readonly request: ReturnType<typeof vi.fn<JiraMutationRequest>>;
} {
  let component: Record<string, unknown> = structuredClone(COMPONENT);
  let written = false;
  const request = vi.fn<JiraMutationRequest>((path, method = "GET", body) => {
    const custom = override?.({ path, method, body, written });
    if (custom !== undefined) return Promise.resolve(custom);
    if (method !== "GET") {
      written = true;
      component = {
        ...component,
        ...body,
        ...(body?.leadUserName === undefined ? {} : { lead: { name: body.leadUserName } }),
      };
      return Promise.resolve(response(component, method === "POST" ? 201 : 200));
    }
    return Promise.resolve(readResponse(path, component));
  });
  return { request };
}
function writes(request: ReturnType<typeof vi.fn<JiraMutationRequest>>): readonly unknown[] {
  return request.mock.calls.filter(([, method]) => method !== undefined && method !== "GET");
}

describe("closed native component reads", () => {
  it("returns exact string identities and selected metadata without remote URLs or full users", async () => {
    const { request } = fixture();
    const result = await executeJiraComponentRead(
      "jira.component",
      { componentId: COMPONENT.id },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [
        {
          id: COMPONENT.id,
          name: "Engine",
          project: "SYN",
          description: "Before",
          leadUserName: "owner",
          assigneeType: "PROJECT_LEAD",
          archived: false,
          deleted: false,
        },
      ],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(`component/${COMPONENT.id}`);
  });

  it("binds the project and locally pages the bounded native list without a synthetic remote cursor", async () => {
    const { request } = fixture(({ path }) =>
      path.endsWith("/components")
        ? {
            ok: true,
            status: 200,
            body: undefined,
            items: [COMPONENT, { ...COMPONENT, id: "52" }, { ...COMPONENT, id: "53" }],
          }
        : undefined,
    );
    const result = await executeJiraComponentRead(
      "jira.components",
      { projectIdOrKey: "SYN", startAt: 1, maxResults: 1 },
      request,
    );
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      startAt: 1,
      total: 3,
      nextStartAt: 2,
      items: [{ id: "52" }],
    });
    expect(request.mock.calls).toEqual([
      ["project/SYN"],
      ["project/10000/components", "GET", undefined, "json-array"],
    ]);
  });

  it.each([
    ["jira.component", { componentId: "../1" }],
    ["jira.component", { componentId: "1", self: "https://other.invalid" }],
    ["jira.components", { projectIdOrKey: "../SYN" }],
    ["jira.components", { projectIdOrKey: "SYN", maxResults: 101 }],
  ] as const)("refuses invalid %s arguments before a request", async (operation, args) => {
    const { request } = fixture();
    expect((await executeJiraComponentRead(operation, args, request)).data.reason).toBe(
      "invalid-input",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { ...COMPONENT, id: 9007199254740992 },
    { ...COMPONENT, id: "9223372036854775808" },
    { ...COMPONENT, assigneeType: "UNKNOWN" },
    { ...COMPONENT, leadUserName: "different-owner" },
  ])("refuses malformed component metadata", async (component) => {
    const { request } = fixture(() => response(component));
    expect(
      (await executeJiraComponentRead("jira.component", { componentId: COMPONENT.id }, request))
        .data.reason,
    ).toBe("malformed-payload");
  });

  it.each([[COMPONENT, COMPONENT], [{ ...COMPONENT, project: "OTHER" }]])(
    "refuses duplicate or cross-project collection identities",
    async (...items) => {
      const { request } = fixture(({ path }) =>
        path.endsWith("/components")
          ? { ok: true, status: 200, body: undefined, items }
          : undefined,
      );
      expect(
        (await executeJiraComponentRead("jira.components", { projectIdOrKey: "SYN" }, request)).data
          .reason,
      ).toBe("malformed-payload");
    },
  );

  it("reports excessive native collections instead of silently truncating", async () => {
    const { request } = fixture(({ path }) =>
      path.endsWith("/components")
        ? {
            ok: true,
            status: 200,
            body: undefined,
            items: Array.from({ length: 1001 }, () => COMPONENT),
          }
        : undefined,
    );
    expect(
      (await executeJiraComponentRead("jira.components", { projectIdOrKey: "SYN" }, request)).data
        .reason,
    ).toBe("bounds-exceeded");
  });
});

describe("one governed component write with independent readback", () => {
  it("creates with the bound current project and verifies every requested native field", async () => {
    const { request } = fixture();
    const fields = {
      name: "New engine",
      description: "Plain **native** text",
      leadUserName: "lead",
      assigneeType: "COMPONENT_LEAD",
    };
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: PROJECT.id, ...fields },
        request,
      ),
    ).toEqual({
      ok: true,
      receipt: { componentId: COMPONENT.id, projectId: PROJECT.id, projectKey: "SYN" },
    });
    expect(request.mock.calls).toEqual([
      ["project/10000"],
      ["component", "POST", { ...fields, project: "SYN" }],
      [`component/${COMPONENT.id}`],
    ]);
  });

  it("updates only supplied fields on the pre-read identity and preserves the project", async () => {
    const { request } = fixture();
    expect(
      await executeJiraComponentMutation(
        "jira.update-component",
        { componentId: COMPONENT.id, description: "" },
        request,
      ),
    ).toMatchObject({ ok: true, receipt: { componentId: COMPONENT.id, projectKey: "SYN" } });
    expect(request.mock.calls).toEqual([
      [`component/${COMPONENT.id}`],
      ["project/SYN"],
      [`component/${COMPONENT.id}`, "PUT", { description: "" }],
      [`component/${COMPONENT.id}`],
    ]);
  });

  it.each(["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"])(
    "accepts the published assignee type %s",
    async (assigneeType) => {
      const { request } = fixture();
      expect(
        await executeJiraComponentMutation(
          "jira.create-component",
          { projectIdOrKey: "SYN", name: "New", assigneeType },
          request,
        ),
      ).toMatchObject({ ok: true });
    },
  );

  it.each([
    ["jira.create-component", { projectIdOrKey: "SYN" }],
    ["jira.create-component", { projectIdOrKey: "SYN", name: "New", archived: true }],
    ["jira.create-component", { projectIdOrKey: "SYN", name: "New", assigneeType: "OWNER" }],
    ["jira.update-component", { componentId: COMPONENT.id }],
    ["jira.update-component", { componentId: COMPONENT.id, project: "OTHER" }],
    ["jira.update-component", { componentId: COMPONENT.id, deleted: true }],
    ["jira.update-component", { componentId: COMPONENT.id, leadUserName: "" }],
  ] as const)("refuses unsupported %s input without transport", async (operation, args) => {
    const { request } = fixture();
    expect(await executeJiraComponentMutation(operation, args, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("names the local serialized UTF-8 byte bound for multibyte descriptions", async () => {
    const { request } = fixture();
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: "SYN", name: "New", description: "界".repeat(12000) },
        request,
      ),
    ).toMatchObject({
      ok: false,
      detail: { validation: "invalid-field", messages: [expect.stringMatching(/32768.*UTF-8/u)] },
    });
    expect(writes(request)).toEqual([]);
  });

  it.each([
    { ...COMPONENT, name: "Unchanged" },
    { ...COMPONENT, id: "52", name: "New" },
    { ...COMPONENT, project: "OTHER", name: "New" },
  ])(
    "does not confirm a creation from its acknowledgement when independent state disagrees",
    async (readback) => {
      const { request } = fixture(({ written, method }) =>
        written && method === "GET" ? response(readback) : undefined,
      );
      expect(
        await executeJiraComponentMutation(
          "jira.create-component",
          { projectIdOrKey: "SYN", name: "New" },
          request,
        ),
      ).toMatchObject({ ok: false, reason: "conflict", receipt: { componentId: COMPONENT.id } });
      expect(writes(request)).toHaveLength(1);
    },
  );

  it("requires a requested lead to be present in independent readback", async () => {
    const { request } = fixture(({ written, method }) => {
      if (!written || method !== "GET") return undefined;
      const { lead: _lead, ...component } = COMPONENT;
      return response({ ...component, name: "New" });
    });
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: "SYN", name: "New", leadUserName: "lead" },
        request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });

  it.each([52, "0", "1.2", "9223372036854775808"])(
    "does not trust malformed create identity %s",
    async (componentId) => {
      const { request } = fixture(({ method }) =>
        method === "POST" ? response({ id: componentId }, 201) : undefined,
      );
      expect(
        await executeJiraComponentMutation(
          "jira.create-component",
          { projectIdOrKey: "SYN", name: "New" },
          request,
        ),
      ).toEqual({
        ok: false,
        reason: "malformed-payload",
        receipt: { projectId: PROJECT.id, projectKey: "SYN" },
      });
      expect(writes(request)).toHaveLength(1);
    },
  );

  it("preserves an identified creation when readback is unavailable", async () => {
    const { request } = fixture(({ written }) =>
      written ? { ok: false, reason: "unavailable" } : undefined,
    );
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: "SYN", name: "New" },
        request,
      ),
    ).toMatchObject({ ok: false, reason: "unavailable", receipt: { componentId: COMPONENT.id } });
    expect(writes(request)).toHaveLength(1);
  });

  it.each(["conflict", "timeout", "unavailable"] as const)(
    "never upgrades or replays an uncertain update after %s",
    async (reason) => {
      let put = false;
      const { request } = fixture(({ method, path }) => {
        if (method === "PUT") {
          put = true;
          return { ok: false, reason, httpStatus: 409 };
        }
        return put && path.startsWith("component/")
          ? response({ ...COMPONENT, name: "New" })
          : undefined;
      });
      expect(
        await executeJiraComponentMutation(
          "jira.update-component",
          { componentId: COMPONENT.id, name: "New" },
          request,
        ),
      ).toMatchObject({ ok: false, reason, receipt: { componentId: COMPONENT.id } });
      expect(writes(request)).toHaveLength(1);
      expect(request.mock.calls.at(-1)).toEqual([`component/${COMPONENT.id}`]);
    },
  );

  it("does not guess a component identity or retry when creation times out", async () => {
    const { request } = fixture(({ method }) =>
      method === "POST" ? { ok: false, reason: "timeout" } : undefined,
    );
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: "SYN", name: "New" },
        request,
      ),
    ).toEqual({
      ok: false,
      reason: "timeout",
      receipt: { projectId: PROJECT.id, projectKey: "SYN" },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["jira.create-component", { projectIdOrKey: "SYN", name: "New" }],
    ["jira.update-component", { componentId: COMPONENT.id, name: "New" }],
  ] as const)("checks %s through the same validation without writing", async (operation, args) => {
    const { request } = fixture();
    expect(await executeJiraComponentMutation(operation, args, request, true)).toEqual({
      ok: true,
      receipt: {},
    });
    expect(writes(request)).toEqual([]);
  });

  it("refuses an already-held update before effects", async () => {
    const { request } = fixture();
    expect(
      await executeJiraComponentMutation(
        "jira.update-component",
        { componentId: COMPONENT.id, name: COMPONENT.name },
        request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(writes(request)).toEqual([]);
  });

  it("accepts only the four closed names", () => {
    expect(isJiraComponentRead("jira.components")).toBe(true);
    expect(isJiraComponentRead("jira.component")).toBe(true);
    expect(isJiraComponentMutation("jira.create-component")).toBe(true);
    expect(isJiraComponentMutation("jira.update-component")).toBe(true);
    expect(isJiraComponentRead("jira.proxy")).toBe(false);
    expect(isJiraComponentMutation("jira.delete-component")).toBe(false);
  });
});

describe("component native normalization and retained acknowledgements", () => {
  it.each(["jira.component", "jira.components"] as const)(
    "treats native null description and lead as absent in %s",
    async (operation) => {
      const empty = { ...COMPONENT, description: null, lead: null, leadUserName: null };
      const { request } = fixture(({ path }) => readResponse(path, empty));
      const result = await executeJiraComponentRead(
        operation,
        operation === "jira.component" ? { componentId: COMPONENT.id } : { projectIdOrKey: "SYN" },
        request,
      );
      expect(result.data.outcome).toBe("succeeded");
      expect(result.data).toHaveProperty("items.0");
      expect(result.data).not.toHaveProperty("items.0.description");
      expect(JSON.stringify(result.data)).not.toContain("leadUserName");
    },
  );
  it.each([null, undefined])(
    "confirms an explicit description clear returned as %s",
    async (description) => {
      const { request } = fixture(({ written, method }) =>
        written && method === "GET" ? response({ ...COMPONENT, description }) : undefined,
      );
      expect(
        await executeJiraComponentMutation(
          "jira.update-component",
          { componentId: COMPONENT.id, description: "" },
          request,
        ),
      ).toMatchObject({ ok: true });
      expect(writes(request)).toHaveLength(1);
    },
  );
  it("confirms a lead username normalized only by case", async () => {
    const { request } = fixture(({ written, method }) =>
      written && method === "GET"
        ? response({ ...COMPONENT, lead: { name: "NEXT" }, leadUserName: "NEXT" })
        : undefined,
    );
    expect(
      await executeJiraComponentMutation(
        "jira.update-component",
        { componentId: COMPONENT.id, leadUserName: "next" },
        request,
      ),
    ).toMatchObject({ ok: true });
    expect(writes(request)).toHaveLength(1);
  });
  it("refuses surrounding name whitespace before transport", async () => {
    const { request } = fixture();
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: "SYN", name: " Core " },
        request,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([200, 202])(
    "retains a readable creation id and confirms an unexpected successful status %s",
    async (status) => {
      const stored = { ...COMPONENT, name: "New" };
      const { request } = fixture(({ path, method }) =>
        method === "POST"
          ? response({ id: COMPONENT.id }, status)
          : path.startsWith("component/")
            ? response(stored)
            : undefined,
      );
      expect(
        await executeJiraComponentMutation(
          "jira.create-component",
          { projectIdOrKey: "SYN", name: "New" },
          request,
        ),
      ).toMatchObject({ ok: true, receipt: { componentId: COMPONENT.id, projectId: PROJECT.id } });
      expect(request.mock.calls.at(-1)?.[0]).toBe(`component/${COMPONENT.id}`);
      expect(writes(request)).toHaveLength(1);
    },
  );
  it("retains the id when unusual acknowledgement readback is denied", async () => {
    const { request } = fixture(({ path, method }) =>
      method === "POST"
        ? response({ id: COMPONENT.id }, 202)
        : path.startsWith("component/")
          ? { ok: false, reason: "permission-denied" }
          : undefined,
    );
    expect(
      await executeJiraComponentMutation(
        "jira.create-component",
        { projectIdOrKey: "SYN", name: "New" },
        request,
      ),
    ).toMatchObject({ ok: false, receipt: { componentId: COMPONENT.id, projectId: PROJECT.id } });
    expect(request.mock.calls.at(-1)?.[0]).toBe(`component/${COMPONENT.id}`);
    expect(writes(request)).toHaveLength(1);
  });
});
