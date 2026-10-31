import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_TEMPLATE_RULE_IDS,
  parseJiraIssueTemplate,
  type JiraMutationAttempt,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import type { JiraChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { field, response } from "../../../../tests/support/jira-managed-remote.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";
import { jiraAttemptToolResult, validJiraMutationAttempt } from "./jiraMutationResult.js";
import { createJiraChatTemplatePreflight } from "./jiraChatTemplatePreflight.js";
import { jiraIssueTemplateSource, recordJiraTemplateRefusal } from "./jiraTemplateLog.js";

vi.mock("./jiraChatAuthority.js", () => ({
  resolveCurrentJiraChatAuthority: (): unknown => ({
    ok: true,
    credential: { baseUrl: "https://jira.example.invalid/context", deployment: "data-center" },
  }),
}));

const VIOLATION: JiraTemplateViolation = {
  ruleId: "section-missing",
  subject: "Acceptance criteria",
  template: "SYN/Story",
};
const TEMPLATE = [
  "---",
  "keiko: jira-issue-template",
  "version: 1",
  "project: SYN",
  "issueType: Story",
  "activateOn: [create]",
  "---",
  "# Story",
  "## Acceptance criteria",
].join("\n");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  resetServerLogger();
});

function logs(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

describe("the model-facing refusal", () => {
  it("keeps violations only on a field-validation refusal and bounds them", () => {
    const many = Array.from({ length: 40 }, () => VIOLATION);
    const refused = validJiraMutationAttempt(
      { ok: false, reason: "field-validation", violations: many },
      "jira.create",
    );
    expect(refused).toMatchObject({ ok: false, reason: "field-validation" });
    expect(refused.ok ? 0 : refused.violations?.length).toBe(25);
    const smuggled = validJiraMutationAttempt(
      { ok: false, reason: "conflict", violations: [VIOLATION] },
      "jira.create",
    );
    expect(smuggled).toEqual({ ok: false, reason: "conflict" });
    const forged = validJiraMutationAttempt(
      {
        ok: false,
        reason: "field-validation",
        violations: [{ ...VIOLATION, ruleId: "made-up" as never }],
      },
      "jira.create",
    );
    expect(forged).toEqual({ ok: false, reason: "field-validation" });
  });

  it("returns the violations to the model as tool-result data", () => {
    const attempt: JiraMutationAttempt = {
      ok: false,
      reason: "field-validation",
      violations: [VIOLATION],
    };
    expect(jiraAttemptToolResult("rejected", attempt)).toEqual({
      data: { outcome: "rejected", reason: "field-validation", violations: [VIOLATION] },
      isError: true,
    });
  });

  it("registers every rule id the contract defines", () => {
    const sink = logs();
    recordJiraTemplateRefusal("c-1", {
      operation: "jira.create",
      stage: "dispatch",
      violations: JIRA_TEMPLATE_RULE_IDS.map((ruleId) => ({ ruleId })),
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.extra?.ruleIds).toEqual([...JIRA_TEMPLATE_RULE_IDS]);
  });
});

function journalFixture(): {
  journal: ReturnType<typeof createChatToolMutationStore>;
  intent: JiraChatToolMutationIntent;
} {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  cleanup.push(() => {
    store.close();
  });
  const chat = store.createChat(store.createProject(process.cwd()).path, "Synthetic", "model");
  const turn = store.admitChatTurn("synthetic-turn", {
    chatId: chat.id,
    role: "user",
    content: "synthetic",
    timestamp: 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected turn");
  return {
    journal: createChatToolMutationStore(db, () => 1000, createBufferedServerLogSink()),
    intent: {
      invocationId: "invocation-one",
      chatId: chat.id,
      userMessageId: turn.userMessage.id,
      turnRef: turn.userMessage.canonicalTurnRef,
      actorId: "actor-one",
      podId: "pod-one",
      bindingGeneration: 1,
      credentialGeneration: 1,
      authorityDigest: "a".repeat(64),
      actionDigest: "b".repeat(64),
      operation: "jira.create",
      correlationId: "mutation-one",
    },
  };
}

describe("a refused write through the Chat mutation journal", () => {
  it("rejects, never dispatches, hands the model the violations and logs ids and counts only", async () => {
    const sink = logs();
    const { journal, intent } = journalFixture();
    const http = vi.fn<AtlassianHttpBodyPort>();
    const result = await executeJiraChatMutation({
      journal,
      intent,
      httpPortFactory: () => http,
      beforeEffect: () => true,
      beforeMutation: () => true,
      execute: () =>
        Promise.resolve({ ok: false, reason: "field-validation", violations: [VIOLATION] }),
    });
    expect(result.data).toEqual({
      outcome: "rejected",
      reason: "field-validation",
      violations: [VIOLATION],
    });
    expect(http).not.toHaveBeenCalled();
    expect(journal.find(intent.invocationId)).toMatchObject({ outcome: "rejected" });
    const events = sink.events.filter((event) => event.op === "jira.template.admission");
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("warn");
    expect(events[0]?.correlationId).toBe("mutation-one");
    expect(events[0]?.extra).toMatchObject({
      operation: "jira.create",
      stage: "dispatch",
      violationCount: 1,
      ruleIds: ["section-missing"],
    });
    expectActivityLogProof(
      "jira.template.admission.line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(JSON.stringify(events)).not.toContain("Acceptance criteria");
  });

  it("does not log a refusal that is not a template refusal", async () => {
    const sink = logs();
    const { journal, intent } = journalFixture();
    await executeJiraChatMutation({
      journal,
      intent,
      httpPortFactory: () => vi.fn<AtlassianHttpBodyPort>(),
      beforeEffect: () => true,
      beforeMutation: () => true,
      execute: () => Promise.resolve({ ok: false, reason: "field-validation" }),
    });
    expect(sink.events.filter((event) => event.op === "jira.template.admission")).toEqual([]);
  });
});

describe("the template source", () => {
  it("lists valid templates and counts stored ones that no longer parse", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const store = buildUiStoreOverDatabase(db);
    cleanup.push(() => {
      store.close();
    });
    const upload = (text: string): void => {
      store.markdownSkills.import({
        fileName: "template.md",
        contentBase64: Buffer.from(text).toString("base64"),
      });
    };
    upload(TEMPLATE);
    upload("# Ordinary skill\nSay keiko: jira-issue-template in prose.\n");
    expect(jiraIssueTemplateSource(store)()).toEqual({
      templates: [expect.objectContaining({ project: "SYN", issueType: "Story" })],
      unreadable: 0,
      unreadableNames: [],
    });
    // A template stored before the grammar tightened must fail closed, not silently vanish.
    const stale = "---\nkeiko: jira-issue-template\nversion: 7\n---\n";
    db.prepare(
      "UPDATE markdown_skill_revisions SET body = ?, digest = ?, byte_count = ? WHERE body LIKE '%SYN%'",
    ).run(stale, createHash("sha256").update(stale).digest("hex"), Buffer.byteLength(stale));
    expect(parseJiraIssueTemplate(stale).ok).toBe(false);
    expect(jiraIssueTemplateSource(store)()).toEqual({
      templates: [],
      unreadable: 1,
      unreadableNames: ["Story"],
    });
  });
});

describe("the template marker", () => {
  function libraryOf(): ReturnType<typeof buildUiStoreOverDatabase> {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const store = buildUiStoreOverDatabase(db);
    cleanup.push(() => {
      store.close();
    });
    return store;
  }
  const importText = (store: ReturnType<typeof libraryOf>, text: string): void => {
    store.markdownSkills.import({
      fileName: "template.md",
      contentBase64: Buffer.from(text).toString("base64"),
    });
  };

  it.each([
    "keiko:   jira-issue-template",
    'keiko: "jira-issue-template"',
    "keiko : jira-issue-template  ",
  ])("lists and enforces a template whose marker is written %j", (marker) => {
    const store = libraryOf();
    importText(store, TEMPLATE.replace("keiko: jira-issue-template", marker));
    expect(jiraIssueTemplateSource(store)().templates).toEqual([
      expect.objectContaining({ project: "SYN", issueType: "Story" }),
    ]);
    expect(store.markdownSkills.jiraTemplates()).toHaveLength(1);
  });

  it("refuses an upload that carries the marker without a valid front matter", () => {
    const store = libraryOf();
    expect(() => {
      importText(store, `\n${TEMPLATE}`);
    }).toThrow(/marker without a valid front matter/u);
    expect(store.markdownSkills.jiraTemplates()).toEqual([]);
  });

  it("still accepts an ordinary skill that only discusses the marker in prose or code", () => {
    const store = libraryOf();
    importText(
      store,
      "# Notes\nSay keiko: jira-issue-template in prose.\n```\nkeiko: jira-issue-template\n```\n",
    );
    expect(store.markdownSkills.jiraTemplates()).toEqual([]);
  });
});

describe("the dry run before approval", () => {
  function preflight(
    templateText: string,
    args: Record<string, unknown> | undefined,
  ): {
    run: () => Promise<unknown>;
    http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  } {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const store = buildUiStoreOverDatabase(db);
    cleanup.push(() => {
      store.close();
    });
    store.markdownSkills.import({
      fileName: "template.md",
      contentBase64: Buffer.from(templateText).toString("base64"),
    });
    const http = vi.fn<AtlassianHttpBodyPort>((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/project/10000")) return Promise.resolve(response({ key: "SYN" }));
      if (path.endsWith("/issuetype/10001"))
        return Promise.resolve(response({ id: "10001", name: "Story" }));
      const values = [
        field("project", "project", true),
        field("issuetype", "issuetype", true),
        field("summary", "string", true),
        field("description", "string"),
      ];
      return Promise.resolve(
        response({ values, start: 0, size: values.length, last: true, total: values.length }),
      );
    });
    const preflight = createJiraChatTemplatePreflight({
      deps: {
        store,
        atlassianConnectorCredentials: { httpBodyPortFactory: () => http },
      } as never,
      writeArguments: () => args as never,
      readAllowed: () => true,
    });
    return {
      http,
      run: () =>
        preflight(
          { tool: "jira.create", actionId: "a", idempotencyKey: "a", argumentsDigest: "d" },
          {
            chatId: "chat",
            correlationId: "preflight-1",
            authorityReference: {},
            signal: new AbortController().signal,
          } as never,
        ),
    };
  }
  const CREATE = { projectId: "10000", issueTypeId: "10001", fields: { summary: "Add login" } };

  it("returns the structured refusal before any approval and never writes", async () => {
    const sink = logs();
    const f = preflight(TEMPLATE, CREATE);
    expect(await f.run()).toEqual({
      outcome: "rejected",
      reason: "field-validation",
      violations: [
        { ruleId: "section-missing", subject: "Acceptance criteria", template: "SYN/Story" },
      ],
    });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    const events = sink.events.filter((event) => event.op === "jira.template.admission");
    expect(events.map((event) => event.extra?.stage)).toEqual(["pre-approval"]);
  });

  it("lets a conforming proposal through to the human's approval", async () => {
    const f = preflight(TEMPLATE, {
      ...CREATE,
      fields: { summary: "Add login", description: "## Acceptance criteria\n* works" },
    });
    expect(await f.run()).toBeUndefined();
  });

  it("does nothing without proposed arguments or a governing template", async () => {
    expect(await preflight(TEMPLATE, undefined).run()).toBeUndefined();
    const f = preflight("# Ordinary skill\n", CREATE);
    expect(await f.run()).toBeUndefined();
    const paths = f.http.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(paths.some((path) => /\/(project|issuetype)\//u.test(path))).toBe(false);
  });
});
