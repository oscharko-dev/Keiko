import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJiraDraftStore, type AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import { JIRA_APPROVAL_PROJECTS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  PROJECT_READ_TIMEOUT_MS,
  jiraApprovalIssueTypeReferences,
  jiraApprovalProjectReferences,
  reviewedJiraProjects,
} from "./jiraChatApprovalProjects.js";
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
    redactor: (value: unknown) => value,
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

describe("which issue types an approval's action carries", () => {
  it("takes a create's issueTypeId and each draft item's, once", () => {
    expect(
      jiraApprovalIssueTypeReferences({}, "chat-1", "jira.create", { issueTypeId: "10002" }),
    ).toEqual(["10002"]);
    const items = [
      { ref: "a", projectId: "1", issueTypeId: "10002", fields: { summary: "a" } },
      { ref: "b", projectId: "1", issueTypeId: "10002", fields: { summary: "b" } },
      { ref: "c", projectId: "1", issueTypeId: "10003", fields: { summary: "c" } },
    ];
    expect(jiraApprovalIssueTypeReferences({}, "chat-1", "jira.draft", { items })).toEqual([
      "10002",
      "10003",
    ]);
    expect(jiraApprovalIssueTypeReferences({}, "chat-1", "jira.edit", { issueKey: "A-1" })).toEqual(
      [],
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
  // R04 (b): a restored or approved create card showed "Issue type 10002". The same project read that
  // names the project names the issue types the call carries, in the person's language.
  it("names the issue types the call carries from the same project read, and only those", async () => {
    admitted();
    const withTypes = (path: string): ReturnType<AtlassianHttpBodyPort> =>
      path.endsWith("/10000")
        ? respond(200, {
            id: "10000",
            key: "SYN",
            name: "Synthetic Project",
            issueTypes: [
              { id: "10001", name: "Geschichte" },
              { id: "10002", name: "Aufgabe" },
            ],
          })
        : found(path);
    const projects = await reviewedJiraProjects(
      deps(withTypes),
      OPTIONS(),
      ["10000"],
      ["10002", "99999"],
    );
    expect(projects).toEqual([
      {
        ref: "10000",
        key: "SYN",
        name: "Synthetic Project",
        issueTypes: [{ id: "10002", name: "Aufgabe" }],
      },
    ]);
    expect(requested).toEqual([{ method: "GET", path: "/rest/api/2/project/10000" }]);
  });
  it("lists no issue type for a call that carries none", async () => {
    admitted();
    const projects = await reviewedJiraProjects(deps(found), OPTIONS(), ["10000"]);
    expect(projects?.[0]).not.toHaveProperty("issueTypes");
  });
  it.each([
    [404, "not-found", "info"],
    // A read is retried while the window lasts: a Jira that keeps failing ends as a timeout.
    [503, "timeout", "warn"],
  ])(
    "lists a project Jira answered %i by its reference alone and records %s at %s",
    async (status, failure, level) => {
      admitted();
      const projects = await reviewedJiraProjects(
        deps((path) => (path.endsWith("/10000") ? respond(status, {}) : found(path))),
        OPTIONS({ timeoutMs: 300 }),
        ["10000", "KEI"],
      );
      expect(projects).toEqual([
        { ref: "10000" },
        { ref: "KEI", key: "KEI", name: "Keiko synthetic" },
      ]);
      expect(expectActivityLogProof("jira.approval.project.line", line())).toMatchObject({
        level,
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
      deps(() => respond(200, { id: "10000", name: "Synthetic Project" })),
      OPTIONS(),
      ["10000"],
    );
    expect(projects).toEqual([{ ref: "10000" }]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "malformed-payload" });
    expect(logs.events.at(-1)?.level).toBe("warn");
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
    // Nothing was admitted to read: that is ordinary, not a fault to warn about.
    expect(logs.events.at(-1)?.level).toBe("info");
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

describe("a name that cannot be shown drops that name alone", () => {
  const answer = (
    name: unknown,
    key = "SYN",
  ): ((path: string) => ReturnType<AtlassianHttpBodyPort>) => {
    return () => respond(200, { id: "10000", key, name });
  };
  it.each([
    ["longer than 255 characters", "n".repeat(256)],
    ["with a control character", "Synthetic\u0007Project"],
    ["with surrounding blanks", " Synthetic Project "],
    ["empty", ""],
    ["not text", 42],
  ])("keeps the key of a project whose name is %s", async (_label, name) => {
    admitted();
    expect(await reviewedJiraProjects(deps(answer(name)), OPTIONS(), ["10000"])).toEqual([
      { ref: "10000", key: "SYN" },
    ]);
    // The project was read: nothing is a failure.
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "none", resolvedCount: 1 });
  });
  it("keeps the key when the credential floor changes the name", async () => {
    admitted();
    const redacting = deps(answer("Synthetic Project"));
    (redacting as unknown as { redactor: (value: unknown) => unknown }).redactor = (): string =>
      "[REDACTED]";
    expect(await reviewedJiraProjects(redacting, OPTIONS(), ["10000"])).toEqual([
      { ref: "10000", key: "SYN" },
    ]);
  });
  it("shows only the reference when even the key cannot be shown", async () => {
    admitted();
    expect(
      await reviewedJiraProjects(deps(answer("Synthetic Project", "A B")), OPTIONS(), ["10000"]),
    ).toEqual([{ ref: "10000" }]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "malformed-payload" });
  });
});

describe("a lookup that can never fail the card", () => {
  const never = (): ReturnType<AtlassianHttpBodyPort> => new Promise(() => undefined);
  it("falls back to the references when the credential owner throws, and records a closed failure", async () => {
    admitted();
    const throwing = {
      atlassianConnectorCredentials: {
        httpBodyPortFactory: (): never => {
          throw new TypeError("private provider detail");
        },
      },
      redactor: (value: unknown) => value,
    } as unknown as Deps;
    expect(await reviewedJiraProjects(throwing, OPTIONS(), ["10000", "KEI"])).toEqual([
      { ref: "10000" },
      { ref: "KEI" },
    ]);
    expect(expectActivityLogProof("jira.approval.project.line", line())).toMatchObject({
      level: "warn",
      failure: "failed",
      resolvedCount: 0,
    });
    expect(JSON.stringify(logs.events)).not.toContain("private provider detail");
  });
  it("keeps the names of the other projects when one read throws", async () => {
    admitted();
    const projects = await reviewedJiraProjects(
      deps((path) => {
        if (path.endsWith("/10000")) throw new TypeError("one read broke");
        return found(path);
      }),
      OPTIONS(),
      ["10000", "KEI"],
    );
    expect(projects).toEqual([
      { ref: "10000" },
      { ref: "KEI", key: "KEI", name: "Keiko synthetic" },
    ]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ resolvedCount: 1, unresolvedCount: 1 });
  });
  it("leaves the fallback after the window when Jira does not answer, without waiting for it", async () => {
    admitted();
    const started = Date.now();
    const projects = await reviewedJiraProjects(deps(never), OPTIONS({ timeoutMs: 40 }), ["10000"]);
    expect(projects).toEqual([{ ref: "10000" }]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "timeout" });
    expect(logs.events.at(-1)?.level).toBe("warn");
  });
  it("bounds the real window at two seconds", () => {
    expect(PROJECT_READ_TIMEOUT_MS).toBe(2_000);
  });
  it.each([
    [
      "a stopped turn",
      (controller: AbortController): void => {
        controller.abort();
      },
    ],
    [
      "a fired deadline",
      (controller: AbortController): void => {
        controller.abort(new DOMException("deadline", "TimeoutError"));
      },
    ],
  ])("cancels the lookup on %s, and a late answer changes nothing", async (_label, stop) => {
    admitted();
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const pending = reviewedJiraProjects(
      deps(async (path) => {
        await late;
        return found(path);
      }),
      OPTIONS({ signal: controller.signal }),
      ["10000"],
    );
    stop(controller);
    const projects = await pending;
    expect(projects).toEqual([{ ref: "10000" }]);
    expect(logs.events.at(-1)?.extra).toMatchObject({ failure: "cancelled" });
    expect(logs.events.at(-1)?.level).toBe("info");
    const lines = logs.events.length;
    // Jira answers after the turn ended: the returned list and the log stay as they were.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(projects).toEqual([{ ref: "10000" }]);
    expect(logs.events).toHaveLength(lines);
  });
});

describe("a staged draft names its projects through its own reference", () => {
  it("lists the projects of the items the reference resolves to", () => {
    const store = createJiraDraftStore();
    const fingerprint = "connection-1";
    store.bindConnection((owner) => (owner === "chat-1" ? fingerprint : undefined));
    const appended = store.append("chat-1", undefined, fingerprint, [
      { ref: "a", projectId: "10002", issueTypeId: "10001", fields: { summary: "A" }, links: [] },
      { ref: "b", projectId: "10000", issueTypeId: "10001", fields: { summary: "B" }, links: [] },
    ] as never);
    if (!appended.ok) throw new TypeError("Expected the draft to stage");
    const reference = { draftId: appended.draft.id, draftDigest: appended.draft.digest };
    expect(
      jiraApprovalProjectReferences({ jiraDraftStore: store }, "chat-1", "jira.draft", reference),
    ).toEqual(["10002", "10000"]);
    // Another Chat's draft, or a changed digest, names nothing.
    expect(
      jiraApprovalProjectReferences({ jiraDraftStore: store }, "chat-2", "jira.draft", reference),
    ).toEqual([]);
    expect(
      jiraApprovalProjectReferences({ jiraDraftStore: store }, "chat-1", "jira.draft", {
        ...reference,
        draftDigest: "0".repeat(64),
      }),
    ).toEqual([]);
  });
});
