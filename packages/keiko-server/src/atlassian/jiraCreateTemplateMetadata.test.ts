import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort, JiraManagedConnection } from "@oscharko-dev/keiko-connectors";
import type { MarkdownSkillDocument } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { field, response } from "../../../../tests/support/jira-managed-remote.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { jiraIssueTemplateSource, recordJiraTemplateMetadata } from "./jiraTemplateLog.js";

const close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup();
});
const SECTIONS = ["Anforderung", "Akzeptanzkriterien", "Quelle"];

function template(type: string, project = "SYN", sections: readonly string[] = SECTIONS): string {
  return [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    `project: ${project}`,
    `issueType: ${type}`,
    "activateOn: [create]",
    "requiredFields: [Description, Epic Link]",
    "requiredLabels: [reviewed]",
    "summaryMinLength: 4",
    "parentField: Epic Link",
    "---",
    `# ${type}`,
    "PRIVATE_TEMPLATE_BODY_NOT_IN_METADATA",
    ...sections.map((section) => `## ${section}`),
  ].join("\n");
}

interface TemplateReadFixture {
  readonly store: ReturnType<typeof buildUiStoreOverDatabase>;
  readonly chatId: string;
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly connection: JiraManagedConnection;
  readonly beforeEffect: ReturnType<typeof vi.fn<() => boolean>>;
  readonly add: (markdown: string) => MarkdownSkillDocument;
  readonly read: (args?: CatalogJsonObject) => Promise<ManagedMcpToolResult>;
}

function metadataHttp(): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> {
  return vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/project/SYN"))
      return Promise.resolve(response({ id: "10000", key: "SYN" }));
    if (path.endsWith("/issuetype/10003"))
      return Promise.resolve(response({ id: "10003", name: "Task" }));
    return Promise.resolve(
      response({
        startAt: 0,
        maxResults: 25,
        total: 1,
        isLast: true,
        values: [{ ...field("description", "string"), name: "Description" }],
      }),
    );
  });
}

function managedReader(
  connection: JiraManagedConnection,
  beforeEffect: () => boolean,
): TemplateReadFixture["read"] {
  const provider = createJiraProviderForCatalog(() => connection, ["jira.create-fields"]);
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing create-fields tool");
  return async (
    args = { projectKey: "SYN", issueTypeId: "10003" },
  ): Promise<ManagedMcpToolResult> => {
    const result = await tool.execute(args, {
      invocationId: "template-discovery",
      correlationId: "template-discovery",
      signal: new AbortController().signal,
      beforeEffect,
    });
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, result.data),
    ).toBeUndefined();
    return result;
  };
}

function fixture(): TemplateReadFixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "keiko-template-discovery-")));
  close.push(() => {
    store.close();
    rmSync(projectPath, { recursive: true, force: true });
  });
  store.createProject(projectPath);
  const chat = store.createChat(projectPath, "Synthetic", "synthetic-model");
  const sink = createBufferedServerLogSink();
  const beforeEffect = vi.fn(() => true);
  const http = metadataHttp();
  const connection: JiraManagedConnection = {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http,
    issueTemplates: jiraIssueTemplateSource(store),
    templateMetadataActivity: (activity) => {
      recordJiraTemplateMetadata(sink, "template-discovery", activity);
    },
  };
  const read = managedReader(connection, beforeEffect);
  return {
    store,
    chatId: chat.id,
    http,
    sink,
    connection,
    beforeEffect,
    add: (markdown) =>
      store.markdownSkills.import({
        fileName: "template.md",
        contentBase64: Buffer.from(markdown).toString("base64"),
      }),
    read: async (args): Promise<ManagedMcpToolResult> => {
      const result = await read(args);
      expect(
        http.mock.calls.every(
          ([request]) => request.method === "GET" && request.bodyJson === undefined,
        ),
      ).toBe(true);
      return result;
    },
  };
}

describe("applicable create template metadata through the managed read", () => {
  it("reveals a non-selected Task template before any stage or write, excluding foreign matches", async () => {
    const f = fixture();
    const epic = f.add(template("Epic"));
    const task = f.add(template("Task"));
    f.add(template("Task", "FOREIGN"));
    f.add(template("Story"));
    f.store.markdownSkills.select(f.chatId, epic, 0);
    const result = await f.read();
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      applicableTemplates: {
        matchedCount: 1,
        omittedCount: 0,
        unreadableCount: 0,
        complete: true,
        items: [
          {
            project: "SYN",
            issueType: "Task",
            operation: "create",
            source: { id: task.id, revision: task.revision, digest: task.digest },
            requiredFields: ["Description", "Epic Link"],
            requiredSections: SECTIONS,
            summary: { minLength: 4 },
            labels: { required: ["reviewed"] },
            parent: { field: "Epic Link" },
          },
        ],
      },
    });
    expect(f.store.markdownSkills.selection(f.chatId).skill?.id).toBe(epic.id);
    expect(
      createJiraProviderForCatalog(() => f.connection, ["jira.create-fields"]).tools()[0]
        ?.descriptor.toolRef.contractVersion,
    ).toBe(4);
    expect(JSON.stringify(result.data)).not.toContain("PRIVATE_TEMPLATE_BODY_NOT_IN_METADATA");
    const metadata = f.sink.events.find((event) => event.op === "jira.template.metadata");
    expect(metadata?.extra).toMatchObject({ matchedCount: 1, returnedCount: 1, omittedCount: 0 });
    expectActivityLogProof(
      "jira.template.metadata.line",
      formatActivityLogProofLine(metadata ?? {}),
    );
    expect(JSON.stringify(f.sink.events)).not.toContain("Akzeptanzkriterien");
  });

  it("explicitly reports a complete empty rule set using only its existing field read", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result.data.applicableTemplates).toEqual({
      items: [],
      matchedCount: 0,
      omittedCount: 0,
      unreadableCount: 0,
      complete: true,
    });
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      startAt: 0,
      total: 1,
      draft: { tool: "jira.draft" },
    });
    expect(result.data).toMatchObject({
      items: [
        {
          id: "description",
          nativeFormat: "jira-wiki",
          markdownSerialization: "supported-markdown",
          inputSchema: {
            oneOf: [
              { type: "string", maxLength: 32768 },
              {
                type: "object",
                additionalProperties: false,
                required: ["format", "text"],
                properties: {
                  format: { type: "string", enum: ["markdown"] },
                  text: { type: "string", maxLength: 32768 },
                },
              },
            ],
          },
        },
      ],
    });
    expect(f.http).toHaveBeenCalledOnce();
  });

  it("distinguishes no matching rule from incomplete rule metadata", async () => {
    const f = fixture();
    f.add(template("Task", "FOREIGN"));
    expect((await f.read()).data.applicableTemplates).toEqual({
      items: [],
      matchedCount: 0,
      omittedCount: 0,
      unreadableCount: 0,
      complete: true,
    });
    expect(f.http).toHaveBeenCalledTimes(3);
  });

  it("does not repeat rule identity reads or metadata logs on a later field page", async () => {
    const f = fixture();
    f.add(template("Task"));
    await f.read();
    expect(f.http).toHaveBeenCalledTimes(3);
    const result = await f.read({
      projectKey: "SYN",
      issueTypeId: "10003",
      startAt: 25,
      maxResults: 25,
    });
    expect(result.data).not.toHaveProperty("applicableTemplates");
    expect(f.http).toHaveBeenCalledTimes(4);
    expect(f.sink.events.filter((event) => event.op === "jira.template.metadata")).toHaveLength(1);
  });

  it("does not claim complete rule metadata when an exact source reference is missing", async () => {
    const f = fixture();
    f.add(template("Task"));
    const original = f.connection.issueTemplates;
    if (original === undefined) throw new TypeError("Missing rule source");
    Object.assign(f.connection, { issueTemplates: () => ({ ...original(), references: [] }) });
    expect((await f.read()).data.applicableTemplates).toEqual({
      items: [],
      matchedCount: 1,
      omittedCount: 1,
      unreadableCount: 0,
      complete: false,
    });
  });

  it("reads the current stored revision after the actor-bound identity reads", async () => {
    const f = fixture();
    const task = f.add(template("Task"));
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new TypeError("Missing read transport");
    let current = task;
    f.http.mockImplementation((request) => {
      if (new URL(request.url).pathname.endsWith("/issuetype/10003")) {
        current = f.store.markdownSkills.replace(task.id, task.revision, {
          fileName: "template.md",
          contentBase64: Buffer.from(template("Task", "SYN", ["Current section"])).toString(
            "base64",
          ),
        });
      }
      return original(request);
    });
    const result = await f.read();
    expect(result.data.applicableTemplates).toMatchObject({
      items: [
        {
          source: { id: task.id, revision: 2, digest: current.digest },
          requiredSections: ["Current section"],
        },
      ],
    });
  });

  it("bounds whole matching templates and preserves each exact source reference", async () => {
    const f = fixture();
    const stored = Array.from({ length: 9 }, (_, number) => {
      const sections = [...SECTIONS, `Specific rule ${String(number)}`];
      return { skill: f.add(template("Task", "SYN", sections)), sections };
    });
    const result = await f.read();
    const facts = result.data.applicableTemplates as CatalogJsonObject;
    const items = facts.items as readonly CatalogJsonObject[];
    expect(facts).toMatchObject({ matchedCount: 9, omittedCount: 1, complete: false });
    expect(items).toHaveLength(8);
    for (const item of items) {
      const source = item.source as CatalogJsonObject;
      const expected = stored.find(({ skill }) => skill.id === source.id);
      expect(expected).toBeDefined();
      expect(item.requiredSections).toEqual(expected?.sections);
      expect(source).toEqual({
        id: expected?.skill.id,
        revision: expected?.skill.revision,
        digest: expected?.skill.digest,
      });
    }
  });

  it("keeps separate stored revision references when replacement produces equal template bodies", async () => {
    const f = fixture();
    const body = template("Task");
    const first = f.add(body);
    const different = f.add(template("Task", "SYN", ["Different section"]));
    const second = f.store.markdownSkills.replace(different.id, different.revision, {
      fileName: "template.md",
      contentBase64: Buffer.from(body).toString("base64"),
    });
    const result = await f.read();
    const facts = result.data.applicableTemplates as CatalogJsonObject;
    const items = facts.items as readonly CatalogJsonObject[];
    expect(facts).toMatchObject({ matchedCount: 2, omittedCount: 0, complete: true });
    expect(items.map((item) => item.source)).toEqual(
      expect.arrayContaining(
        [first, second].map((skill) => ({
          id: skill.id,
          revision: skill.revision,
          digest: skill.digest,
        })),
      ),
    );
    expect(new Set(items.map((item) => (item.source as CatalogJsonObject).id)).size).toBe(2);
  });

  it("reports a byte-bound omission without cutting required sections or labels", async () => {
    const f = fixture();
    const sections = Array.from({ length: 50 }, (_, number) =>
      `Section ${String(number)} `.padEnd(120, "x"),
    );
    const labels = Array.from({ length: 50 }, (_, number) =>
      `label-${String(number)}-`.padEnd(255, "x"),
    );
    f.add(
      template("Task", "SYN", sections).replace(
        "requiredLabels: [reviewed]",
        `requiredLabels: [${labels.join(", ")}]`,
      ),
    );
    expect((await f.read()).data.applicableTemplates).toMatchObject({
      items: [],
      matchedCount: 1,
      omittedCount: 1,
      complete: false,
    });
  });

  it("exposes unreadable rules as unavailable instead of an empty applicable set", async () => {
    const f = fixture();
    Object.assign(f.connection, { issueTemplates: () => ({ templates: [], unreadable: 1 }) });
    expect((await f.read()).data).toMatchObject({
      outcome: "failed",
      reason: "template-unreadable",
      applicableTemplates: { complete: false, unreadableCount: 1 },
    });
  });

  it("refuses publication when the authority changes during identity resolution", async () => {
    const f = fixture();
    f.add(template("Task"));
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new TypeError("Missing read transport");
    f.http.mockImplementation((request) => {
      if (new URL(request.url).pathname.endsWith("/issuetype/10003"))
        f.beforeEffect.mockReturnValue(false);
      return original(request);
    });
    const result = await f.read();
    expect(result.data).toMatchObject({ outcome: "failed", reason: "permission-denied" });
    expect(result.data).not.toHaveProperty("applicableTemplates");
  });
});
