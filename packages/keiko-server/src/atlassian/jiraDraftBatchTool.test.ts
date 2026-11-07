// #4173: `jira.draft-batch` runs Keiko's draft batch engine for a Chat. These tests drive the real
// handler over real Knowledge Pods, the real draft-stage tool and the real Activity Log formatter;
// only the model, the Jira HTTP port and the turn's meter are fakes.
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  createJiraDraftStore,
  type AtlassianHttpBodyPort,
  type JiraDraftStore,
  type JiraIssueTemplateSet,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type { ChatToolBatchProgress } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  parseJiraIssueTemplate,
  projectJiraDescriptionInput,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { ProviderOutputExhaustedError } from "@oscharko-dev/keiko-security";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { field, LINKS_FIELD, response } from "../../../../tests/support/jira-managed-remote.js";
import { podFixture, specification, type PodFixture } from "../_requirementSupport.js";
import type { UiHandlerDeps } from "../deps.js";
import { resetRequirementTurnCache } from "../requirement-inventory.js";
import { draftTool } from "./jiraChatCatalogRuntime.js";
import { JIRA_DRAFT_BATCH_DECLARATION } from "./jiraDraftBatchDescriptor.js";
import {
  createJiraDraftBatchExecutor,
  rulesText,
  type JiraDraftBatchContext,
} from "./jiraDraftBatchTool.js";

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const fixtures: PodFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetRequirementTurnCache();
});

const CREATE_FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  { ...field("summary", "string", true), name: "Summary" },
  field("parent", "issuelink"),
  {
    ...field("description", "string", false),
    name: "Description",
    schema: { type: "string", system: "description" },
  },
  LINKS_FIELD,
];

function template(...frontMatter: readonly string[]): JiraIssueTemplate {
  return templateFor("Acceptance criteria", ...frontMatter);
}

function templateFor(section: string, ...frontMatter: readonly string[]): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      ...frontMatter,
      "---",
      `## ${section}\n`,
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}

function connection(templates: JiraIssueTemplateSet | undefined): JiraManagedConnection {
  const http: AtlassianHttpBodyPort = (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/project/DENIED")) return Promise.resolve(response({}, 401));
    if (path.endsWith("/project/FORBID")) return Promise.resolve(response({}, 403));
    if (path.endsWith("/project/NOTYPES"))
      return Promise.resolve(
        response({
          id: "10009",
          key: "NOTYPES",
          issueTypes: [{ id: "1", name: "Sub", subtask: true }],
        }),
      );
    if (path.endsWith("/project/10000") || path.endsWith("/project/SYN"))
      return Promise.resolve(
        response({
          id: "10000",
          key: "SYN",
          issueTypes: [
            { id: "10003", name: "Epic", subtask: false },
            { id: "10002", name: "Sub-task", subtask: true },
            { id: "10001", name: "Story", subtask: false },
          ],
        }),
      );
    if (path.endsWith("/issuetype/10001"))
      return Promise.resolve(response({ id: "10001", name: "Story" }));
    if (path.includes("createmeta"))
      return Promise.resolve(
        response({
          values: CREATE_FIELDS,
          start: 0,
          size: 100,
          last: true,
          total: CREATE_FIELDS.length,
        }),
      );
    return Promise.resolve(response({}, 404));
  };
  return {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    identity: "credential-1",
    http,
    ...(templates === undefined ? {} : { issueTemplates: (): JiraIssueTemplateSet => templates }),
  };
}

const WITH_TEMPLATE: JiraIssueTemplateSet = { templates: [template()], unreadable: 0 };
const CONTEXT_TEMPLATE: JiraIssueTemplateSet = {
  templates: [templateFor("Context")],
  unreadable: 0,
};

function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function keysOf(request: GatewayCallRequest): string[] {
  const text = request.messages.map((message) => contentText(message.content)).join("\n");
  const line = /^Keys: (.*)$/mu.exec(text)?.[1];
  return line === undefined || line.length === 0 ? [] : line.split(", ");
}

function page(keys: readonly string[], section = "Acceptance criteria"): string {
  return JSON.stringify({
    items: keys.map((key) => ({
      key,
      summary: `Summary ${key}`,
      sections: { [section]: `Criteria ${key}` },
      requirementIds: ["model:invented"],
    })),
  });
}

function reply(content: string): NormalizedResponse {
  return {
    modelId: "chat-model",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 100,
      completionTokens: 120,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

type Script = (request: GatewayCallRequest, call: number) => string | Error;

interface Harness {
  readonly run: (
    args: Record<string, unknown>,
    options?: {
      readonly templates?: JiraIssueTemplateSet | undefined;
      readonly model?: boolean;
      readonly beforeEffect?: () => boolean;
      readonly signal?: AbortSignal;
      readonly budget?: { readonly nowMs: () => number; readonly deadlineAtMs: number };
    },
  ) => ReturnType<ReturnType<typeof createJiraDraftBatchExecutor>>;
  readonly requests: GatewayCallRequest[];
  readonly progress: ChatToolBatchProgress[];
  readonly confirmed: NormalizedResponse[];
  readonly store: JiraDraftStore;
  readonly chatId: string;
  readonly logs: ReturnType<typeof createBufferedServerLogSink>;
}

async function harness(
  script: Script,
  pods: Parameters<typeof podFixture>[0],
  options: { readonly bindPods?: boolean } = {},
): Promise<Harness> {
  const f = await podFixture(pods, options);
  fixtures.push(f);
  const logs = createBufferedServerLogSink();
  const requests: GatewayCallRequest[] = [];
  const progress: ChatToolBatchProgress[] = [];
  const confirmed: NormalizedResponse[] = [];
  const store = createJiraDraftStore({ newId: () => DRAFT_ID });
  const port: ModelPort = {
    call: (request) => {
      requests.push(request);
      const answer = script(request, requests.length);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(reply(answer));
    },
  };
  let modelAvailable = true;
  const deps: UiHandlerDeps = {
    ...f.deps,
    modelPortFactory: () => (modelAvailable ? port : undefined),
    activityLog: logs,
  };
  const executor = createJiraDraftBatchExecutor(deps, draftTool(deps, store));
  return {
    requests,
    progress,
    confirmed,
    store,
    chatId: f.chatId,
    logs,
    run: (args, runOptions = {}): ReturnType<ReturnType<typeof createJiraDraftBatchExecutor>> => {
      modelAvailable = runOptions.model !== false;
      const context: JiraDraftBatchContext = {
        invocationId: "inv-1",
        correlationId: "batch-correlation-1",
        signal: runOptions.signal ?? new AbortController().signal,
        beforeEffect: runOptions.beforeEffect ?? ((): boolean => true),
        mutationGuard: { check: (): boolean => true, executionBudget: runOptions.budget },
        chatId: f.chatId,
        userMessageId: "turn-1",
        knowledgeReviewModelId: () => "chat-model",
        meterModel: (model: ModelPort): ModelPort => model,
        confirmModelOperation: (response: NormalizedResponse): void => {
          confirmed.push(response);
        },
        reportBatchProgress: (item: ChatToolBatchProgress): void => {
          progress.push(item);
        },
      } as unknown as JiraDraftBatchContext;
      return executor(
        args as CatalogJsonObject,
        context,
        connection("templates" in runOptions ? runOptions.templates : WITH_TEMPLATE),
      );
    },
  };
}

const ARGS = {
  projectId: "10000",
  issueTypeId: "10001",
  granularity: "per-requirement",
  create: false,
} as const;

function proofLines(h: Harness): CatalogJsonObject[] {
  return h.logs.events
    .filter((event) => (event as { op?: string }).op === "atlassian.jira-draft-batch")
    .map(
      (event) =>
        expectActivityLogProof(
          "atlassian.jira-draft-batch.line",
          formatActivityLogProofLine(event),
        ) as CatalogJsonObject,
    );
}

function stagedItems(h: Harness): readonly CatalogJsonObject[] {
  const draft = h.store.peek(DRAFT_ID, h.chatId);
  return (draft?.items ?? []) as readonly CatalogJsonObject[];
}

function descriptionOf(item: CatalogJsonObject | undefined): string {
  const fields = item?.fields as { readonly description?: { readonly text?: string } } | undefined;
  return fields?.description?.text ?? "";
}

function firstRequest(h: Harness): GatewayCallRequest {
  const [first] = h.requests;
  if (first === undefined) throw new Error("Expected a model call");
  return first;
}

function promptOf(request: GatewayCallRequest): string {
  return request.messages.map((message) => contentText(message.content)).join("\n");
}

describe("jira.draft-batch (#4173)", () => {
  it("drafts every requirement of the Pod through the real draft-stage tool", async () => {
    const spec = specification(5);
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: spec.text }],
    );

    const result = await h.run({ ...ARGS, create: true, guidance: "Write in German." });

    expect(result.isError).not.toBe(true);
    expect(
      describeCatalogSchemaMismatch(
        JIRA_DRAFT_BATCH_DECLARATION.descriptor.resultSchema,
        result.data,
      ),
    ).toBeUndefined();
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      draftId: DRAFT_ID,
      newDraft: true,
      itemCount: 5,
      plannedCount: 5,
      draftedCount: 5,
      failedCount: 0,
      requirementCount: 5,
      coveredRequirementCount: 5,
      failedRequirementRefs: [],
      createRequested: true,
      unresolvedRefCount: 0,
      unresolvedRefs: [],
    });
    const items = stagedItems(h);
    expect(items).toHaveLength(5);
    // Keiko, not the model, owns the requirement references: the model's invented one is gone.
    const references = items.flatMap((item) => item.requirementIds as string[]);
    expect(references.sort()).toEqual(
      spec.ids.map((id): string => references.find((ref) => ref.endsWith(id)) ?? "").sort(),
    );
    expect(references).toHaveLength(spec.ids.length);
    expect(references).not.toContain("model:invented");
    // The source criteria are written by Keiko verbatim, so the source trace accepts every issue.
    const fields = items[0]?.fields as { readonly description: { readonly text: string } };
    expect(fields.description.text).toContain("Thema 1 ist verfügbar.");
    expect(items.every((item) => item.projectId === "10000")).toBe(true);
    // The model confirmed each page it used, so tens of pages cannot exhaust the synthesis grant.
    expect(h.confirmed).toHaveLength(h.requests.length);
  });

  it("asks every page and outline call for no reasoning", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    await h.run(ARGS);

    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) {
      expect(request.reasoningPreference).toBe("off");
      expect(request.reasoningEffort).toBeUndefined();
    }
  });

  it("puts the issue template and the person's guidance into the page prompt", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    await h.run({ ...ARGS, guidance: "Write in German." });

    const prompt = promptOf(h.requests[0] ?? ({ messages: [] } as unknown as GatewayCallRequest));
    expect(prompt).toContain("Acceptance criteria");
    expect(prompt).toContain("Write in German.");
    expect(prompt).toContain('"operation":"create"');
    expect(h.requests[0]?.temperature).toBe(0);
    expect(h.requests[0]?.stream).toBe(false);
  });

  it("reports counted progress ending in the complete phase", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );

    await h.run(ARGS);

    expect(h.progress.at(-1)).toEqual({
      phase: "complete",
      draftedCount: 3,
      plannedCount: 3,
      coveredRequirementCount: 3,
      requirementCount: 3,
      failedCount: 0,
    });
    expect(h.progress.map((item) => item.phase)).toContain("drafting");
  });

  it("splits a page whose answer ran out of output until every issue is drafted", async () => {
    const h = await harness(
      (request) =>
        keysOf(request).length > 1
          ? new ProviderOutputExhaustedError("chat-model")
          : page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(4).text }],
    );

    const result = await h.run(ARGS);

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 4, failedCount: 0 });
    expect(stagedItems(h)).toHaveLength(4);
    const lines = proofLines(h);
    expect(lines.some((line) => line.phase === "page" && line.outcome === "split")).toBe(true);
    expect(lines.some((line) => line.phase === "page" && line.outcome === "exhausted")).toBe(false);
  });

  it("names the requirements it could not draft and leaves the others staged", async () => {
    const spec = specification(3);
    const h = await harness(
      (request) =>
        request.messages.some((m) => contentText(m.content).includes("LH-002"))
          ? new ProviderOutputExhaustedError("chat-model")
          : page(keysOf(request)),
      [{ capsuleId: "cap-a", text: spec.text }],
    );

    const result = await h.run(ARGS);

    expect(result.data).toMatchObject({
      outcome: "succeeded",
      draftedCount: 2,
      failedCount: 1,
      coveredRequirementCount: 2,
    });
    expect(result.data.failedRequirementRefs).toEqual([expect.stringContaining("LH-002")]);
    expect(result.data.guidance).toEqual(expect.stringContaining("retry"));
  });

  it("writes the template's acceptance-criteria section itself and tells the model not to", async () => {
    // The model's own text for the section is never used: the criteria stand there verbatim.
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run(ARGS);

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    expect(promptOf(firstRequest(h))).toContain("Required sections: []");
    const description = descriptionOf(stagedItems(h)[0]);
    expect(description).toContain(
      "## Acceptance criteria\n\n- Thema 1 ist verfügbar.\n- Fehler zu Thema 1 werden gemeldet.",
    );
    expect(description).not.toContain("Criteria ");
    expect(description.match(/Thema 1 ist verfügbar/gu)).toHaveLength(1);
  });

  it("accepts a German acceptance-criteria section from a model that wrote no sections", async () => {
    const h = await harness(
      (request) =>
        JSON.stringify({
          items: keysOf(request).map((key) => ({ key, summary: `Summary ${key}`, sections: {} })),
        }),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run(ARGS, {
      templates: { templates: [templateFor("Akzeptanzkriterien")], unreadable: 0 },
    });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    expect(h.requests).toHaveLength(1);
    expect(descriptionOf(stagedItems(h)[0])).toContain("## Akzeptanzkriterien\n\n- Thema 1");
  });

  it("asks for the criteria section only for an issue whose requirements carry none", async () => {
    // Requirement 9 has no criteria, so its issue needs the model's own text for the section.
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(9).text }],
    );

    const result = await h.run({ ...ARGS, requirements: { ids: ["LH-008", "LH-009"] } });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    expect(promptOf(firstRequest(h))).toContain('Also write the sections ["Acceptance criteria"]');
    const [first, second] = stagedItems(h);
    expect(descriptionOf(first)).toContain("- Thema 8 ist verfügbar.");
    expect(descriptionOf(second)).toContain("Criteria ");
  });

  it("appends a list in the document's language when the template has no criteria section", async () => {
    const h = await harness(
      (request) => page(keysOf(request), "Context"),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run(ARGS, { templates: CONTEXT_TEMPLATE });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    const description = descriptionOf(stagedItems(h)[0]);
    expect(description).toContain("## Context\n\nCriteria ");
    expect(description).toContain("## Akzeptanzkriterien\n\n- Thema 1 ist verfügbar.");
    // Jira receives it as headings and a bullet list.
    const wiki = projectJiraDescriptionInput({ format: "markdown", text: description })?.text ?? "";
    expect(wiki).toContain(
      "h2. Akzeptanzkriterien\n\n* Thema 1 ist verfügbar.\n* Fehler zu Thema 1",
    );
  });

  it("groups requirements into one issue that names all of them", async () => {
    const h = await harness(
      (request) =>
        String(request.messages[0]?.content).startsWith("You group requirements")
          ? JSON.stringify({
              groups: [
                {
                  summary: "Claims intake",
                  requirements: promptOf(request)
                    .split("Requirements:\n")[1]
                    ?.split("\n")
                    .map((line) => line.split(" | ")[0]),
                },
              ],
            })
          : page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );

    const result = await h.run({
      ...ARGS,
      granularity: "grouped",
      grouping: "one epic for everything",
    });

    expect(result.data).toMatchObject({
      outcome: "succeeded",
      plannedCount: 1,
      draftedCount: 1,
      requirementCount: 3,
      coveredRequirementCount: 3,
    });
    expect(stagedItems(h)[0]?.requirementIds).toHaveLength(3);
    expect(proofLines(h).some((line) => line.phase === "outline")).toBe(true);
  });

  it("refuses when the stored issue templates cannot be read", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run(ARGS, { templates: { templates: [], unreadable: 1 } });

    expect(result.data.reason).toBe("template-unavailable");
    expect(h.requests).toHaveLength(0);
  });

  it("resolves a project key and an omitted issue type before drafting", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run({ projectId: "SYN", granularity: "per-requirement", create: false });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    const items = stagedItems(h);
    expect(items.every((item) => item.projectId === "10000" && item.issueTypeId === "10001")).toBe(
      true,
    );
  });

  it("names the available issue types when the type is not in the project", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run({ ...ARGS, issueTypeId: "Saga" });

    expect(result.data.availableIssueTypes).toEqual(["Epic", "Story"]);
    expect(result.data.guidance).toContain("availableIssueTypes");
  });

  it("resolves a lower-case project key", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );
    const result = await h.run({ ...ARGS, projectId: "syn", issueTypeId: undefined });
    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
  });

  it.each(["DENIED", "FORBID"])(
    "reports an unreadable project (%s) as unavailable, not as unknown",
    async (projectId) => {
      const h = await harness(
        (request) => page(keysOf(request)),
        [{ capsuleId: "cap-a", text: specification(2).text }],
      );
      const result = await h.run({ ...ARGS, projectId });
      expect(result.data.reason).toBe("template-unavailable");
      expect(h.requests).toHaveLength(0);
    },
  );

  it("refuses a project with only subtask types with its own closed reason", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );
    const result = await h.run({ ...ARGS, projectId: "NOTYPES", issueTypeId: undefined });
    expect(result.data.reason).toBe("no-usable-issue-type");
    expect(result.data.availableIssueTypes).toBeUndefined();
  });

  it("keeps issue type and document names out of the Activity Log", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );
    const typeRefusal = await h.run({ ...ARGS, issueTypeId: "Saga" });
    const filterRefusal = await h.run({ ...ARGS, requirements: { ids: ["NOPE-1"] } });
    const scopes = filterRefusal.data.availableDocuments as string[];
    const log = JSON.stringify(proofLines(h));
    expect(typeRefusal.data.availableIssueTypes).toEqual(["Epic", "Story"]);
    expect(scopes.length).toBeGreaterThan(0);
    for (const secret of ["Saga", "Epic", "Story", ...scopes]) expect(log).not.toContain(secret);
  });

  it("tells a model whose filter matched nothing how many requirements it can draft", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );

    const result = await h.run({ ...ARGS, requirements: { ids: ["NOPE-1"] } });

    expect(result.data).toMatchObject({ reason: "no-requirements", availableRequirementCount: 3 });
    expect(result.data.guidance).toContain("Omit requirements to draft all 3.");
    expect(result.data.availableDocuments).toHaveLength(1);
    expect(proofLines(h)).toEqual([
      expect.objectContaining({ refusal: "no-requirements", requirementCount: 3 }),
    ]);
  });

  it("pauses at the deadline with the draft kept, and a re-run drafts only the rest", async () => {
    let now = 0;
    const h = await harness(
      (request) => {
        now += 100_000;
        return page(keysOf(request));
      },
      [{ capsuleId: "cap-a", text: specification(60).text }],
    );

    const first = await h.run(ARGS, { budget: { nowMs: () => now, deadlineAtMs: 200_000 } });

    expect(first.isError).not.toBe(true);
    const drafted = Number(first.data.draftedCount);
    expect(first.data).toMatchObject({ outcome: "succeeded", paused: true, draftId: DRAFT_ID });
    expect(drafted).toBeGreaterThan(0);
    expect(drafted).toBeLessThan(60);
    expect(first.data.remainingCount).toBe(60 - drafted);
    expect(first.data.remainingRequirementIds).toHaveLength(60 - drafted);
    expect(first.data.guidance).toEqual(expect.stringContaining("call jira_draft_batch again"));
    expect(
      describeCatalogSchemaMismatch(
        JIRA_DRAFT_BATCH_DECLARATION.descriptor.resultSchema,
        first.data,
      ),
    ).toBeUndefined();
    expect(proofLines(h).at(-1)).toMatchObject({ phase: "completed", stopReason: "deadline" });

    now = 0;
    const second = await h.run(
      { ...ARGS, draftId: DRAFT_ID },
      { budget: { nowMs: () => now, deadlineAtMs: 100_000_000 } },
    );

    expect(second.data).toMatchObject({ outcome: "succeeded", requirementCount: 60 - drafted });
    expect(second.data.paused).toBeUndefined();
    const covered = stagedItems(h).flatMap((item) => item.requirementIds as string[]);
    expect(covered).toHaveLength(60);
    expect(new Set(covered).size).toBe(60);
  });

  it("leaves a batch that fits its deadline unchanged", async () => {
    let now = 0;
    const h = await harness(
      (request) => {
        now += 100_000;
        return page(keysOf(request));
      },
      [{ capsuleId: "cap-a", text: specification(60).text }],
    );

    const result = await h.run(ARGS, {
      budget: { nowMs: () => now, deadlineAtMs: 100_000_000 },
    });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 60, failedCount: 0 });
    expect(result.data.paused).toBeUndefined();
  });

  it("limits the batch to the requirements the filter names", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(6).text }],
    );

    const result = await h.run({ ...ARGS, requirements: { ids: ["LH-002", "LH-005"] } });

    expect(result.data).toMatchObject({ requirementCount: 2, draftedCount: 2 });
  });

  it("maps a draft that cannot continue to a failed result with the closed reason", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run({ ...ARGS, draftId: "99999999-2222-4333-8444-555555555555" });

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ outcome: "failed", reason: "draft-not-found" });
    const completed = proofLines(h).find((line) => line.phase === "completed");
    expect(completed).toMatchObject({
      outcome: "failed",
      stopReason: "stage-failed",
      level: "warn",
    });
  });

  it("corrects a page the draft-stage tool rejected, with the violations it named", async () => {
    // The first answer omits the required section; the second follows the correction.
    const h = await harness(
      (request, call) =>
        call === 1
          ? JSON.stringify({
              items: keysOf(request).map((key) => ({
                key,
                summary: `Summary ${key}`,
                sections: { Other: "x" },
              })),
            })
          : page(keysOf(request), "Context"),
      [{ capsuleId: "cap-a", text: specification(1).text }],
    );

    const result = await h.run(ARGS, { templates: CONTEXT_TEMPLATE });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 1 });
    expect(h.requests.length).toBeGreaterThan(1);
    expect(
      promptOf(h.requests[1] ?? ({ messages: [] } as unknown as GatewayCallRequest)),
    ).toContain("refused");
  });

  it.each([
    ["no Knowledge Pod", { bindPods: false }, ARGS, "no-knowledge-pod"],
    [
      "no matching requirement",
      {},
      { ...ARGS, requirements: { ids: ["NOPE-1"] } },
      "no-requirements",
    ],
    ["malformed arguments", {}, { ...ARGS, projectId: "not a key!" }, "invalid-input"],
    ["unknown project", {}, { ...ARGS, projectId: "NOPE" }, "project-not-found"],
    ["unknown issue type", {}, { ...ARGS, issueTypeId: "Saga" }, "issue-type-not-found"],
  ] as const)(
    "refuses %s with a closed reason and no model call",
    async (_name, options, args, reason) => {
      const h = await harness(
        (request) => page(keysOf(request)),
        [{ capsuleId: "cap-a", text: specification(2).text }],
        options,
      );

      const result = await h.run(args);

      expect(result.isError).toBe(true);
      expect(result.data.reason).toBe(reason);
      expect(h.requests).toHaveLength(0);
      expect(proofLines(h)).toEqual([
        expect.objectContaining({ phase: "refused", refusal: reason, level: "warn" }),
      ]);
    },
  );

  it("corrects a page the draft-stage tool refused for a template violation", async () => {
    const strict: JiraIssueTemplateSet = {
      templates: [template("summaryMinLength: 30")],
      unreadable: 0,
    };
    const h = await harness(
      (request, call) =>
        call === 1
          ? page(keysOf(request))
          : JSON.stringify({
              items: keysOf(request).map((key) => ({
                key,
                summary: `A summary of ${key} that is long enough`,
                sections: { "Acceptance criteria": "c" },
              })),
            }),
      [{ capsuleId: "cap-a", text: specification(1).text }],
    );

    const result = await h.run(ARGS, { templates: strict });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 1 });
    const correction = promptOf(
      h.requests[1] ?? ({ messages: [] } as unknown as GatewayCallRequest),
    );
    expect(correction).toContain("violations");
    expect(proofLines(h).some((line) => line.phase === "page" && line.outcome === "refused")).toBe(
      true,
    );
  });

  it("refuses when the turn has no model", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run(ARGS, { model: false });

    expect(result.data.reason).toBe("model-unavailable");
  });

  it("records a started, outline-free batch as body-free lines under the call's correlation", async () => {
    const spec = specification(3);
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: spec.text }],
    );

    await h.run({ ...ARGS, create: true });

    const lines = proofLines(h);
    expect(lines.map((line) => line.phase)).toEqual(["started", "page", "completed"]);
    expect(lines.every((line) => line.correlationId === "batch-correlation-1")).toBe(true);
    expect(lines[0]).toMatchObject({
      granularity: "per-requirement",
      requirementCount: 3,
      createRequested: true,
    });
    expect(lines[2]).toMatchObject({
      outcome: "succeeded",
      plannedCount: 3,
      draftedCount: 3,
      failedCount: 0,
    });
    const text = h.logs.events.map((event) => formatActivityLogProofLine(event)).join("\n");
    expect(text).not.toContain("Thema");
    expect(text).not.toContain("LH-");
    expect(analyzeLogText(text).timelines.length).toBeGreaterThan(0);
  });

  it("returns a partial result when the model fails, with a body-free failure line", async () => {
    const h = await harness(
      (request, call) =>
        call === 1
          ? page(keysOf(request))
          : new Error("provider exploded: SECRET-TEXT", {
              cause: new TypeError("inner SECRET-TEXT"),
            }),
      [{ capsuleId: "cap-a", text: specification(25).text }],
    );

    const result = await h.run(ARGS);

    const drafted = Number(result.data.draftedCount);
    expect(result.data).toMatchObject({ outcome: "succeeded", draftId: DRAFT_ID });
    expect(drafted).toBeGreaterThan(0);
    expect(drafted).toBeLessThan(25);
    expect(result.data.failedCount).toBe(25 - drafted);
    expect((result.data.failedRequirementRefs as string[]).length).toBe(25 - drafted);
    expect(result.data.guidance).toEqual(expect.stringContaining("model failed"));
    const completed = proofLines(h).find((line) => line.phase === "completed");
    expect(completed).toMatchObject({ stopReason: "model-failed", outcome: "partial" });
    expect(completed?.frames).toBeTruthy();
    expect(completed?.causeChain).toBeTruthy();
    const text = h.logs.events.map((event) => formatActivityLogProofLine(event)).join("\n");
    expect(text).not.toContain("SECRET-TEXT");
  });

  it("reports a failed result when the model fails before anything is drafted", async () => {
    const h = await harness(
      () => new Error("provider exploded"),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );
    const result = await h.run(ARGS);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ outcome: "failed", reason: "model-failed" });
  });

  it("records an unexpected failure with its Keiko frames and rethrows it", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    await expect(h.run(ARGS, { beforeEffect: () => false })).rejects.toThrow();

    const failed = proofLines(h).find((line) => line.phase === "failed");
    expect(failed).toMatchObject({ level: "warn", errorKind: "internal" });
    expect((failed?.frames as unknown[] | undefined)?.length).toBeGreaterThan(0);
    const text = h.logs.events.map((event) => formatActivityLogProofLine(event)).join("\n");
    expect(text).not.toContain("effect-denied");
  });

  it("ends a cancelled batch with a closed terminal line", async () => {
    const controller = new AbortController();
    const h = await harness(
      (request) => {
        controller.abort(new Error("user stop"));
        return page(keysOf(request));
      },
      [{ capsuleId: "cap-a", text: specification(25).text }],
    );

    await expect(h.run(ARGS, { signal: controller.signal })).rejects.toThrow();

    const lines = proofLines(h);
    expect(lines.map((line) => line.phase)).toEqual(["started", "failed"]);
    expect(lines[1]).toMatchObject({ stopReason: "cancelled", errorKind: "cancelled" });
  });

  it("reports requirements that share a reference instead of dropping them silently", async () => {
    const spec = specification(2);
    const text = `${spec.text}\n### LH-001 Doppelt\n\nZweite Fassung.\n`;
    const h = await harness((request) => page(keysOf(request)), [{ capsuleId: "cap-a", text }]);
    const result = await h.run(ARGS);
    const failed = result.data.failedRequirementRefs as string[];
    if (failed.length > 0) {
      expect(failed.some((ref) => ref.endsWith("LH-001"))).toBe(true);
      expect(Number(result.data.failedCount)).toBeGreaterThan(0);
    }
    expect(Number(result.data.requirementCount)).toBeGreaterThanOrEqual(2);
  });
});

describe("rulesText", () => {
  const rules = (facts: readonly unknown[]): Parameters<typeof rulesText>[0] =>
    ({ facts }) as unknown as Parameters<typeof rulesText>[0];

  it("keeps whole templates and valid JSON when the rules run long", () => {
    const big = { name: "x".repeat(2000) };
    const text = rulesText(rules([big, big, big]));
    expect(JSON.parse(text)).toEqual([big]);
  });

  it("is empty JSON when nothing fits and passes short rules unchanged", () => {
    expect(rulesText(rules([]))).toBe("{}");
    expect(rulesText(rules([{ a: 1 }]))).toBe('[{"a":1}]');
    expect(rulesText(rules([{ name: "x".repeat(20_000) }]))).toBe("{}");
  });
});
