import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { handleImportMarkdownSkill, handleReplaceMarkdownSkill } from "./markdown-skill-routes.js";
import {
  handleListJiraTemplates,
  handleProposeJiraTemplates,
  handleValidateJiraTemplate,
} from "./markdown-skill-jira-template-routes.js";
import { API_ROUTES, matchRoute, type RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { UiStore } from "./store/types.js";
import { field, response } from "../../../tests/support/jira-managed-remote.js";

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

function jiraGet(request: { readonly url: string }): ReturnType<AtlassianHttpBodyPort> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.endsWith("/project/SYN"))
    return Promise.resolve(
      response({
        id: "10000",
        key: "SYN",
        issueTypes: [
          { id: "10001", name: "Story" },
          { id: "10002", name: "Bug" },
        ],
      }),
    );
  if (path.endsWith("/project/SYN/statuses"))
    return Promise.resolve(
      response([{ id: "10001", name: "Story", statuses: [{ name: "To Do" }, { name: "Done" }] }]),
    );
  if (path.endsWith("/field"))
    return Promise.resolve(response([{ id: "customfield_10016", name: "Story Points" }]));
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
          { fields: { description: "## Context\nA\n## Acceptance criteria\nB" } },
          { fields: { description: "## Context\nC\n## Acceptance criteria\nD" } },
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

function fixture(options: { pod?: boolean } = {}): {
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
  const http = vi.fn<AtlassianHttpBodyPort>(jiraGet);
  const metadata = {
    schemaVersion: "1",
    authRef: "synthetic-credential",
    displayName: "Synthetic Jira",
    baseUrl: "https://jira.example.invalid/context",
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
});

describe("template documents in the skill library", () => {
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
