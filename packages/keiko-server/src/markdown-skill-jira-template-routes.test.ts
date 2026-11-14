import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_TEMPLATE_WITHOUT_PROPOSAL_LISTED_MAX,
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
  resetServerLogger();
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
