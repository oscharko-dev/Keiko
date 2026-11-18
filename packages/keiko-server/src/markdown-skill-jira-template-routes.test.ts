import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  jiraTemplateBindingDigest,
  parseJiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_TEMPLATE_WITHOUT_PROPOSAL_LISTED_MAX,
  jiraInstanceIdentity,
  type AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { handleImportMarkdownSkill, handleReplaceMarkdownSkill } from "./markdown-skill-routes.js";
import {
  handleBindJiraTemplate,
  handleJiraTemplateOptions,
  handleListJiraTemplates,
  handleProposeJiraTemplates,
  handleValidateJiraTemplate,
} from "./markdown-skill-jira-template-routes.js";
import { API_ROUTES, matchRoute, type RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { UiStore } from "./store/types.js";
import { REQUIRED_CUSTOM, field, response } from "../../../tests/support/jira-managed-remote.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const PRINCIPAL = "operator-principal";
type RouteDeps = Parameters<typeof handleListJiraTemplates>[1];
const stores: UiStore[] = [];
const TEMPLATE = [
  "---",
  "keiko: jira-issue-template",
  "version: 1",
  "project: SYN",
  "issueType: Story",
  "activateOn: [create, transition:Ready]",
  "requiredFields: [Story Points, Unknown Thing]",
  "parentLink: relates to",
  "---",
  "# Story template",
  "## Context",
].join("\n");

function upload(
  text: string,
  fileName = "template.md",
): { fileName: string; contentBase64: string } {
  return { fileName, contentBase64: Buffer.from(text).toString("base64") };
}

const BASE_URL = "https://jira.example.invalid/context";
const PROJECT_TYPES = [
  { id: "10001", name: "Story" },
  { id: "10002", name: "Bug" },
];
function jiraGet(
  request: { readonly url: string },
  projectTypes: readonly { id: string; name: string }[] = PROJECT_TYPES,
): ReturnType<AtlassianHttpBodyPort> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.endsWith("/project"))
    return Promise.resolve(response([{ id: "10000", key: "SYN", name: "Synthetic project" }]));
  if (path.endsWith("/project/SYN"))
    return Promise.resolve(response({ id: "10000", key: "SYN", issueTypes: projectTypes }));
  if (path.endsWith("/project/SYN/statuses"))
    return Promise.resolve(
      response([
        {
          id: "10001",
          name: "Story",
          statuses: [
            { id: "1", name: "To Do" },
            { id: "6", name: "Done" },
          ],
        },
      ]),
    );
  if (path.endsWith("/field"))
    return Promise.resolve(
      response([
        { id: "customfield_10016", name: "Story Points" },
        { id: "parent", name: "Parent" },
      ]),
    );
  if (path.endsWith("/issuetype"))
    return Promise.resolve(
      response([
        { id: "10001", name: "Story" },
        { id: "7", name: "Task" },
      ]),
    );
  if (path.endsWith("/issueLinkType"))
    return Promise.resolve(
      response({
        issueLinkTypes: [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }],
      }),
    );
  if (path.endsWith("/search"))
    return Promise.resolve(
      response({
        issues: [
          // Search returns native Data Center wiki, not an explicitly tagged Markdown input.
          { fields: { description: "h2. Context\nA\nh2. Acceptance criteria\nB" } },
          { fields: { description: "h2. Context\nC\nh2. Acceptance criteria\nD" } },
          { fields: { description: "free text" } },
        ],
      }),
    );
  if (path.includes("createmeta"))
    return Promise.resolve(
      response({
        values: [
          field("project", "project", true),
          field("issuetype", "issuetype", true),
          field("summary", "string", true),
          {
            ...field("customfield_10016", "number", true),
            name: "Story Points",
            schema: {
              type: "number",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
            },
          },
        ],
        start: 0,
        size: 4,
        last: true,
        total: 4,
      }),
    );
  return Promise.resolve(response({}, 404));
}

function fixture(
  options: { pod?: boolean; projectTypes?: readonly { id: string; name: string }[] } = {},
): {
  deps: RouteDeps;
  cookie: string;
  http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
} {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("Pairing fixture failed");
  const store = createInMemoryUiStore();
  stores.push(store);
  const http = vi.fn<AtlassianHttpBodyPort>((request) => jiraGet(request, options.projectTypes));
  const metadata = {
    schemaVersion: "1",
    authRef: "synthetic-credential",
    displayName: "Synthetic Jira",
    baseUrl: BASE_URL,
    createdAt: 1,
    generation: 1,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest: createHash("sha256").update(PRINCIPAL).digest("hex"),
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
  return {
    http,
    deps: {
      store,
      codingAppSessionChannel: channel,
      serverPrincipal: () => PRINCIPAL,
      atlassianConnectorCredentials:
        options.pod === false
          ? undefined
          : ({
              custody: { list: () => [metadata] },
              httpBodyPortFactory: () => http,
            } as never),
    },
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
  };
}

function context(cookie: string, body: unknown = {}, id = ""): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.headers.cookie = cookie;
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(body));
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: { id },
    url: new URL("http://localhost/api/skills/jira-templates"),
    correlationId: "template-routes",
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  resetServerLogger();
});

describe("guided Jira template options", () => {
  it("records option counts under the request correlation", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie } = fixture();

    expect((await handleJiraTemplateOptions(context(cookie, { podId: POD }), deps)).status).toBe(
      200,
    );
    const events = sink.events.filter(
      (event) =>
        event.op === "skills.library.operation" && event.extra?.action === "jira-template-options",
    );
    expect(events.map((event) => event.extra?.phase)).toEqual(["started", "completed"]);
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      correlationId: "template-routes",
      extra: { httpStatus: 200, projectCount: 1 },
    });
    const line = formatActivityLogProofLine(completed ?? {});
    expectActivityLogProof("skills.library.operation.lifecycle", line);
    expect(line).not.toMatch(/Synthetic project|example\.invalid|\bSYN\b/u);
  });

  it("returns project, localized types, and scoped field and status choices via read-only requests", async () => {
    const { deps, cookie, http } = fixture({
      projectTypes: [
        { id: "10001", name: "Aufgabe" },
        { id: "10002", name: "Fachliche Aufgabe" },
      ],
    });
    const read = async (selection: object): Promise<unknown> => {
      const result = await handleJiraTemplateOptions(
        context(cookie, { podId: POD, ...selection }),
        deps,
      );
      expect(result.status).toBe(200);
      expect(result.headers).toMatchObject({ "Cache-Control": "no-store" });
      return result.body;
    };
    expect(await read({})).toEqual({
      kind: "projects",
      projects: [{ key: "SYN", name: "Synthetic project" }],
    });
    expect(await read({ projectKey: "SYN" })).toEqual({
      kind: "types",
      instanceId: jiraInstanceIdentity(BASE_URL),
      issueTypes: [
        { id: "10001", name: "Aufgabe" },
        { id: "10002", name: "Fachliche Aufgabe" },
      ],
    });
    expect(await read({ projectKey: "SYN", issueTypeId: "10001" })).toEqual({
      kind: "details",
      fields: [
        { id: "summary", name: "summary", required: true },
        { id: "customfield_10016", name: "Story Points", required: true },
      ],
      statuses: [
        { id: "1", name: "To Do" },
        { id: "6", name: "Done" },
      ],
    });
    expect(http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    expect(deps.store.markdownSkills.list()).toEqual([]);
  });

  it("refuses an unknown Pod and never loads fields for a type outside the project", async () => {
    const { deps, cookie, http } = fixture();
    expect((await handleJiraTemplateOptions(context("", { podId: POD }), deps)).status).toBe(404);
    expect(
      (await handleJiraTemplateOptions(context(cookie, { podId: "other" }), deps)).status,
    ).toBe(404);
    expect(http).not.toHaveBeenCalled();
    const result = await handleJiraTemplateOptions(
      context(cookie, { podId: POD, projectKey: "SYN", issueTypeId: "10099" }),
      deps,
    );
    expect(result.status).toBe(404);
    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0]?.[0].url).toMatch(/\/project\/SYN$/u);
  });

  it.each([
    ["a path in the project key", { projectKey: "../SYN" }],
    ["a slash in the project key", { projectKey: "SYN/1" }],
    ["an empty project key", { projectKey: "" }],
    ["a key starting with a digit", { projectKey: "1SYN" }],
    ["an over-long project key", { projectKey: `S${"Y".repeat(128)}` }],
    ["a project key that is no string", { projectKey: 7 }],
    ["an issue type without a project", { issueTypeId: "10001" }],
    ["an issue type id of zero", { projectKey: "SYN", issueTypeId: "0" }],
    ["an issue type id with letters", { projectKey: "SYN", issueTypeId: "1a" }],
    ["an over-long issue type id", { projectKey: "SYN", issueTypeId: "1".repeat(20) }],
    ["an issue type id that is no string", { projectKey: "SYN", issueTypeId: 10001 }],
  ])("refuses %s before Jira is asked", async (_case, selection) => {
    const { deps, cookie, http } = fixture();
    const result = await handleJiraTemplateOptions(
      context(cookie, { podId: POD, ...selection }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("template documents in the skill library", () => {
  it("preserves and validates the uploaded parent-type clause through the normal skill owner", async () => {
    const { deps, cookie, http } = fixture();
    const markdown = [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      "parentField: parent",
      "parentIssueTypes: [Task]",
      "---",
      "# Parent rule",
    ].join("\n");
    expect((await handleImportMarkdownSkill(context(cookie, upload(markdown)), deps)).status).toBe(
      201,
    );
    const saved = deps.store.markdownSkills.list()[0];
    if (saved === undefined) throw new TypeError("The uploaded skill must be persisted");
    const stored = deps.store.markdownSkills.get(saved.id);
    expect(stored?.body).toBe(markdown);
    expect(deps.store.markdownSkills.jiraTemplates()[0]?.template?.parent).toEqual({
      field: "parent",
      issueTypes: ["Task"],
    });
    const result = await handleValidateJiraTemplate(
      context(cookie, { podId: POD, markdown: stored?.body }),
      deps,
    );
    expect(result.body).toMatchObject({ valid: true, findings: [] });
    expect(
      http.mock.calls.some(([request]) => new URL(request.url).pathname.endsWith("/issuetype")),
    ).toBe(true);
    expect(http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  // F07a (#4354): two templates that govern writes of one type are told apart in the list.
  it("counts the other templates that govern the same project and issue type", async () => {
    const { deps, cookie } = fixture();
    const other = TEMPLATE.replace("# Story template", "# Second story template");
    const bug = TEMPLATE.replace("issueType: Story", "issueType: Bug");
    for (const [name, text] of [
      ["one.md", TEMPLATE],
      ["two.md", other],
      ["three.md", bug],
    ] as const)
      expect(
        (await handleImportMarkdownSkill(context(cookie, upload(text, name)), deps)).status,
      ).toBe(201);
    const listed = await handleListJiraTemplates(context(cookie), deps);
    const shared = (listed.body as { templates: { issueType: string; sharedWith: number }[] })
      .templates;
    expect(shared.map((entry) => [entry.issueType, entry.sharedWith]).sort()).toEqual([
      ["Bug", 0],
      ["Story", 1],
      ["Story", 1],
    ]);
  });

  it("imports a valid template as an ordinary private skill revision", async () => {
    const { deps, cookie } = fixture();
    const imported = await handleImportMarkdownSkill(context(cookie, upload(TEMPLATE)), deps);
    expect(imported.status).toBe(201);
    const listed = await handleListJiraTemplates(context(cookie), deps);
    const body = listed.body as { templates: { id: string }[] };
    expect(body.templates[0]?.id).toMatch(/^msk_/u);
    expect(body).toEqual({
      templates: [
        {
          id: body.templates[0]?.id,
          revision: 1,
          name: "Story template",
          valid: true,
          project: "SYN",
          issueType: "Story",
          activations: ["create", "transition:Ready"],
          sharedWith: 0,
        },
      ],
    });
  });

  it("refuses a malformed template with closed codes and never stores it", async () => {
    const { deps, cookie } = fixture();
    const bad = TEMPLATE.replace("activateOn: [create, transition:Ready]", "activateOn: [launch]");
    const result = await handleImportMarkdownSkill(context(cookie, upload(bad)), deps);
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("invalid-value (activateOn)");
    expect(deps.store.markdownSkills.list()).toEqual([]);
  });

  it("revalidates a replacement and lists only the current revision", async () => {
    const { deps, cookie } = fixture();
    const created = await handleImportMarkdownSkill(context(cookie, upload(TEMPLATE)), deps);
    const id = (created.body as { skill: { id: string } }).skill.id;
    const bad = await handleReplaceMarkdownSkill(
      context(
        cookie,
        { ...upload("---\nkeiko: jira-issue-template\n---\n"), expectedRevision: 1 },
        id,
      ),
      deps,
    );
    expect(bad.status).toBe(400);
    const good = await handleReplaceMarkdownSkill(
      context(cookie, { ...upload(TEMPLATE.replace("SYN", "ABC")), expectedRevision: 1 }, id),
      deps,
    );
    expect(good.status).toBe(200);
    const listed = (await handleListJiraTemplates(context(cookie), deps)).body as {
      templates: { project: string; revision: number }[];
    };
    expect(listed.templates).toMatchObject([{ project: "ABC", revision: 2 }]);
  });

  it("does not treat an ordinary skill that mentions the marker as a template", async () => {
    const { deps, cookie } = fixture();
    await handleImportMarkdownSkill(
      context(cookie, upload("# Method\nkeiko: jira-issue-template\n")),
      deps,
    );
    expect((await handleListJiraTemplates(context(cookie), deps)).body).toEqual({ templates: [] });
  });

  it("requires the app session", async () => {
    const { deps } = fixture();
    expect((await handleListJiraTemplates(context(""), deps)).status).toBe(404);
  });

  it("registers the literal routes ahead of the skill identity route", () => {
    expect(API_ROUTES.some((route) => route.pattern === "/api/skills/jira-templates")).toBe(true);
    const match = matchRoute("GET", "/api/skills/jira-templates");
    expect(match).not.toBe("method-not-allowed");
    expect(
      match === undefined || match === "method-not-allowed" ? "" : match.definition.pattern,
    ).toBe("/api/skills/jira-templates");
  });
});

// #4354 AC3: a template that names a project the connected Jira does not have (KERNBANK against the
// key KER, the owner's 2026-11-07 walk) is a finding the person sees, not a failure and not a pass.
describe("a template naming a project the Jira does not have", () => {
  const KERNBANK = TEMPLATE.replace("project: SYN", "project: KERNBANK").replace(
    "requiredFields: [Story Points, Unknown Thing]\n",
    "",
  );

  it("is a finding with the template's own key, and nothing about the project is claimed checked", async () => {
    const { deps, cookie, http } = fixture();
    const result = await handleValidateJiraTemplate(
      context(cookie, { markdown: KERNBANK, podId: POD }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ valid: true, checked: { project: false } });
    expect((result.body as { readonly findings: readonly unknown[] }).findings).toContainEqual({
      code: "unknown-project",
      subject: "KERNBANK",
    });
    expect(http.mock.calls.some(([request]) => request.url.endsWith("/project/KERNBANK"))).toBe(
      true,
    );
  });

  it("is not mistaken for a Jira that could not be read", async () => {
    const { deps, cookie, http } = fixture();
    http.mockImplementation((request) =>
      new URL(request.url).pathname.endsWith("/project/KERNBANK")
        ? Promise.resolve(response({}, 403))
        : jiraGet(request),
    );
    const result = await handleValidateJiraTemplate(
      context(cookie, { markdown: KERNBANK, podId: POD }),
      deps,
    );
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain("unknown-project");
  });
});

describe("validate against the live instance", () => {
  it("reports malformed Markdown without touching Jira", async () => {
    const { deps, cookie, http } = fixture();
    const result = await handleValidateJiraTemplate(
      context(cookie, { podId: POD, markdown: "# plain" }),
      deps,
    );
    expect(result).toMatchObject({
      status: 200,
      body: { valid: false, errors: [{ code: "not-a-template" }] },
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("reports unknown fields, link types and transition targets", async () => {
    const { deps, cookie, http } = fixture();
    const result = await handleValidateJiraTemplate(
      context(cookie, { podId: POD, markdown: TEMPLATE }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      valid: true,
      checked: { project: true, fields: true, linkTypes: true, transitions: true },
      findings: [
        { code: "unknown-field", subject: "Unknown Thing" },
        { code: "unknown-link-type", subject: "relates to" },
        { code: "unknown-transition-target", subject: "Ready" },
      ],
    });
    expect(http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("refuses an unknown or unavailable Pod and a missing body field", async () => {
    const { deps, cookie } = fixture();
    expect(
      (
        await handleValidateJiraTemplate(
          context(cookie, { podId: "nope", markdown: TEMPLATE }),
          deps,
        )
      ).status,
    ).toBe(404);
    expect((await handleValidateJiraTemplate(context(cookie, { podId: POD }), deps)).status).toBe(
      400,
    );
    const none = fixture({ pod: false });
    expect(
      (
        await handleValidateJiraTemplate(
          context(none.cookie, { podId: POD, markdown: TEMPLATE }),
          none.deps,
        )
      ).status,
    ).toBe(404);
  });
});

describe("propose from an existing project", () => {
  it("drafts a template that parses from create metadata and shared sections", async () => {
    const { deps, cookie } = fixture();
    const result = await handleProposeJiraTemplates(
      context(cookie, { podId: POD, projectKey: "SYN" }),
      deps,
    );
    expect(result.status).toBe(200);
    const proposals = (result.body as { proposals: { issueType: string; markdown: string }[] })
      .proposals;
    expect(proposals.map((proposal) => proposal.issueType)).toContain("Story");
    const story = proposals.find((proposal) => proposal.issueType === "Story");
    const parsed = parseJiraIssueTemplate(story?.markdown ?? "");
    expect(parsed.ok && parsed.template).toMatchObject({
      project: "SYN",
      requiredFields: ["Story Points"],
      requiredSections: ["Context", "Acceptance criteria"],
      activations: [{ kind: "create" }],
    });
  });

  it("rejects a malformed project key and an unknown project", async () => {
    const { deps, cookie } = fixture();
    expect(
      (await handleProposeJiraTemplates(context(cookie, { podId: POD, projectKey: "a b" }), deps))
        .status,
    ).toBe(400);
    expect(
      (await handleProposeJiraTemplates(context(cookie, { podId: POD, projectKey: "NOPE" }), deps))
        .status,
    ).toBe(404);
  });
});

// #4354: a template names its issue type by a typed string, and a name is localized per user. Binding
// resolves the names in the caller's own view and writes the ids into the template's front matter as
// a new skill revision, so the binding travels with an exported copy. Jira is only read.
describe("binding a template to this Jira", () => {
  const INSTANCE = jiraInstanceIdentity(BASE_URL);
  const FOREIGN = "fedcba9876543210fedcba9876543210";
  const typed = (type: string, ...extra: readonly string[]): string =>
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      `issueType: ${type}`,
      ...extra,
      "activateOn: [create]",
      "summaryMinLength: 4",
      "parentField: parent",
      "parentIssueTypes: [Task]",
      "---",
      `# ${type} template`,
    ].join("\n");
  async function stored(
    f: ReturnType<typeof fixture>,
    markdown: string,
  ): Promise<{ id: string; revision: number }> {
    expect(
      (await handleImportMarkdownSkill(context(f.cookie, upload(markdown)), f.deps)).status,
    ).toBe(201);
    const skill = f.deps.store.markdownSkills.list()[0];
    if (skill === undefined) throw new TypeError("The uploaded skill must be persisted");
    return skill;
  }
  const bind = (
    f: ReturnType<typeof fixture>,
    skill: { id: string; revision: number },
  ): ReturnType<typeof handleBindJiraTemplate> =>
    handleBindJiraTemplate(
      context(f.cookie, { podId: POD, skillId: skill.id, revision: skill.revision }),
      f.deps,
    );

  it("repairs the saved German Sub-task parent binding and records body-free validation evidence", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const projectTypes = [{ id: "10003", name: "Sub-task" }];
    const f = fixture({ projectTypes });
    let available = false;
    f.http.mockImplementation((request) => {
      if (!new URL(request.url).pathname.includes("createmeta"))
        return jiraGet(request, projectTypes);
      return Promise.resolve(
        available
          ? response({
              values: [{ ...field("parent", "issuelink", true), name: "Übergeordnet" }],
              startAt: 0,
              maxResults: 100,
              isLast: true,
              total: 1,
            })
          : response({}, 403),
      );
    });
    const skill = await stored(f, typed("Sub-task", "requiredFields: [Übergeordnet]"));
    expect((await bind(f, skill)).body).toMatchObject({ changed: true });
    const before = f.deps.store.markdownSkills.get(skill.id);
    expect(before?.body).toContain('requiredFieldIds: ["none"]');
    available = true;
    const checked = await handleValidateJiraTemplate(
      context(f.cookie, { podId: POD, markdown: before?.body }),
      f.deps,
    );
    expect(checked.body).toMatchObject({
      findings: [],
      checked: { fields: true },
      binding: { state: "bindable", binding: { requiredFieldIds: ["parent"] } },
    });
    expect((await bind(f, { id: skill.id, revision: 2 })).body).toMatchObject({ changed: true });
    expect(f.deps.store.markdownSkills.get(skill.id)?.body).toContain(
      'requiredFieldIds: ["parent"]',
    );
    expect((await bind(f, { id: skill.id, revision: 3 })).body).toMatchObject({ changed: false });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    const completed = sink.events.filter(
      (event) => event.op === "skills.library.operation" && event.extra?.phase === "completed",
    );
    const validation = completed.find((event) => event.extra?.action === "jira-template-validate");
    expect(validation?.extra).toMatchObject({
      checkedFieldCount: expect.any(Number) as unknown,
      validationFindingCount: 0,
    });
    const bindings = completed.filter((event) => event.extra?.action === "jira-template-bind");
    expect(bindings.map((event) => event.extra?.bindingUpdateCount)).toEqual([1, 1, 0]);
    for (const event of [validation, ...bindings]) {
      const line = formatActivityLogProofLine(event ?? {});
      expectActivityLogProof("skills.library.operation.lifecycle", line);
      expect(line).not.toMatch(/Übergeordnet|Sub-task|SYN|example/u);
    }
  });

  it("offers the ids, writes them as a new revision, and does it once", async () => {
    const f = fixture();
    const skill = await stored(f, typed("Story"));
    const checked = await handleValidateJiraTemplate(
      context(f.cookie, { podId: POD, markdown: f.deps.store.markdownSkills.get(skill.id)?.body }),
      f.deps,
    );
    expect(checked.body).toMatchObject({ binding: { state: "bindable", issueType: "Story" } });

    const result = await bind(f, skill);
    expect(result.body).toMatchObject({
      changed: true,
      issueType: "Story",
      parentTypeCount: 1,
      skill: { id: skill.id, revision: 2 },
    });
    const body = f.deps.store.markdownSkills.get(skill.id)?.body ?? "";
    expect(body).toContain('issueTypeId: "10001"');
    expect(body).toContain('parentIssueTypeIds: ["7"]');
    // The digest says what the ids were resolved from: this Jira and the typed names.
    const plain = parseJiraIssueTemplate(typed("Story"));
    if (!plain.ok) throw new TypeError("Expected a parseable template");
    const digest = jiraTemplateBindingDigest(INSTANCE, plain.template, {
      issueTypeId: "10001",
      parentIssueTypeIds: ["7"],
      parentFieldId: "parent",
    });
    expect(body).toContain(`jiraBinding: "${digest}"`);
    // Nothing else of the person's file moved, and the name stays the label.
    expect(
      body.replace(/^(?:issueTypeId|parentIssueTypeIds|parentFieldId|jiraBinding):.*\n/gmu, ""),
    ).toBe(typed("Story"));
    const template = parseJiraIssueTemplate(body);
    expect(template.ok && template.template.binding).toEqual({
      digest,
      issueTypeId: "10001",
      parentIssueTypeIds: ["7"],
      parentFieldId: "parent",
    });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);

    const again = await bind(f, { id: skill.id, revision: 2 });
    expect(again.body).toEqual({ changed: false, issueType: "Story" });
    expect(f.deps.store.markdownSkills.get(skill.id)?.revision).toBe(2);
  });

  it("ignores a binding made for another Jira and replaces it with this one's ids", async () => {
    const f = fixture();
    const skill = await stored(
      f,
      typed("Story", 'issueTypeId: "999"', `jiraBinding: "${FOREIGN}"`),
    );
    expect((await bind(f, skill)).body).toMatchObject({ changed: true, issueType: "Story" });
    const body = f.deps.store.markdownSkills.get(skill.id)?.body ?? "";
    expect(body).toContain('issueTypeId: "10001"');
    expect(body).not.toContain(FOREIGN);
    expect(body.match(/^issueTypeId:/gmu)).toHaveLength(1);
  });

  it.each([
    ["a name this Jira does not have in the person's language", "Aufgabe", undefined],
    [
      "a name that two types of this Jira share",
      "Story",
      [
        { id: "10001", name: "Story" },
        { id: "10003", name: "story" },
      ],
    ],
  ])(
    "refuses, in plain words naming the type, and keeps the template: %s",
    async (_name, type, projectTypes) => {
      const f = fixture(projectTypes === undefined ? {} : { projectTypes });
      const skill = await stored(f, typed(type));
      const before = f.deps.store.markdownSkills.get(skill.id)?.body;
      const refused = await bind(f, skill);
      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain(`\\"${type}\\"`);
      // The sentence names the template and both ways out.
      const sentence = JSON.stringify(refused.body);
      expect(sentence).toContain(`SYN/${type}`);
      expect(sentence).toContain("as this Jira shows it to you");
      expect(sentence).toContain("check it against Jira");
      expect(f.deps.store.markdownSkills.get(skill.id)?.body).toBe(before);
      expect(f.deps.store.markdownSkills.get(skill.id)?.revision).toBe(1);
    },
  );

  // B1: a binding is in force only for the typed names it was resolved from.
  it("resolves the binding again when the typed issue type was edited after it was bound", async () => {
    const f = fixture({
      projectTypes: [
        { id: "10001", name: "Story" },
        { id: "10005", name: "Bug" },
      ],
    });
    const skill = await stored(f, typed("Story"));
    expect((await bind(f, skill)).body).toMatchObject({ changed: true, issueType: "Story" });
    const bound = f.deps.store.markdownSkills.get(skill.id);
    // The lead changes the typed value; the old id and digest stay in the file.
    const edited = (bound?.body ?? "").replace("issueType: Story", "issueType: Bug");
    const replaced = f.deps.store.markdownSkills.replace(skill.id, 2, {
      fileName: "template.md",
      contentBase64: Buffer.from(edited, "utf8").toString("base64"),
    });
    const checked = await handleValidateJiraTemplate(
      context(f.cookie, { podId: POD, markdown: replaced.body }),
      f.deps,
    );
    expect(checked.body).toMatchObject({ binding: { state: "bindable", issueType: "Bug" } });
    expect((await bind(f, { id: skill.id, revision: replaced.revision })).body).toMatchObject({
      changed: true,
      issueType: "Bug",
    });
    const after = f.deps.store.markdownSkills.get(skill.id)?.body ?? "";
    expect(after).toContain('issueTypeId: "10005"');
    expect(after.match(/^issueTypeId:/gmu)).toHaveLength(1);
  });

  // B2 (a): bound for this Jira, but the bound type no longer exists: dead, and said so.
  it("reports a template bound to a type that is gone as dead, and writes nothing", async () => {
    const f = fixture();
    const plain = parseJiraIssueTemplate(typed("Aufgabe"));
    if (!plain.ok) throw new TypeError("Expected a parseable template");
    const digest = jiraTemplateBindingDigest(INSTANCE, plain.template, {
      issueTypeId: "99999",
      parentIssueTypeIds: ["7"],
      parentFieldId: "parent",
    });
    const skill = await stored(
      f,
      typed(
        "Aufgabe",
        'issueTypeId: "99999"',
        'parentIssueTypeIds: ["7"]',
        'parentFieldId: "parent"',
        `jiraBinding: "${digest}"`,
      ),
    );
    const checked = await handleValidateJiraTemplate(
      context(f.cookie, { podId: POD, markdown: f.deps.store.markdownSkills.get(skill.id)?.body }),
      f.deps,
    );
    expect(checked.body).toMatchObject({ binding: { state: "dead", subject: "Aufgabe" } });
    expect((await bind(f, skill)).body).toEqual({
      changed: false,
      dead: true,
      issueType: "Aufgabe",
    });
    expect(f.deps.store.markdownSkills.get(skill.id)?.revision).toBe(1);
  });

  it("refuses a stale revision, as every skill change does", async () => {
    const f = fixture();
    const skill = await stored(f, typed("Story"));
    expect((await bind(f, { id: skill.id, revision: 5 })).status).toBe(409);
  });

  it("is a registered route", () => {
    expect(API_ROUTES.some((route) => route.pattern === "/api/skills/jira-templates/bind")).toBe(
      true,
    );
  });
});

// #4354 F04: "Propose from project" dropped every type it could derive nothing for, without a word.
// The route answers for EVERY issue type: a proposal, or one closed reason, and the count.
function accountingGet(request: { readonly url: string }): ReturnType<AtlassianHttpBodyPort> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname.endsWith("/project/ACC"))
    return Promise.resolve(
      response({
        id: "20000",
        key: "ACC",
        issueTypes: [
          { id: "1", name: "Task" },
          { id: "2", name: "Epic" },
          { id: "3", name: "Bug" },
          { id: "4", name: "Sub-task", subtask: true },
        ],
      }),
    );
  const meta = /createmeta\/20000\/issuetypes\/(\d+)$/u.exec(pathname);
  if (meta !== null) {
    if (meta[1] === "3") return Promise.resolve(response({}, 403));
    const values = [
      field("summary", "string", true),
      ...(meta[1] === "1" ? [REQUIRED_CUSTOM] : []),
    ];
    return Promise.resolve(
      response({ values, startAt: 0, maxResults: 100, isLast: true, total: values.length }),
    );
  }
  if (pathname.endsWith("/search")) {
    const jql = url.searchParams.get("jql") ?? "";
    if (jql.includes("issuetype = 3 ")) return Promise.resolve(response({}, 403));
    const sample = jql.includes("issuetype = 1 ")
      ? [
          { fields: { description: "h2. Context\nA\nh2. Acceptance criteria\nB" } },
          { fields: { description: "h2. Context\nC\nh2. Acceptance criteria\nD" } },
        ]
      : [];
    return Promise.resolve(response({ issues: sample }));
  }
  return Promise.resolve(response({}, 404));
}

describe("a proposal accounts for every issue type of the project (#4354 F04)", () => {
  it("answers with a proposal or a closed reason per type, and the count", async () => {
    const { deps, cookie, http } = fixture();
    http.mockImplementation(accountingGet);
    const result = await handleProposeJiraTemplates(
      context(cookie, { podId: POD, projectKey: "ACC" }),
      deps,
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      proposals: { issueType: string }[];
      withoutProposal: { issueType: string; reason: string }[];
      typeCount: number;
    };
    expect(body.typeCount).toBe(4);
    expect(body.proposals.map((proposal) => proposal.issueType)).toEqual(["Task"]);
    expect(body.withoutProposal).toEqual([
      { issueType: "Epic", reason: "nothing-to-learn" },
      { issueType: "Bug", reason: "jira-unavailable" },
      { issueType: "Sub-task", reason: "nothing-to-learn" },
    ]);
    expect(body.proposals.length + body.withoutProposal.length).toBe(body.typeCount);
  });

  it("records the accounting as counts per closed reason on the existing operation, without a name", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie, http } = fixture();
    http.mockImplementation(accountingGet);
    await handleProposeJiraTemplates(context(cookie, { podId: POD, projectKey: "ACC" }), deps);
    const completed = sink.events.find(
      (event) =>
        event.op === "skills.library.operation" &&
        event.extra?.action === "jira-template-propose" &&
        event.extra.phase === "completed",
    );
    expect(completed?.extra).toMatchObject({
      typeCount: 4,
      proposalCount: 1,
      nothingToLearnCount: 2,
      templateInvalidCount: 0,
      jiraUnavailableCount: 1,
      beyondLimitCount: 0,
    });
    const line = formatActivityLogProofLine(completed ?? {});
    expectActivityLogProof("skills.library.operation.lifecycle", line);
    expect(line).not.toMatch(/Task|Epic|Bug|Sub-task|ACC/u);
  });
});

// #4354 F04 follow-up: a kept proposal one Jira read did not answer for must say so, and a very wide
// project must not make the response or the line grow with its type count.
function partialGet(request: { readonly url: string }): ReturnType<AtlassianHttpBodyPort> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname.endsWith("/project/PAR"))
    return Promise.resolve(
      response({
        id: "30000",
        key: "PAR",
        issueTypes: [
          { id: "1", name: "Task" },
          { id: "2", name: "Story" },
          { id: "3", name: "Bug" },
        ],
      }),
    );
  const meta = /createmeta\/30000\/issuetypes\/(\d+)$/u.exec(pathname);
  if (meta !== null) {
    // Task: Jira refuses the create metadata; the shared sections still support a proposal.
    if (meta[1] === "1") return Promise.resolve(response({}, 403));
    const values = [field("summary", "string", true), REQUIRED_CUSTOM];
    return Promise.resolve(
      response({ values, startAt: 0, maxResults: 100, isLast: true, total: values.length }),
    );
  }
  if (pathname.endsWith("/search")) {
    const jql = url.searchParams.get("jql") ?? "";
    // Story: the sample search is refused; its required field still supports a proposal.
    if (jql.includes("issuetype = 2 ")) return Promise.resolve(response({}, 403));
    const sample = jql.includes("issuetype = 1 ")
      ? [
          { fields: { description: "h2. Context\nA\nh2. Acceptance criteria\nB" } },
          { fields: { description: "h2. Context\nC\nh2. Acceptance criteria\nD" } },
        ]
      : [];
    return Promise.resolve(response({ issues: sample }));
  }
  return Promise.resolve(response({}, 404));
}
function wideGet(request: { readonly url: string }): ReturnType<AtlassianHttpBodyPort> {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/project/WID"))
    return Promise.resolve(
      response({
        id: "40000",
        key: "WID",
        issueTypes: Array.from({ length: 150 }, (_, index) => ({
          id: String(index + 1),
          name: `Type ${String(index + 1)}`,
        })),
      }),
    );
  if (pathname.includes("createmeta")) {
    const values = [field("summary", "string", true)];
    return Promise.resolve(
      response({ values, startAt: 0, maxResults: 100, isLast: true, total: values.length }),
    );
  }
  return Promise.resolve(response({ issues: [] }));
}

describe("a partial proposal says so, and the list without a proposal stays bounded (#4354 F04)", () => {
  it("marks each kept proposal with the read Jira did not answer, and the log counts them", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie, http } = fixture();
    http.mockImplementation(partialGet);
    const result = await handleProposeJiraTemplates(
      context(cookie, { podId: POD, projectKey: "PAR" }),
      deps,
    );
    const body = result.body as {
      proposals: { issueType: string; partial?: string }[];
      withoutProposal: unknown[];
    };
    expect(body.proposals.map(({ issueType, partial }) => [issueType, partial])).toEqual([
      ["Task", "required-fields-unavailable"],
      ["Story", "samples-unavailable"],
      ["Bug", undefined],
    ]);
    expect(body.withoutProposal).toEqual([]);
    const completed = sink.events.find(
      (event) =>
        event.op === "skills.library.operation" &&
        event.extra?.action === "jira-template-propose" &&
        event.extra.phase === "completed",
    );
    expect(completed?.extra).toMatchObject({ proposalCount: 3, partialProposalCount: 2 });
  });

  it("lists a bounded number of types by name and counts the rest exactly", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie, http } = fixture();
    http.mockImplementation(wideGet);
    const result = await handleProposeJiraTemplates(
      context(cookie, { podId: POD, projectKey: "WID" }),
      deps,
    );
    const body = result.body as {
      withoutProposal: { issueType: string }[];
      withoutProposalMoreCount: number;
      proposals: unknown[];
      typeCount: number;
    };
    expect(body.typeCount).toBe(150);
    expect(body.proposals).toEqual([]);
    expect(body.withoutProposal).toHaveLength(JIRA_TEMPLATE_WITHOUT_PROPOSAL_LISTED_MAX);
    expect(body.withoutProposalMoreCount).toBe(150 - JIRA_TEMPLATE_WITHOUT_PROPOSAL_LISTED_MAX);
    // The log keeps counting every type, not only the listed ones.
    const completed = sink.events.find(
      (event) =>
        event.op === "skills.library.operation" &&
        event.extra?.action === "jira-template-propose" &&
        event.extra.phase === "completed",
    );
    expect(completed?.extra).toMatchObject({
      typeCount: 150,
      nothingToLearnCount: 12,
      beyondLimitCount: 138,
    });
  });
});
