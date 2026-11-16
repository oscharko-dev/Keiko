import { describe, expect, it, vi } from "vitest";
import type {
  JiraMutationOperation,
  JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CanonicalToolId,
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpToolDeclaration,
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { response } from "../../../tests/support/jira-managed-remote.js";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import { createJiraManagedProvider, type JiraManagedConnection } from "./jira-managed-tools.js";
import { executeJiraManagedMutation, checkJiraManagedMutation } from "./jira-managed-mutations.js";

const CREATE = {
  key: "SYN_2",
  name: "Synthetic project",
  lead: "owner",
  projectTypeKey: "software",
};
const PROJECT = {
  id: "10010",
  key: CREATE.key,
  name: CREATE.name,
  lead: { name: CREATE.lead },
  projectTypeKey: "software",
  description: "Before",
  url: "https://example.invalid",
  assigneeType: "PROJECT_LEAD",
};
const CONTEXT = {
  invocationId: "project-call",
  correlationId: "project-call",
  signal: new AbortController().signal,
  beforeEffect: (): boolean => true,
};
function declaration(name: string): ManagedMcpToolDeclaration {
  return {
    name,
    risk: "read",
    descriptor: {
      toolRef: { canonicalId: `fixture.${name}` as CanonicalToolId, contractVersion: 1 },
      descriptorDigest: "a".repeat(64) as CatalogDigest,
      description: "Project operation fixture",
      inputSchema: { type: "object" },
      resultSchema: { type: "object" },
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: 8192,
        maxResultBytes: 262144,
        maxResultCount: 100,
        maxDurationMs: 15000,
      },
      idempotency: "read-only",
      cancellation: "before-effect",
    },
  };
}
interface ProjectFixture {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly connection: JiraManagedConnection;
  readonly mutate: (
    operation: JiraMutationOperation,
    args: CatalogJsonObject,
    context?: ManagedMcpInvocationContext,
  ) => Promise<JiraMutationAttempt>;
  readonly read: (name: string, args: CatalogJsonObject) => Promise<ManagedMcpToolResult>;
}
function fixtureRead(path: string, project: typeof PROJECT): AtlassianHttpBodyResult {
  if (path === "myself") return response({ name: "connected.user" });
  if (path === `user?username=${CREATE.lead}`) return response({ name: CREATE.lead });
  if (path.startsWith("projectvalidate/key?")) return response({ errors: {}, errorMessages: [] });
  if (path === "project/type/software/accessible")
    return response({ key: "software", formattedKey: "Software", icon: "omit-me" });
  if (path.startsWith("mypermissions"))
    return response({
      permissions: {
        ADMINISTER: {
          key: "ADMINISTER",
          name: "Administer",
          havePermission: true,
          description: "omit-me",
        },
      },
    });
  if (path === `project/${CREATE.key}` || path === "project/10010")
    return response({ ...project, self: "https://untrusted.invalid/project/10010" });
  return response({}, 404);
}
function fixture(
  override?: (
    path: string,
    method: string,
    written: boolean,
  ) => AtlassianHttpBodyResult | undefined,
): ProjectFixture {
  let project = structuredClone(PROJECT);
  let written = false;
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace("/context/rest/api/2/", "") + url.search;
    const altered = override?.(path, request.method, written);
    if (altered !== undefined) return Promise.resolve(altered);
    if (request.method !== "GET") {
      written = true;
      const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
      project = {
        ...project,
        ...body,
        lead: { name: typeof body.lead === "string" ? body.lead : project.lead.name },
      };
      return Promise.resolve(
        request.method === "POST"
          ? response({ id: 10010, key: project.key }, 201)
          : response(project),
      );
    }
    return Promise.resolve(fixtureRead(path, project));
  });
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return {
    http,
    connection,
    mutate: (
      operation: JiraMutationOperation,
      args: CatalogJsonObject,
      context = CONTEXT,
    ): Promise<JiraMutationAttempt> =>
      executeJiraManagedMutation(operation, args, context, connection),
    read: async (name: string, args: CatalogJsonObject): Promise<ManagedMcpToolResult> => {
      const provider = createJiraManagedProvider({
        declarations: [declaration(name)],
        connection: () => connection,
      });
      const tool = provider.tools()[0];
      if (tool === undefined) throw new Error("expected project tool");
      return tool.execute(args, CONTEXT);
    },
  };
}

describe("native Jira project reads", () => {
  it("retains project identity while counting unusable optional metadata without exposing it", async () => {
    const h = fixture(() =>
      response({
        ...PROJECT,
        description: { private: "invalid-description" },
        url: "invalid-url",
        lead: { displayName: "invalid-lead" },
        assigneeType: "invalid-assignee",
        projectTypeKey: "invalid type",
      }),
    );
    const result = await h.read("jira.project", { projectIdOrKey: CREATE.key });
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      projectId: PROJECT.id,
      projectKey: PROJECT.key,
      projectName: PROJECT.name,
      omittedMetadataCount: 5,
    });
    for (const field of [
      "description",
      "url",
      "lead",
      "assigneeType",
      "projectTypeKey",
      "invalidMetadataFields",
    ])
      expect(result.data).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toContain("invalid-");
  });

  it("treats explicit null descriptions and URLs as empty metadata rather than malformed data", async () => {
    const h = fixture(() => response({ ...PROJECT, description: null, url: null }));
    const result = await h.read("jira.project", { projectIdOrKey: CREATE.key });
    expect(result.data.outcome).toBe("succeeded");
    expect(result.data).not.toHaveProperty("description");
    expect(result.data).not.toHaveProperty("url");
    expect(result.data).not.toHaveProperty("omittedMetadataCount");
  });
  it("reads the exact project with a bound project link and no remote self URL", async () => {
    const result = await fixture().read("jira.project", { projectIdOrKey: CREATE.key });
    expect(result).toMatchObject({
      data: {
        outcome: "succeeded",
        projectId: "10010",
        projectKey: CREATE.key,
        projectName: CREATE.name,
        lead: "owner",
        browseUrl: `https://jira.example.invalid/context/projects/${CREATE.key}/summary`,
      },
    });
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });
  it("uses Jira's native key policy and represents a validation refusal", async () => {
    const h = fixture((path) =>
      path.startsWith("projectvalidate/")
        ? response({ errors: { projectKey: "Already used" }, errorMessages: [] })
        : undefined,
    );
    expect(await h.read("jira.validate-project-key", { key: CREATE.key })).toMatchObject({
      data: {
        outcome: "succeeded",
        key: CREATE.key,
        valid: false,
        fieldErrors: [{ fieldId: "projectKey", message: "Already used" }],
      },
    });
    expect(h.http.mock.calls[0]?.[0].url).toContain(`projectvalidate/key?key=${CREATE.key}`);
  });
  it("reads explicit permission booleans with a numeric project context", async () => {
    const h = fixture();
    expect(await h.read("jira.project-permissions", { projectIdOrKey: "10010" })).toEqual({
      data: {
        outcome: "succeeded",
        permissions: [{ key: "ADMINISTER", name: "Administer", havePermission: true }],
      },
    });
    expect(h.http.mock.calls[0]?.[0].url).toContain("mypermissions?projectId=10010");
  });
  it("refuses permission entries without an actual permission boolean", async () => {
    const h = fixture((path) =>
      path.startsWith("mypermissions")
        ? response({ permissions: { ADMINISTER: { name: "Administer" } } })
        : undefined,
    );
    expect(await h.read("jira.project-permissions", {})).toMatchObject({
      isError: true,
      data: { reason: "malformed-payload" },
    });
  });
  it("refuses excessive permission entries rather than truncating or inventing denials", async () => {
    const permissions = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`P${String(index)}`, { havePermission: false }]),
    );
    const h = fixture((path) =>
      path.startsWith("mypermissions") ? response({ permissions }) : undefined,
    );
    expect(await h.read("jira.project-permissions", {})).toMatchObject({
      isError: true,
      data: { reason: "bounds-exceeded" },
    });
  });
  it.each([
    ["jira.project", { projectIdOrKey: "../escape" }],
    ["jira.project", { projectIdOrKey: CREATE.key, path: "other" }],
    ["jira.project-type", { projectTypeKey: "software?other=yes" }],
    ["jira.project-permissions", { issueKey: "SYN-1" }],
  ] as const)("refuses arbitrary selectors for %s before HTTP", async (name, args) => {
    const h = fixture();
    expect(await h.read(name, args)).toMatchObject({
      isError: true,
      data: { reason: "invalid-input" },
    });
    expect(h.http).not.toHaveBeenCalled();
  });
  it("returns only the requested accessible project type", async () => {
    expect(await fixture().read("jira.project-type", { projectTypeKey: "software" })).toEqual({
      data: { outcome: "succeeded", projectTypeKey: "software", name: "Software" },
    });
    const wrong = fixture((path) =>
      path.includes("/accessible") ? response({ key: "business" }) : undefined,
    );
    expect(await wrong.read("jira.project-type", { projectTypeKey: "software" })).toMatchObject({
      isError: true,
      data: { reason: "malformed-payload" },
    });
  });
});

describe("native Jira project writes", () => {
  const { lead: _lead, ...WITHOUT_LEAD } = CREATE;
  const posted = (h: ProjectFixture): Record<string, unknown> => {
    const post = h.http.mock.calls.map(([request]) => request).find((r) => r.method === "POST");
    return JSON.parse(post?.bodyJson ?? "{}") as Record<string, unknown>;
  };
  it("makes the connected Jira user the lead when the create omits it", async () => {
    const h = fixture();
    expect(await h.mutate("jira.create-project", WITHOUT_LEAD)).toMatchObject({
      ok: true,
      receipt: { projectId: PROJECT.id },
    });
    expect(posted(h).lead).toBe("connected.user");
  });
  it("settles the lead before review, so a check names no unknown user", async () => {
    const h = fixture((path) => (path === "myself" ? response({ name: "someone" }) : undefined));
    const checked = await checkJiraManagedMutation(
      "jira.create-project",
      WITHOUT_LEAD,
      CONTEXT,
      h.connection,
    );
    expect(checked).toMatchObject({ ok: true });
    expect(h.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it("refuses a named lead that is not a Jira user with a field error and writes nothing", async () => {
    const h = fixture((path) =>
      path.startsWith("user?") ? response({ errorMessages: ["gone"] }, 404) : undefined,
    );
    expect(await h.mutate("jira.create-project", { ...CREATE, lead: "ghost" })).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldErrors: [{ fieldId: "lead" }] },
    });
    expect(h.http.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
  });
  it.each([
    ["a non-string lead", { ...CREATE, lead: 7 }],
    ["an over-long lead", { ...CREATE, lead: "x".repeat(129) }],
  ])("refuses %s before any HTTP", async (_name, args) => {
    const h = fixture();
    expect(
      await h.mutate("jira.create-project", args as unknown as CatalogJsonObject),
    ).toMatchObject({
      ok: false,
    });
    expect(h.http).not.toHaveBeenCalled();
  });
  it.each([
    ["the connected user", WITHOUT_LEAD, "myself"],
    ["a named lead", CREATE, "user?"],
  ] as const)(
    "reports a failed lookup of %s as a Jira failure, never as an unknown user (#4335)",
    async (_name, args, path) => {
      const h = fixture((requested) =>
        requested.startsWith(path) ? response({ errorMessages: ["down"] }, 500) : undefined,
      );
      const result = await h.mutate("jira.create-project", args);
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain("No Jira user has this user name");
      expect(h.http.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
    },
  );
  it.each([
    ["the connected user is not found", WITHOUT_LEAD, "myself", response({}, 404)],
    ["the connected user lookup is forbidden", WITHOUT_LEAD, "myself", response({}, 403)],
    ["the connected user lookup times out", WITHOUT_LEAD, "myself", { kind: "timeout" }],
    ["the named lead lookup times out", CREATE, "user?", { kind: "timeout" }],
    ["the named lead lookup fails on the network", CREATE, "user?", { kind: "network-error" }],
  ] as const)(
    "never reports an unknown user when %s (#4335)",
    async (_name, args, path, answer: AtlassianHttpBodyResult) => {
      const h = fixture((requested) => (requested.startsWith(path) ? answer : undefined));
      const result = await h.mutate("jira.create-project", args);
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toMatchObject({ reason: "field-validation" });
      expect(h.http.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
    },
  );
  it.each([
    ["without a name", response({ displayName: "Someone" })],
    ["with a different user's name", response({ name: "someone.else" })],
  ])("refuses a named-lead answer %s instead of accepting it (#4335)", async (_name, answer) => {
    const h = fixture((path) => (path.startsWith("user?") ? answer : undefined));
    const result = await h.mutate("jira.create-project", CREATE);
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toMatchObject({ reason: "field-validation" });
    expect(h.http.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
  });
  it("keeps Jira's spelling of a named lead that differs only by case", async () => {
    const h = fixture((path) =>
      path.startsWith("user?") ? response({ name: CREATE.lead.toUpperCase() }) : undefined,
    );
    expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({ ok: true });
    expect(posted(h).lead).toBe(CREATE.lead.toUpperCase());
  });
  it("refuses a connected-user answer without a usable name instead of guessing a lead", async () => {
    const h = fixture((path) => (path === "myself" ? response({ name: "bad\nname" }) : undefined));
    expect(await h.mutate("jira.create-project", WITHOUT_LEAD)).toMatchObject({ ok: false });
    expect(h.http.mock.calls.some(([request]) => request.method === "POST")).toBe(false);
  });
  it("confirms the native case-insensitive lead identity after creation", async () => {
    const h = fixture((path, method, written) =>
      method === "GET" && written && path.startsWith("project/")
        ? response({ ...PROJECT, lead: { name: CREATE.lead.toUpperCase() } })
        : undefined,
    );
    expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({
      ok: true,
      receipt: { projectId: PROJECT.id },
    });
  });

  it("does not PUT a lead that differs only by case", async () => {
    const h = fixture();
    expect(
      await h.mutate("jira.update-project", {
        projectIdOrKey: CREATE.key,
        lead: CREATE.lead.toUpperCase(),
      }),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  });

  it.each([null, undefined])(
    "confirms explicitly cleared fields when native readback returns %s",
    async (empty) => {
      const h = fixture((path, method, written) =>
        method === "GET" && written && path.startsWith("project/")
          ? response({ ...PROJECT, description: empty, url: empty })
          : undefined,
      );
      expect(
        await h.mutate("jira.update-project", {
          projectIdOrKey: CREATE.key,
          description: "",
          url: "",
        }),
      ).toMatchObject({ ok: true, receipt: { projectId: PROJECT.id } });
      expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PUT", "GET"]);
    },
  );

  it.each([
    ["description", { unexpected: "private-readback" }],
    ["url", "invalid-private-readback"],
  ] as const)(
    "never confirms a clear from stripped malformed %s metadata",
    async (field, value) => {
      const h = fixture((path, method, written) =>
        method === "GET" && written && path.startsWith("project/")
          ? response({ ...PROJECT, [field]: value })
          : undefined,
      );
      expect(
        await h.mutate("jira.update-project", { projectIdOrKey: CREATE.key, [field]: "" }),
      ).toMatchObject({ ok: false, reason: "conflict", receipt: { projectId: PROJECT.id } });
      expect(h.http.mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
    },
  );

  it("confirms an unrelated metadata update despite an unreadable optional website", async () => {
    const h = fixture((path, method, written) =>
      method === "GET" && path.startsWith("project/")
        ? response({ ...PROJECT, name: written ? "Renamed" : PROJECT.name, url: "invalid-url" })
        : undefined,
    );
    expect(
      await h.mutate("jira.update-project", { projectIdOrKey: CREATE.key, name: "Renamed" }),
    ).toMatchObject({ ok: true, receipt: { projectName: "Renamed" } });
  });
  it("creates once, validates key/type and independently reads the returned numeric identity", async () => {
    const h = fixture();
    expect(await h.mutate("jira.create-project", CREATE)).toEqual({
      ok: true,
      receipt: { projectId: "10010", projectKey: CREATE.key, projectName: CREATE.name },
    });
    // The named lead is looked up first, so an approval never shows a lead Jira would refuse.
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    expect(h.http.mock.calls[0]?.[0].url).toContain(`user?username=${CREATE.lead}`);
    expect(h.http.mock.calls.at(-1)?.[0].url).toBe(
      "https://jira.example.invalid/context/rest/api/2/project/10010",
    );
    expect(JSON.parse(h.http.mock.calls[3]?.[0].bodyJson ?? "{}")).toEqual(CREATE);
  });
  it("relays an explicit native creation template selector and independently confirms readable project fields", async () => {
    const h = fixture();
    const args = {
      ...CREATE,
      projectTemplateKey: "com.atlassian.jira-core-project-templates:jira-core-project-management",
    };
    expect(await h.mutate("jira.create-project", args)).toEqual({
      ok: true,
      receipt: { projectId: "10010", projectKey: CREATE.key, projectName: CREATE.name },
    });
    const write = h.http.mock.calls.find(([request]) => request.method === "POST")?.[0];
    expect(JSON.parse(write?.bodyJson ?? "{}")).toEqual(args);
    expect(h.http.mock.calls.at(-1)?.[0].method).toBe("GET");
    expect(h.http.mock.calls.at(-1)?.[0].url).toContain("/project/10010");
  });
  it("mints the project receipt link through the existing managed provider after the governed executor", async () => {
    const h = fixture();
    const provider = createJiraManagedProvider({
      connection: () => h.connection,
      declarations: [{ ...declaration("jira.create-project"), risk: "write" }],
      executeMutation: async (
        _operation,
        _args,
        _context,
        execute,
      ): Promise<ManagedMcpToolResult> => {
        const result = await execute(h.http);
        return {
          data: {
            outcome: result.ok ? "succeeded" : "unknown",
            ...result.receipt,
            browseUrl: "https://untrusted.invalid/project",
          },
        };
      },
    });
    const tool = provider.tools()[0];
    if (tool === undefined) throw new Error("expected governed project write");
    expect(await tool.execute(CREATE, CONTEXT)).toMatchObject({
      data: {
        outcome: "succeeded",
        projectId: "10010",
        browseUrl: `https://jira.example.invalid/context/projects/${CREATE.key}/summary`,
      },
    });
    expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("performs the same read-only project preflight before approval", async () => {
    const h = fixture();
    expect(
      await checkJiraManagedMutation("jira.create-project", CREATE, CONTEXT, h.connection),
    ).toEqual({ ok: true });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "GET", "GET"]);
  });
  it("refuses an already-held update without issuing PUT", async () => {
    const h = fixture();
    expect(
      await h.mutate("jira.update-project", { projectIdOrKey: CREATE.key, name: CREATE.name }),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  });
  it("updates only requested fields and confirms them in a separate GET", async () => {
    const h = fixture();
    expect(
      await h.mutate("jira.update-project", {
        projectIdOrKey: CREATE.key,
        name: "Renamed",
        description: "New description",
      }),
    ).toEqual({
      ok: true,
      receipt: { projectId: "10010", projectKey: CREATE.key, projectName: "Renamed" },
    });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PUT", "GET"]);
    expect(JSON.parse(h.http.mock.calls[1]?.[0].bodyJson ?? "{}")).toEqual({
      name: "Renamed",
      description: "New description",
    });
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0, 1.5, "10010"])(
    "does not trust a malformed or imprecise 201 ID %j",
    async (id) => {
      const h = fixture((_path, method) =>
        method === "POST" ? response({ id, key: CREATE.key }, 201) : undefined,
      );
      expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({
        ok: false,
        reason: "malformed-payload",
      });
      expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
      expect(
        h.http.mock.calls.some(
          ([request]) => request.url.endsWith(`/project/${String(id)}`) && String(id) !== "10010",
        ),
      ).toBe(false);
    },
  );
  it("retains a validated partial project receipt for 409 without replay or success", async () => {
    const h = fixture((_path, method) =>
      method === "POST"
        ? response({ errorMessages: ["Workflow scheme assignment failed"] }, 409)
        : undefined,
    );
    expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({
      ok: false,
      reason: "conflict",
      receipt: { projectId: "10010", projectKey: CREATE.key },
    });
    expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    expect(h.http.mock.calls.at(-1)?.[0].url).toContain(`project/${CREATE.key}`);
  });
  it("reads an uncertain update independently while retaining conflict and refusing replay", async () => {
    const h = fixture((_path, method) => (method === "PUT" ? response({}, 409) : undefined));
    expect(
      await h.mutate("jira.update-project", { projectIdOrKey: CREATE.key, name: "Requested" }),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      receipt: { projectId: "10010", projectKey: CREATE.key },
    });
    expect(h.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PUT", "GET"]);
  });
  it("keeps the created identity when readback cannot confirm requested fields", async () => {
    const h = fixture((path, method, written) =>
      method === "GET" && written && path.startsWith("project/")
        ? response({ ...PROJECT, name: "Another name" })
        : undefined,
    );
    expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({
      ok: false,
      reason: "conflict",
      receipt: { projectId: "10010", projectKey: CREATE.key },
    });
    expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("does not infer confirmation from missing requested lead metadata", async () => {
    const h = fixture((path, method, written) =>
      method === "GET" && written && path.startsWith("project/")
        ? response({ id: "10010", key: CREATE.key, name: CREATE.name, projectTypeKey: "software" })
        : undefined,
    );
    expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
  });
  it("preserves authentication failure after a create without replay", async () => {
    const h = fixture((path, method, written) =>
      method === "GET" && written && path.startsWith("project/") ? response({}, 401) : undefined,
    );
    expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({
      ok: false,
      reason: "auth-failed",
      receipt: { projectId: "10010", projectKey: CREATE.key },
    });
    expect(h.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it.each([
    ["jira.create-project", { ...CREATE, workflowSchemeId: 7 }],
    ["jira.create-project", { ...CREATE, name: " Project " }],
    ["jira.update-project", { projectIdOrKey: CREATE.key, name: " Project " }],
    ["jira.create-project", { ...CREATE, key: "../escape" }],
    ["jira.create-project", { ...CREATE, url: "https://user:secret@example.invalid" }],
    ["jira.update-project", { projectIdOrKey: CREATE.key }],
    ["jira.update-project", { projectIdOrKey: CREATE.key, key: "NEW" }],
  ] as const)("refuses unsupported arguments for %s before HTTP", async (operation, args) => {
    const h = fixture();
    expect(await h.mutate(operation, args)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(h.http).not.toHaveBeenCalled();
  });
  it("refuses an inaccessible type and an invalid native key before dispatch", async () => {
    for (const refusal of ["type", "key"]) {
      const h = fixture((path) =>
        refusal === "type" && path.includes("/accessible")
          ? response({}, 404)
          : refusal === "key" && path.startsWith("projectvalidate/")
            ? response({ errors: { projectKey: "Invalid" } })
            : undefined,
      );
      expect(await h.mutate("jira.create-project", CREATE)).toMatchObject({ ok: false });
      expect(h.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    }
  });
  it("does not write when scope is revoked or the caller already cancelled", async () => {
    const h = fixture();
    expect(
      await h.mutate("jira.create-project", CREATE, { ...CONTEXT, beforeEffect: () => false }),
    ).toMatchObject({ ok: false });
    expect(
      await h.mutate("jira.create-project", CREATE, { ...CONTEXT, signal: AbortSignal.abort() }),
    ).toMatchObject({ ok: false });
    expect(h.http).not.toHaveBeenCalled();
  });
});
