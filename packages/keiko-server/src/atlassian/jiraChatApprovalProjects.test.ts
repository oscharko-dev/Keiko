import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import { JIRA_APPROVAL_PROJECTS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { UiHandlerDeps } from "../deps.js";
import { jiraApprovalProjectReferences, reviewedJiraProjects } from "./jiraChatApprovalProjects.js";
import * as authority from "./jiraChatAuthority.js";

type Deps = Parameters<typeof reviewedJiraProjects>[0];
const REFERENCE = {
  envelopeDigest: "d".repeat(64),
} as unknown as EditorAgentGovernedAuthorityReference;
const PROJECTS: Readonly<Record<string, { id: string; key: string; name: string }>> = {
  "10000": { id: "10000", key: "SYN", name: "Synthetic Project" },
  KEI: { id: "10002", key: "KEI", name: "Keiko synthetic" },
};
let logs: ReturnType<typeof createBufferedServerLogSink>;
let requested: { readonly method: string; readonly path: string }[];

beforeEach(() => {
  logs = createBufferedServerLogSink();
  requested = [];
  vi.spyOn(processServerLogSink(), "write").mockImplementation(logs.write);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function admitted(): void {
  vi.spyOn(authority, "resolveCurrentJiraChatAuthority").mockReturnValue({
    ok: true,
    credential: { baseUrl: "https://jira.example.invalid", deployment: "data-center" },
  } as unknown as ReturnType<typeof authority.resolveCurrentJiraChatAuthority>);
}
function respond(status: number, body: unknown): ReturnType<AtlassianHttpBodyPort> {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  });
}
function deps(answer: (path: string) => ReturnType<AtlassianHttpBodyPort>): Deps {
  const factory: NonNullable<
    UiHandlerDeps["atlassianConnectorCredentials"]
  >["httpBodyPortFactory"] = (_metadata, _correlation, lifecycle) => (request) => {
    if (lifecycle?.beforeDispatch?.(request) !== true) throw new TypeError("not admitted");
    const path = new URL(request.url).pathname;
    requested.push({ method: request.method, path });
    lifecycle.onResponse?.(request, 200);
    return answer(path);
  };
  return {
    atlassianConnectorCredentials: { httpBodyPortFactory: factory },
  } as unknown as Deps;
}
const OPTIONS = (extra: object = {}): Parameters<typeof reviewedJiraProjects>[1] => ({
  chatId: "chat-1",
  authorityReference: REFERENCE,
  signal: new AbortController().signal,
  correlationId: "corr-project",
  ...extra,
});
const found = (path: string): ReturnType<AtlassianHttpBodyPort> => {
  const project = PROJECTS[path.split("/").at(-1) ?? ""];
  return project === undefined ? respond(404, {}) : respond(200, project);
};
const line = (): string => formatActivityLogProofLine(logs.events.at(-1) ?? failEmpty());
function failEmpty(): never {
  throw new TypeError("No Activity Log line was written");
}

describe("which projects an approval's action targets", () => {
  const none = {};
  const item = (ref: string, projectId: unknown): object => ({
    ref,
    projectId,
    issueTypeId: "10001",
    fields: { summary: ref },
  });
  it("lists each project of a draft once, in the order the items state them", () => {
    const items = [item("a", "10002"), item("b", "10000"), item("c", "10002")];
    expect(jiraApprovalProjectReferences(none, "chat-1", "jira.draft", { items })).toEqual([
      "10002",
      "10000",
    ]);
  });
  it("takes the projectId of any other write, and nothing when the call names none", () => {
    expect(
      jiraApprovalProjectReferences(none, "chat-1", "jira.create", { projectId: "10000" }),
    ).toEqual(["10000"]);
    expect(
      jiraApprovalProjectReferences(none, "chat-1", "jira.create", { projectId: "KEI" }),
    ).toEqual(["KEI"]);
    expect(
      jiraApprovalProjectReferences(none, "chat-1", "jira.edit", { issueKey: "SYN-1" }),
    ).toEqual([]);
  });
  it("never takes a reference that is not an id or a key, and never more than a card can name", () => {
    expect(
      jiraApprovalProjectReferences(none, "chat-1", "jira.create", {
        projectId: "https://x.invalid/1",
      }),
    ).toEqual([]);
    expect(
      jiraApprovalProjectReferences(none, "chat-1", "jira.create", { projectId: 10000 }),
    ).toEqual([]);
    const items = Array.from({ length: JIRA_APPROVAL_PROJECTS_MAX + 4 }, (_, i) =>
      item(`i${String(i)}`, String(20000 + i)),
    );
    expect(jiraApprovalProjectReferences(none, "chat-1", "jira.draft", { items })).toHaveLength(
      JIRA_APPROVAL_PROJECTS_MAX,
    );
  });
});

describe("reading the projects an approval names", () => {
  it("returns key and name as Jira answers, by id and by key, through one GET each", async () => {
    admitted();
    const projects = await reviewedJiraProjects(deps(found), OPTIONS(), ["10000", "kei"]);
    expect(projects).toEqual([
      { ref: "10000", key: "SYN", name: "Synthetic Project" },
      { ref: "kei", key: "KEI", name: "Keiko synthetic" },
    ]);
    expect(requested).toEqual([
      { method: "GET", path: "/rest/api/2/project/10000" },
      { method: "GET", path: "/rest/api/2/project/KEI" },
    ]);
    expect(expectActivityLogProof("jira.approval.project.line", line())).toMatchObject({
      op: "jira.approval.project",
      level: "info",
      projectCount: 2,
      resolvedCount: 2,
      unresolvedCount: 0,
      failure: "none",
    });
    // Body-free: the line carries counts and a closed value, never a key, a name or an id.
    expect(JSON.stringify(logs.events)).not.toMatch(/Synthetic Project|Keiko synthetic|SYN|10000/u);
  });
  it.each([
    [404, "not-found"],
    [503, "unavailable"],
  ])(
    "lists a project Jira answered %i by its reference alone and records %s",
    async (status, failure) => {
      admitted();
      const projects = await reviewedJiraProjects(
        deps((path) => (path.endsWith("/10000") ? respond(status, {}) : found(path))),
        OPTIONS(),
        ["10000", "KEI"],
      );
      expect(projects).toEqual([
        { ref: "10000" },
        { ref: "KEI", key: "KEI", name: "Keiko synthetic" },
      ]);
      expect(expectActivityLogProof("jira.approval.project.line", line())).toMatchObject({
        level: "warn",
        projectCount: 2,
        resolvedCount: 1,
        unresolvedCount: 1,
        failure,
      });
    },
  );
  it("refuses a malformed answer instead of showing a name it cannot trust", async () => {
    admitted();
    const projects = await reviewedJiraProjects(
      deps(() => respond(200, { id: "10000", key: "SYN" })),
      OPTIONS(),
      ["10000"],
    );
    expect(projects).toEqual([{ ref: "10000" }]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "malformed-payload" });
  });
  it("reads nothing when the authority is not current, and records that it was not admitted", async () => {
    vi.spyOn(authority, "resolveCurrentJiraChatAuthority").mockReturnValue({
      ok: false,
    } as unknown as ReturnType<typeof authority.resolveCurrentJiraChatAuthority>);
    expect(await reviewedJiraProjects(deps(found), OPTIONS(), ["10000"])).toEqual([
      { ref: "10000" },
    ]);
    expect(requested).toEqual([]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "not-admitted", resolvedCount: 0 });
  });
  it("reads nothing once a combined turn no longer admits the read", async () => {
    admitted();
    expect(
      await reviewedJiraProjects(deps(found), OPTIONS({ readAllowed: () => false }), ["10000"]),
    ).toEqual([{ ref: "10000" }]);
    expect(requested).toEqual([]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "not-admitted" });
  });
  it("names no project, and writes no line, for an action that targets none", async () => {
    admitted();
    expect(await reviewedJiraProjects(deps(found), OPTIONS(), [])).toBeUndefined();
    expect(logs.events).toEqual([]);
  });
});
