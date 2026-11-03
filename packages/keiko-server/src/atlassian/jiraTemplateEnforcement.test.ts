import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_TEMPLATE_RULE_IDS,
  parseJiraIssueTemplate,
  type JiraMutationAttempt,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraTemplateViolationGuidance,
  type AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
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
import {
  field,
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import {
  JIRA_ALREADY_REFUSED_GUIDANCE,
  JIRA_UNCERTAIN_GUIDANCE,
  jiraAttemptToolResult,
  jiraMutationToolResult,
  validJiraMutationAttempt,
} from "./jiraMutationResult.js";
import { createJiraChatTemplatePreflight } from "./jiraChatTemplatePreflight.js";
import {
  jiraIssueTemplateSource,
  recordJiraFieldRefusal,
  recordJiraTemplateRefusal,
} from "./jiraTemplateLog.js";

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
      data: {
        outcome: "rejected",
        reason: "field-validation",
        violations: [VIOLATION],
        guidance: jiraTemplateViolationGuidance([VIOLATION]),
      },
      isError: true,
    });
  });

  it("says how a section is written only when a section is what the template misses (S16 of #4173)", () => {
    const words = (ruleId: JiraTemplateViolation["ruleId"]): string | undefined =>
      jiraTemplateViolationGuidance([{ ruleId, subject: "Schritte", template: "SYN/Task" }]);
    expect(words("section-missing")).toContain("h2. Title");
    expect(words("section-empty")).toContain("h2. Title");
    expect(words("summary-pattern")).not.toContain("h2.");
    expect(words("summary-pattern")).toContain("violations");
    expect(jiraTemplateViolationGuidance([])).toBeUndefined();
  });

  it("tells a repeated refusal that sending it again cannot help (S16 of #4173)", () => {
    expect(jiraMutationToolResult("rejected", undefined, {}, true).data).toMatchObject({
      outcome: "rejected",
      replayed: true,
      guidance: JIRA_ALREADY_REFUSED_GUIDANCE,
    });
    // A replayed success or an uncertain write keeps what it always said.
    expect(jiraMutationToolResult("succeeded", undefined, {}, true).data.guidance).toBeUndefined();
    expect(jiraMutationToolResult("unknown", undefined, {}, true).data.guidance).toBe(
      JIRA_UNCERTAIN_GUIDANCE,
    );
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

  it("registers every field validation the contract defines", () => {
    const sink = logs();
    recordJiraFieldRefusal("c-1", {
      operation: "jira.draft",
      refusedCount: JIRA_FIELD_VALIDATION_FAILURES.length,
      validations: JIRA_FIELD_VALIDATION_FAILURES,
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.extra?.validations).toEqual([...JIRA_FIELD_VALIDATION_FAILURES]);
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
      guidance: expect.stringContaining("h2. Title"),
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
    tool: "jira.create" | "jira.draft" = "jira.create",
    jira: {
      readonly fields?: readonly unknown[];
      readonly existing?: readonly unknown[];
      readonly metadataFails?: boolean;
    } = {},
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
      if (path.endsWith("/search")) {
        const issues = jira.existing ?? [];
        return Promise.resolve(
          response({ issues, startAt: 0, maxResults: 100, total: issues.length }),
        );
      }
      if (jira.metadataFails === true) return Promise.resolve(response({}, 503));
      const extra = jira.fields ?? [];
      const overridden = (id: string): boolean =>
        extra.some((candidate) => (candidate as { fieldId?: unknown }).fieldId === id);
      const values = [
        field("project", "project", true),
        field("issuetype", "issuetype", true),
        field("summary", "string", true),
        ...(overridden("description") ? [] : [field("description", "string")]),
        ...extra,
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
        preflight({ tool, actionId: "a", idempotencyKey: "a", argumentsDigest: "d" }, {
          chatId: "chat",
          correlationId: "preflight-1",
          authorityReference: {},
          signal: new AbortController().signal,
        } as never),
    };
  }
  const CREATE = { projectId: "10000", issueTypeId: "10001", fields: { summary: "Add login" } };

  it("returns the structured refusal before any approval and never writes", async () => {
    const sink = logs();
    const f = preflight(TEMPLATE, CREATE);
    expect(await f.run()).toEqual({
      outcome: "rejected",
      reason: "field-validation",
      guidance: expect.stringContaining("h2. Title"),
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

  describe("a backlog draft (#4178)", () => {
    const item = (ref: string, description: string): Record<string, unknown> => ({
      ref,
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: `Item ${ref}`, description },
    });
    const GOOD = "## Acceptance criteria\n* works";

    it("refuses an invalid item that follows a valid one, before any approval, and never writes", async () => {
      const sink = logs();
      const f = preflight(
        TEMPLATE,
        { items: [item("epic", GOOD), item("story", "nothing")] },
        "jira.draft",
      );
      expect(await f.run()).toEqual({
        outcome: "rejected",
        reason: "field-validation",
        guidance: expect.stringContaining("h2. Title"),
        items: [
          {
            ref: "story",
            state: "failed",
            reason: "field-validation",
            violations: [
              { ruleId: "section-missing", subject: "Acceptance criteria", template: "SYN/Story" },
            ],
          },
        ],
      });
      expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
      const events = sink.events.filter((event) => event.op === "jira.template.admission");
      expect(events.map((event) => event.extra?.stage)).toEqual(["pre-approval"]);
      const drafts = sink.events.filter((event) => event.op === "atlassian.jira-draft");
      expect(drafts.at(-1)?.extra).toMatchObject({
        phase: "refused",
        refusal: "template-violation",
        violationCount: 1,
      });
    });

    it("tells the model which item of an invalid draft to correct, in fixed words (S07 of #4173)", async () => {
      const sink = logs();
      const orphan = { ...item("story", GOOD), parent: { fieldId: "customfield_10101" } };
      const f = preflight(
        "# Ordinary skill\n",
        { items: [item("epic", GOOD), orphan] },
        "jira.draft",
      );
      expect(await f.run()).toEqual({
        outcome: "rejected",
        reason: "field-validation",
        draftRefusal: "draft-invalid",
        guidance:
          "Item 2 has a malformed parent. Nest an item by giving it parent { fieldId, ref } for an " +
          "item of this draft, or { fieldId, issueKey } for an existing issue, with fieldId the " +
          "relation field named in the child's create fields. Nothing was changed. Correct the " +
          "draft and send it once.",
        items: [],
      });
      expect(f.http).not.toHaveBeenCalled();
      const drafts = sink.events.filter((event) => event.op === "atlassian.jira-draft");
      expect(drafts.at(-1)?.extra).toMatchObject({ phase: "refused", refusal: "draft-invalid" });
    });

    it("lets a conforming draft through to the human's approval", async () => {
      const f = preflight(
        TEMPLATE,
        { items: [item("epic", GOOD), item("story", GOOD)] },
        "jira.draft",
      );
      expect(await f.run()).toBeUndefined();
    });

    it("reads one issue type's fields once however large the draft, and no item", async () => {
      const f = preflight(
        "# Ordinary skill\n",
        { items: [item("epic", "nothing"), item("story", "nothing"), item("bug", "nothing")] },
        "jira.draft",
      );
      expect(await f.run()).toBeUndefined();
      expect(f.http).toHaveBeenCalledTimes(1);
    });

    describe("an item Keiko itself would refuse (S05 of #4173)", () => {
      const EPIC_NAME = field("customfield_10103", "string", true);
      const ORDINARY = "# Ordinary skill\n";

      it("names every such item before any approval and never writes", async () => {
        const sink = logs();
        const f = preflight(
          ORDINARY,
          { items: [item("one", "text"), item("two", "text")] },
          "jira.draft",
          { fields: [EPIC_NAME] },
        );
        const row = (ref: string): Record<string, unknown> => ({
          ref,
          state: "failed",
          reason: "field-validation",
          fieldId: "customfield_10103",
          validation: "required-field",
        });
        expect(await f.run()).toEqual({
          outcome: "rejected",
          reason: "field-validation",
          failedCount: 2,
          items: [row("one"), row("two")],
        });
        expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
        const drafts = sink.events.filter((event) => event.op === "atlassian.jira-draft");
        expect(drafts.at(-1)?.extra).toMatchObject({
          phase: "refused",
          refusal: "invalid-fields",
          violationCount: 2,
        });
        const events = sink.events.filter((event) => event.op === "jira.field.admission");
        expect(events.map((event) => event.correlationId)).toEqual(["preflight-1"]);
        expect(events[0]?.extra).toMatchObject({
          operation: "jira.draft",
          refusedCount: 2,
          validations: ["required-field"],
        });
        expectActivityLogProof(
          "jira.field.admission.line",
          formatActivityLogProofLine(events[0] ?? {}),
        );
        expect(JSON.stringify(events)).not.toMatch(/customfield_10103|Item one/u);
      });

      it("does not refuse an item that already exists, which a rerun only reconciles", async () => {
        const f = preflight(ORDINARY, { items: [item("one", "text")] }, "jira.draft", {
          fields: [EPIC_NAME, field("labels", "array")],
          existing: [{ key: "SYN-7", id: "7", fields: { summary: "Item one" } }],
        });
        expect(await f.run()).toBeUndefined();
      });

      it("counts a required relation another item of the draft will fill", async () => {
        const f = preflight(
          ORDINARY,
          {
            items: [
              item("epic", "text"),
              {
                ...item("story", "text"),
                parent: { fieldId: "customfield_10101", ref: "epic" },
              },
            ],
          },
          "jira.draft",
          { fields: [field("customfield_10101", "string")] },
        );
        expect(await f.run()).toBeUndefined();
        const required = preflight(
          ORDINARY,
          { items: [{ ...item("story", "text") }] },
          "jira.draft",
          { fields: [field("customfield_10101", "string", true)] },
        );
        expect(await required.run()).toMatchObject({ failedCount: 1 });
      });

      it("counts the labels and the trace a create adds itself", async () => {
        const traced = {
          ...item("story", "text"),
          fields: { summary: "Item story" },
          requirementIds: ["LH-001"],
        };
        const f = preflight(ORDINARY, { items: [traced] }, "jira.draft", {
          fields: [
            {
              ...field("labels", "array", true),
              schema: { type: "array", items: "string", system: "labels" },
            },
            field("description", "string", true),
          ],
        });
        expect(await f.run()).toBeUndefined();
      });

      it("names at most a bounded number of items and says how many it left out", async () => {
        const items = Array.from({ length: 30 }, (_, index) => item(`i${String(index)}`, "text"));
        const f = preflight(ORDINARY, { items }, "jira.draft", { fields: [EPIC_NAME] });
        const refused = (await f.run()) as { items: unknown[]; failedCount: number };
        expect(refused.items).toHaveLength(25);
        expect(refused).toMatchObject({ failedCount: 30, omittedRowCount: 5 });
      });

      it("leaves the decision to the write when Jira cannot be read", async () => {
        const f = preflight(ORDINARY, { items: [item("one", "text")] }, "jira.draft", {
          metadataFails: true,
        });
        expect(await f.run()).toBeUndefined();
      });
    });
  });

  it("refuses a single write Keiko itself would refuse before any approval", async () => {
    const sink = logs();
    const f = preflight("# Ordinary skill\n", CREATE, "jira.create", {
      fields: [field("customfield_10103", "string", true)],
    });
    expect(await f.run()).toEqual({
      outcome: "rejected",
      reason: "field-validation",
      fieldId: "customfield_10103",
      validation: "required-field",
    });
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    const events = sink.events.filter((event) => event.op === "jira.field.admission");
    expect(events[0]?.extra).toMatchObject({
      operation: "jira.create",
      refusedCount: 1,
      validations: ["required-field"],
    });
  });
});

describe("a violating write never reaches Jira under Full access (#4177)", () => {
  // Full access (`autonomous-delivery`) asks no human, so the pre-approval dry run never runs and
  // nothing claims an approval (`beforeMutation` admits): the gate in front of the Jira request is
  // the only thing between the model's arguments and a POST. The connection is built exactly as the
  // Chat catalog builds it, with the issue templates of the markdown skill library.
  const VIOLATING = { projectId: "10000", issueTypeId: "10001", fields: { summary: "Add login" } };
  const CONFORMING = {
    ...VIOLATING,
    fields: { summary: "Add login", description: "## Acceptance criteria\n* works" },
  };

  function fullAccessWrite(args: Record<string, unknown>): {
    run: () => Promise<ManagedMcpToolResult>;
    methods: () => string[];
    journal: ReturnType<typeof journalFixture>["journal"];
    intent: JiraChatToolMutationIntent;
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
      contentBase64: Buffer.from(TEMPLATE).toString("base64"),
    });
    const { journal, intent } = journalFixture();
    const state: SyntheticJira = { fields: {}, comment: "" };
    const requests: string[] = [];
    const http = vi.fn<AtlassianHttpBodyPort>((request) => {
      requests.push(request.method);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/project/10000")) return Promise.resolve(response({ key: "SYN" }));
      if (path.endsWith("/issuetype/10001"))
        return Promise.resolve(response({ id: "10001", name: "Story" }));
      if (path.includes("createmeta")) {
        const values = [
          field("project", "project", true),
          field("issuetype", "issuetype", true),
          field("summary", "string", true),
          field("description", "string"),
        ];
        return Promise.resolve(
          response({ values, start: 0, size: values.length, last: true, total: values.length }),
        );
      }
      if (request.method === "GET" && path.endsWith("/issue/SYN-1"))
        return Promise.resolve(
          response({
            id: "10001",
            key: "SYN-1",
            fields: {
              ...state.fields,
              project: { id: "10000", key: "SYN" },
              issuetype: { id: "10001", name: "Story" },
            },
          }),
        );
      return Promise.resolve(
        request.method === "GET"
          ? fixtureRead(path, state)
          : fixtureWrite(path, request.bodyJson, state, request.upload),
      );
    });
    const provider = createJiraProviderForCatalog<ManagedMcpInvocationContext>(
      () => ({
        baseUrl: "https://jira.example.invalid/context",
        deployment: "data-center",
        http: (): ReturnType<AtlassianHttpBodyPort> => {
          throw new Error("A mutation must use the journal-owned HTTP port");
        },
        issueTemplates: jiraIssueTemplateSource(store),
      }),
      ["jira.create"],
      (_operation, _args, _context, execute) =>
        executeJiraChatMutation({
          journal,
          intent,
          httpPortFactory:
            (lifecycle) =>
            (request): ReturnType<AtlassianHttpBodyPort> => {
              if (lifecycle.beforeDispatch?.(request) !== true)
                return Promise.resolve({ kind: "network-error" });
              return http(request).then((answer) => {
                if (answer.kind === "response") lifecycle.onResponse?.(request, answer.status);
                return answer;
              });
            },
          beforeEffect: () => true,
          beforeMutation: () => true,
          execute: (port) => execute(port, undefined),
        }),
    );
    return {
      journal,
      intent,
      methods: () => requests,
      run: () =>
        provider.tools()[0]?.execute(args as CatalogJsonObject, {
          invocationId: intent.invocationId,
          correlationId: intent.correlationId,
          signal: new AbortController().signal,
          beforeEffect: () => true,
        }) ?? Promise.reject(new TypeError("Missing jira.create tool")),
    };
  }

  it("sends no POST or PUT and hands the model the listed violations", async () => {
    const f = fullAccessWrite(VIOLATING);
    const result = await f.run();
    expect(result.data).toEqual({
      outcome: "rejected",
      reason: "field-validation",
      guidance: expect.stringContaining("h2. Title"),
      violations: [
        { ruleId: "section-missing", subject: "Acceptance criteria", template: "SYN/Story" },
      ],
    });
    expect(f.methods().length).toBeGreaterThan(0);
    expect(f.methods().filter((method) => method === "POST" || method === "PUT")).toEqual([]);
    expect(f.journal.find(f.intent.invocationId)).toMatchObject({ outcome: "rejected" });
  });

  it("creates the issue of a conforming write under the same mode (control)", async () => {
    const f = fullAccessWrite(CONFORMING);
    const result = await f.run();
    expect(f.methods().filter((method) => method === "POST")).toHaveLength(1);
    expect(result.data).toMatchObject({ outcome: "succeeded" });
  });
});
