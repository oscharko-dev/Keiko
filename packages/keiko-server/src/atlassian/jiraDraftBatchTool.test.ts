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
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { ProviderOutputExhaustedError } from "@oscharko-dev/keiko-security";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { afterEach, describe, expect, it } from "vitest";
import { batchDraftDecision } from "../chat-tool-batch-draft.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  field,
  LABEL_FIELD,
  LINKS_FIELD,
  response,
} from "../../../../tests/support/jira-managed-remote.js";
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
  LABEL_FIELD,
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

function connection(
  templates: JiraIssueTemplateSet | undefined,
  createFields: readonly Record<string, unknown>[],
): JiraManagedConnection {
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
          values: createFields,
          start: 0,
          size: 100,
          last: true,
          total: createFields.length,
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
      readonly createFields?: readonly Record<string, unknown>[];
      readonly model?: boolean;
      readonly beforeEffect?: () => boolean;
      readonly signal?: AbortSignal;
      readonly citationSources?: () => ReadonlyMap<number, string>;
      readonly budget?: { readonly nowMs: () => number; readonly deadlineAtMs: number };
    },
  ) => ReturnType<ReturnType<typeof createJiraDraftBatchExecutor>>;
  readonly requests: GatewayCallRequest[];
  readonly answers: string[];
  readonly progress: ChatToolBatchProgress[];
  readonly confirmed: NormalizedResponse[];
  readonly store: JiraDraftStore;
  readonly chatId: string;
  readonly logs: ReturnType<typeof createBufferedServerLogSink>;
}

async function harness(
  script: Script,
  pods: Parameters<typeof podFixture>[0],
  options: { readonly bindPods?: boolean; readonly storeNow?: () => number } = {},
): Promise<Harness> {
  const f = await podFixture(pods, options);
  fixtures.push(f);
  const logs = createBufferedServerLogSink();
  const requests: GatewayCallRequest[] = [];
  const answers: string[] = [];
  const progress: ChatToolBatchProgress[] = [];
  const confirmed: NormalizedResponse[] = [];
  const store = createJiraDraftStore({
    newId: () => DRAFT_ID,
    ...(options.storeNow === undefined ? {} : { now: options.storeNow }),
  });
  const port: ModelPort = {
    call: (request) => {
      requests.push(request);
      const answer = script(request, requests.length);
      if (typeof answer === "string") answers.push(answer);
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
    answers,
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
        ...(runOptions.citationSources === undefined
          ? {}
          : { citationSources: runOptions.citationSources }),
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
        connection(
          "templates" in runOptions ? runOptions.templates : WITH_TEMPLATE,
          runOptions.createFields ?? CREATE_FIELDS,
        ),
      ).then((result) => {
        // Every result must pass the descriptor the managed MCP host enforces; an undeclared
        // field refused all 370 drafted Epics in a live run (#4288).
        expect(
          describeCatalogSchemaMismatch(
            JIRA_DRAFT_BATCH_DECLARATION.descriptor.resultSchema,
            result.data,
          ),
        ).toBeUndefined();
        return result;
      });
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

interface PausingRun {
  readonly h: Harness;
  /** A call whose model takes long enough that the batch pauses at its deadline. */
  readonly pause: (args: Record<string, unknown>) => ReturnType<Harness["run"]>;
  /** A call with time enough for the whole selection. */
  readonly finish: (args: Record<string, unknown>) => ReturnType<Harness["run"]>;
}

async function pausingHarness(spec: number, storeNow?: () => number): Promise<PausingRun> {
  let now = 0;
  const h = await harness(
    (request) => {
      now += 100_000;
      return page(keysOf(request));
    },
    [{ capsuleId: "cap-a", text: specification(spec).text }],
    storeNow === undefined ? {} : { storeNow },
  );
  return {
    h,
    pause: (args): ReturnType<Harness["run"]> => {
      now = 0;
      return h.run(args, { budget: { nowMs: () => now, deadlineAtMs: 200_000 } });
    },
    finish: (args): ReturnType<Harness["run"]> => {
      now = 0;
      return h.run(args, { budget: { nowMs: () => now, deadlineAtMs: 100_000_000 } });
    },
  };
}

function descriptionOf(item: CatalogJsonObject | undefined): string {
  const fields: unknown = item?.fields;
  if (
    fields === null ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    !("description" in fields) ||
    typeof fields.description !== "string"
  )
    throw new TypeError("Expected a staged native Jira wiki description string");
  return fields.description;
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
      wholeCollection: true,
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
    expect(descriptionOf(items[0])).toContain("* Thema 1 ist verfügbar.");
    expect(items.every((item) => item.projectId === "10000")).toBe(true);
    // The model confirmed each page it used, so tens of pages cannot exhaust the synthesis grant.
    expect(h.confirmed).toHaveLength(h.requests.length);
  });

  it("refuses trace labels absent from create metadata without another model call or a draft", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(1).text }],
    );

    const result = await h.run(ARGS, {
      createFields: CREATE_FIELDS.filter((candidate) => candidate !== LABEL_FIELD),
    });

    expect(h.requests).toHaveLength(1);
    const reference = /^- ([^\s]+:LH-001):/mu.exec(promptOf(firstRequest(h)))?.[1];
    if (reference === undefined) throw new TypeError("Expected the selected requirement reference");
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "failed",
      reason: "nothing-drafted",
      itemCount: 0,
      draftedCount: 0,
      failedCount: 1,
      coveredRequirementCount: 0,
      failedRequirementRefs: [reference],
    });
    expect(h.store.peek(DRAFT_ID, h.chatId)).toBeUndefined();
    expect(proofLines(h)).toContainEqual(
      expect.objectContaining({ phase: "page", outcome: "refused", pageItemCount: 1 }),
    );
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
      "h2. Acceptance criteria\n\n* Thema 1 ist verfügbar.\n* Fehler zu Thema 1 werden gemeldet.",
    );
    expect(description).not.toContain("Criteria ");
    expect(description).not.toMatch(/^## |^- /mu);
    expect(description.match(/Thema 1 ist verfügbar/gu)).toHaveLength(1);
    expect(description.match(/Fehler zu Thema 1 werden gemeldet/gu)).toHaveLength(1);
  });

  it("keeps the criteria out of the page prompt so a description lists each one once", async () => {
    // A model shown the criteria copied them into its own text, above Keiko's verbatim list.
    const echo = (request: GatewayCallRequest): string =>
      JSON.stringify({
        items: keysOf(request).map((key) => ({
          key,
          summary: `Summary ${key}`,
          sections: {
            Context: promptOf(request).includes("ist verfügbar")
              ? "Thema 1 ist verfügbar."
              : "Context",
          },
        })),
      });
    const h = await harness(echo, [{ capsuleId: "cap-a", text: specification(2).text }]);

    const result = await h.run(ARGS, { templates: CONTEXT_TEMPLATE });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    const prompt = promptOf(firstRequest(h));
    expect(prompt).toContain("Keiko appends each requirement's acceptance criteria verbatim");
    expect(prompt).not.toContain("ist verfügbar");
    const description = descriptionOf(stagedItems(h)[0]);
    expect(description).toContain("h2. Akzeptanzkriterien\n\n* Thema 1 ist verfügbar.");
    expect(description.match(/Thema 1 ist verfügbar/gu)).toHaveLength(1);
    expect(description.match(/Fehler zu Thema 1 werden gemeldet/gu)).toHaveLength(1);
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
    expect(descriptionOf(stagedItems(h)[0])).toContain(
      "h2. Akzeptanzkriterien\n\n* Thema 1 ist verfügbar.\n* Fehler zu Thema 1 werden gemeldet.",
    );
  });

  it("asks for the criteria section only for an issue whose requirements carry none", async () => {
    // Requirement 9 has no criteria, so its issue needs the model's own text for the section.
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(9).text }],
    );

    const result = await h.run({ ...ARGS, requirements: { ids: ["LH-008", "LH-009"] } });

    // A selection of part of the collection never stands for the whole collection (#4292).
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      draftedCount: 2,
      wholeCollection: false,
    });
    expect(promptOf(firstRequest(h))).toContain('Also write the sections ["Acceptance criteria"]');
    const [first, second] = stagedItems(h);
    expect(descriptionOf(first)).toContain("* Thema 8 ist verfügbar.");
    expect(descriptionOf(second)).toContain("h2. Acceptance criteria\n\nCriteria ");
  });

  it("appends a list in the document's language when the template has no criteria section", async () => {
    const h = await harness(
      (request) => page(keysOf(request), "Context"),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run(ARGS, { templates: CONTEXT_TEMPLATE });

    expect(result.data).toMatchObject({ outcome: "succeeded", draftedCount: 2 });
    const description = descriptionOf(stagedItems(h)[0]);
    expect(description).toContain("h2. Context\n\nCriteria ");
    expect(description).toContain(
      "h2. Akzeptanzkriterien\n\n* Thema 1 ist verfügbar.\n* Fehler zu Thema 1 werden gemeldet.",
    );
    expect(description).not.toMatch(/^## |^- /mu);
    expect(description.match(/Thema 1 ist verfügbar/gu)).toHaveLength(1);
    expect(description.match(/Fehler zu Thema 1 werden gemeldet/gu)).toHaveLength(1);
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
    expect(first.data).not.toHaveProperty("remainingRequirementIds");
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

  describe("review findings F17, F18, F27 and F33 of #4292", () => {
    it("keeps document-owned [n] markers when the Chat has an unrelated citation namespace", async () => {
      const text = specification(1).text.replace(
        "Thema 1 ist verfügbar.",
        "Thema 1 ist verfügbar [1].",
      );
      const grounded = await harness(
        (request) => page(keysOf(request)),
        [{ capsuleId: "cap-a", text }],
      );
      const control = await harness(
        (request) => page(keysOf(request)),
        [{ capsuleId: "cap-a", text }],
      );

      const withMap = await grounded.run(ARGS, {
        citationSources: () => new Map([[1, "Unrelated design memo.pdf"]]),
      });
      const noMap = await control.run(ARGS);

      expect(noMap.data).toMatchObject({ outcome: "succeeded", draftedCount: 1 });
      expect(withMap.data).toMatchObject({ outcome: "succeeded", draftedCount: 1, failedCount: 0 });
      expect(descriptionOf(stagedItems(grounded)[0])).toContain("* Thema 1 ist verfügbar \\[1\\].");
      expect(descriptionOf(stagedItems(grounded)[0])).toBe(descriptionOf(stagedItems(control)[0]));
      expect(descriptionOf(stagedItems(grounded)[0])).not.toContain("Unrelated design memo");
    });

    it("never offers creation for a filtered run over a cut collection", async () => {
      const h = await harness(
        (request) => page(keysOf(request)),
        [{ capsuleId: "cap-a", text: specification(5001).text }],
      );

      const result = await h.run({
        ...ARGS,
        create: true,
        requirements: { ids: ["LH-001", "LH-5001"] },
      });

      expect(result.data).toMatchObject({ selectionIncomplete: true });
      expect(result.data.guidance).toEqual(expect.stringContaining("not listed"));
      expect(
        batchDraftDecision({
          result: {
            status: "completed",
            toolRef: { canonicalId: "keiko.jira.draft.batch" },
            data: result.data,
          },
        } as never),
      ).toEqual({ kind: "skip", reason: "selection-incomplete" });
    }, 120_000);

    it("drafts the whole original selection again from the result once the draft is lost", async () => {
      let clock = 0;
      const run = await pausingHarness(60, () => clock);
      const probe = await run.h.run({ ...ARGS, requirements: { documents: ["no-such-document"] } });
      const [scope] = probe.data.availableDocuments as readonly string[];
      if (scope === undefined) throw new Error("Expected the Pod's document scope");
      const first = await run.pause({
        ...ARGS,
        create: true,
        requirements: { documents: [scope] },
      });
      expect(first.data).toMatchObject({ paused: true, selectionDocuments: [scope] });
      expect(first.data).not.toHaveProperty("remainingRequirementIds");
      expect(first.data.guidance).toEqual(expect.stringContaining("Never start a new draft"));
      clock += 5 * 60 * 60 * 1000;
      expect(run.h.store.peek(DRAFT_ID, run.h.chatId)).toBeUndefined();

      // Exactly what the result says: no draftId, the requirements filter it names.
      const retry = await run.finish({
        ...ARGS,
        create: true,
        requirements: { documents: first.data.selectionDocuments },
      });

      expect(retry.data).toMatchObject({
        outcome: "succeeded",
        requirementCount: 60,
        coveredRequirementCount: 60,
        failedCount: 0,
      });
      const covered = stagedItems(run.h).flatMap((item) => item.requirementIds as string[]);
      expect(new Set(covered).size).toBe(60);
    });

    it("needs no recovery state: a restarted Keiko drafts the whole selection again", async () => {
      const before = await pausingHarness(60);
      const first = await before.pause({ ...ARGS, create: true });
      expect(first.data).toMatchObject({ paused: true });
      // An unfiltered call names no filter, so the result names none either.
      expect(first.data).not.toHaveProperty("selectionDocuments");

      // A new store and executor, as after a restart, with the same Pod content.
      const after = await pausingHarness(60);
      const retry = await after.finish({ ...ARGS, create: true });

      expect(retry.data).toMatchObject({ outcome: "succeeded", requirementCount: 60 });
      const covered = stagedItems(after.h).flatMap((item) => item.requirementIds as string[]);
      expect(new Set(covered).size).toBe(60);
    });

    it("honours a later scoped request instead of widening it to the paused selection (F33)", async () => {
      const run = await pausingHarness(60);
      const first = await run.pause({ ...ARGS, create: true });
      expect(first.data).toMatchObject({ paused: true });
      const drafted = new Set(
        stagedItems(run.h).flatMap((item) => item.requirementIds as string[]),
      );
      const deferred = Array.from(
        { length: 60 },
        (_, index) => `LH-${String(index + 1).padStart(3, "0")}`,
      ).find((id) => ![...drafted].some((ref) => ref.endsWith(`:${id}`)));
      if (deferred === undefined) throw new Error("Expected a requirement the pause deferred");

      const scoped = await run.finish({ ...ARGS, create: true, requirements: { ids: [deferred] } });

      expect(scoped.data).toMatchObject({
        outcome: "succeeded",
        newDraft: true,
        requirementCount: 1,
        draftedCount: 1,
      });
    });
  });

  it("counts a documents filter that selects every requirement as the whole collection", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );
    const probe = await h.run({ ...ARGS, requirements: { documents: ["no-such-document"] } });
    const [scope] = probe.data.availableDocuments as readonly string[];
    if (scope === undefined) throw new Error("Expected the Pod's document scope");

    const result = await h.run({ ...ARGS, requirements: { documents: [scope] } });

    expect(result.data).toMatchObject({
      outcome: "succeeded",
      requirementCount: 3,
      coveredRequirementCount: 3,
      wholeCollection: true,
    });
  });

  it("keeps a documents filter that names one of two documents partial", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [
        { capsuleId: "cap-a", text: specification(2).text },
        { capsuleId: "cap-b", text: specification(3).text },
      ],
    );
    const probe = await h.run({ ...ARGS, requirements: { documents: ["no-such-document"] } });
    const scopes = probe.data.availableDocuments as readonly string[];
    expect(scopes).toHaveLength(2);
    const [first] = scopes;
    if (first === undefined) throw new Error("Expected a document scope");

    const result = await h.run({ ...ARGS, requirements: { documents: [first] } });

    expect(result.data).toMatchObject({ outcome: "succeeded", wholeCollection: false });
    expect(result.data.requirementCount).toBeLessThan(5);
  });

  it("tells the model to draft the whole selection again when a paused draft is lost", async () => {
    let now = 0;
    const h = await harness(
      (request) => {
        now += 100_000;
        return page(keysOf(request));
      },
      [{ capsuleId: "cap-a", text: specification(120).text }],
    );

    const result = await h.run(ARGS, { budget: { nowMs: () => now, deadlineAtMs: 200_000 } });

    expect(Number(result.data.remainingCount)).toBeGreaterThan(50);
    expect(result.data).not.toHaveProperty("remainingDocuments");
    expect(result.data.guidance).toEqual(expect.stringContaining("same requirements filter"));
    expect(result.data.guidance).toEqual(
      expect.stringContaining("whole selection is drafted again"),
    );
    expect(proofLines(h).at(-1)).toMatchObject({ stopReason: "deadline" });
  });

  it("fails a failed-at-deadline batch with the closed reason when nothing was staged", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(5).text }],
    );
    const result = await h.run(ARGS, { budget: { nowMs: () => 0, deadlineAtMs: 1 } });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ outcome: "failed", reason: "deadline" });
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a resume with a draft that does not exist, before any work", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );
    const result = await h.run({ ...ARGS, draftId: "aaaaaaaa-2222-4333-8444-555555555555" });
    expect(result.data.reason).toBe("draft-unavailable");
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a resume in another issue type than the draft's", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );
    await h.run(ARGS);
    const calls = h.requests.length;
    const result = await h.run({ ...ARGS, draftId: DRAFT_ID, issueTypeId: "Epic" });
    expect(result.data.reason).toBe("draft-mismatch");
    expect(h.requests).toHaveLength(calls);
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

  it("refuses a vanished draft before any model work, with a refused line", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(2).text }],
    );

    const result = await h.run({ ...ARGS, draftId: "99999999-2222-4333-8444-555555555555" });

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ outcome: "failed", reason: "draft-unavailable" });
    expect(h.requests).toHaveLength(0);
    expect(proofLines(h)).toEqual([
      expect.objectContaining({ phase: "refused", refusal: "draft-unavailable", level: "warn" }),
    ]);
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
    expect(result.data.failedRequirementRefs as string[]).toHaveLength(25 - drafted);
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

describe("jira.draft-batch against Data Center Epic metadata and repeated documents (#4288)", () => {
  const EPIC_NAME = {
    ...field("customfield_10103", "string", true),
    name: "Epic Name",
    schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label", customId: 10103 },
  };

  function requiredFieldIds(request: GatewayCallRequest): string[] {
    const line = /^Required fields: (\[[^\]]*\])/mu.exec(promptOf(request))?.[1];
    return line === undefined ? [] : (JSON.parse(line) as string[]);
  }

  function pageWithFields(request: GatewayCallRequest): string {
    const ids = requiredFieldIds(request);
    return JSON.stringify({
      items: keysOf(request).map((key) => ({
        key,
        summary: `Summary ${key}`,
        sections: { "Acceptance criteria": `Criteria ${key}` },
        fields: Object.fromEntries(ids.map((id) => [id, `Name ${key}`])),
      })),
    });
  }

  it("logs why a page answer was sent back, as counts and never its text (#4288)", async () => {
    const spec = specification(3);
    let calls = 0;
    const h = await harness(
      (request) => {
        calls += 1;
        if (calls === 1) return "not json at all";
        if (calls === 2)
          return JSON.stringify({
            items: keysOf(request)
              .slice(1)
              .map((key) => ({ key, summary: `Summary ${key}`, sections: {} })),
          });
        return pageWithFields(request);
      },
      [{ capsuleId: "cap-a", text: spec.text }],
    );

    const result = await h.run({ ...ARGS, requirements: { ids: [...spec.ids] } });

    expect(result.data).toMatchObject({ outcome: "succeeded", itemCount: 3 });
    const corrected = proofLines(h).filter((line) => line.outcome === "corrected");
    expect(corrected[0]).toMatchObject({
      unreadableAnswer: true,
      missingItemCount: 0,
      missingSectionItemCount: 0,
      missingFieldItemCount: 0,
    });
    expect(corrected[1]).toMatchObject({
      unreadableAnswer: false,
      missingItemCount: 1,
      missingSectionItemCount: 0,
      missingFieldItemCount: 0,
    });
    expect(JSON.stringify(proofLines(h))).not.toMatch(/not json|Summary /u);
  });

  it("asks the model for the Epic Name Jira requires and stages every Epic with it", async () => {
    const spec = specification(3);
    const h = await harness(pageWithFields, [{ capsuleId: "cap-a", text: spec.text }]);

    const result = await h.run(
      { ...ARGS, create: true },
      { createFields: [...CREATE_FIELDS, EPIC_NAME] },
    );

    expect(result.data).toMatchObject({ outcome: "succeeded", itemCount: 3, failedCount: 0 });
    expect(promptOf(firstRequest(h))).toContain(
      'Required fields: ["customfield_10103"] (customfield_10103 is "Epic Name"; key each by its id)',
    );
    const names = stagedItems(h).map(
      (item) => (item.fields as Record<string, unknown>).customfield_10103,
    );
    expect(names).toHaveLength(3);
    expect(names.every((name) => typeof name === "string" && name.startsWith("Name "))).toBe(true);
  });

  it("asks once for an Epic Name the template already names by its display name", async () => {
    const spec = specification(1);
    const h = await harness(pageWithFields, [{ capsuleId: "cap-a", text: spec.text }]);
    const named: JiraIssueTemplateSet = {
      templates: [template("requiredFields: [Epic Name]")],
      unreadable: 0,
    };

    await h.run(
      { ...ARGS, create: true },
      { createFields: [...CREATE_FIELDS, EPIC_NAME], templates: named },
    );

    expect(requiredFieldIds(firstRequest(h))).toEqual(["Epic Name"]);
  });

  it("asks for no field Jira defaults, Keiko writes or the model cannot write as text", async () => {
    const spec = specification(1);
    const h = await harness(pageWithFields, [{ capsuleId: "cap-a", text: spec.text }]);
    const defaulted = { ...field("customfield_10200", "string", true), hasDefaultValue: true };
    const option = {
      ...field("customfield_10300", "option", true),
      schema: {
        type: "option",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:select",
      },
      allowedValues: [{ id: "1", value: "A" }],
    };
    const reporter = {
      ...field("reporter", "user", true),
      schema: { type: "user", system: "reporter" },
    };

    await h.run(
      { ...ARGS, create: true },
      { createFields: [...CREATE_FIELDS, defaulted, option, reporter] },
    );

    expect(requiredFieldIds(firstRequest(h))).toEqual([]);
  });

  it("drafts one requirements document held in several formats once", async () => {
    const spec = specification(3);
    const h = await harness(pageWithFields, [
      { capsuleId: "cap-a", text: spec.text },
      { capsuleId: "cap-b", text: spec.text.replaceAll("\n\n", "\n\n\n") },
      { capsuleId: "cap-c", text: spec.text },
    ]);

    const result = await h.run({ ...ARGS, create: true, requirements: { ids: [...spec.ids] } });

    // The managed MCP host refuses a result its descriptor does not declare (live run, #4288).
    expect(
      describeCatalogSchemaMismatch(
        JIRA_DRAFT_BATCH_DECLARATION.descriptor.resultSchema,
        result.data,
      ),
    ).toBeUndefined();
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      itemCount: 3,
      requirementCount: 3,
      copyDocumentsSkipped: 2,
    });
    expect(stagedItems(h)).toHaveLength(3);
  });

  it("refuses IDs that documents with different content share before any model call", async () => {
    const spec = specification(3);
    const h = await harness(pageWithFields, [
      { capsuleId: "cap-a", text: spec.text },
      { capsuleId: "cap-b", text: specification(3, { revise: [2] }).text },
    ]);

    const result = await h.run({ ...ARGS, create: true, requirements: { ids: [...spec.ids] } });

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "failed",
      reason: "requirements-ambiguous",
      availableRequirementCount: 6,
    });
    const documents = result.data.availableDocuments as string[];
    expect(documents).toHaveLength(2);
    expect(result.data.guidance).toEqual(expect.stringContaining("requirements.documents"));
    expect(h.requests).toHaveLength(0);
    expect(stagedItems(h)).toEqual([]);
    expect(proofLines(h).at(-1)).toMatchObject({
      phase: "refused",
      refusal: "requirements-ambiguous",
      errorKind: "invalid-request",
    });

    const chosen = await h.run({
      ...ARGS,
      create: true,
      requirements: { ids: [...spec.ids], documents: [documents[0]] },
    });

    expect(chosen.data).toMatchObject({ outcome: "succeeded", itemCount: 3, requirementCount: 3 });
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

function s17Diagnostics(h: Harness, data: CatalogJsonObject): string {
  return JSON.stringify({
    data,
    requests: h.requests.map((request, index) => {
      const last = request.messages.at(-1);
      const text = last === undefined ? "" : contentText(last.content);
      return {
        keys: keysOf(request),
        correction: text.includes("Your previous answer") ? text.slice(0, 1500) : undefined,
        answer: h.answers[index]?.slice(0, 1500),
      };
    }),
    batch: proofLines(h),
  });
}

function s17TemplateAnswer(request: GatewayCallRequest): string {
  const correction = request.messages.some((message) => {
    const text = contentText(message.content);
    return text.includes("Your previous answer") && text.includes("summary-too-short");
  });
  if (!correction) return page(keysOf(request));
  return JSON.stringify({
    items: keysOf(request).map((key) => ({
      key,
      summary: `S17 corrected summary for ${key} with sufficient detail`,
      sections: { "Acceptance criteria": "The supplied requirement is implemented." },
    })),
  });
}

describe("S17 real batch stage corrections", () => {
  it("keeps parse and real template-stage attempts distinct and logs only closed rule counts", async () => {
    const h = await harness(
      (request, call) => (call === 1 ? "not json" : s17TemplateAnswer(request)),
      [{ capsuleId: "cap-a", text: specification(1).text }],
    );
    const strict: JiraIssueTemplateSet = {
      templates: [template("summaryMinLength: 30")],
      unreadable: 0,
    };
    const result = await h.run(ARGS, { templates: strict });
    expect(result.data, s17Diagnostics(h, result.data)).toMatchObject({
      outcome: "succeeded",
      draftedCount: 1,
      failedCount: 0,
    });
    expect(h.requests).toHaveLength(3);
    const correction = h.requests[2];
    if (correction === undefined) throw new Error("Expected the real template correction call");
    expect(promptOf(correction)).toContain("summary-too-short");
    expect(stagedItems(h)).toHaveLength(1);
    const lines = proofLines(h);
    const refused = lines.find((line) => line.phase === "page" && line.outcome === "refused");
    expect(refused).toMatchObject({
      parseAttemptCount: 2,
      stageAttemptCount: 1,
      summaryTooShortCount: 1,
    });
    expect(refused?.guidanceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(lines.find((line) => line.phase === "page" && line.outcome === "staged")).toMatchObject({
      parseAttemptCount: 3,
      stageAttemptCount: 2,
    });
    const logged = h.logs.events.map((event) => formatActivityLogProofLine(event)).join("\n");
    expect(logged).not.toContain("S17 corrected summary");
    expect(logged).not.toContain("Your previous answer");
    expect(logged).not.toContain("The supplied requirement is implemented.");
  });

  it("returns the unchanged-stage-rejection reason without a smaller-page retry", async () => {
    const h = await harness(
      (request) => page(keysOf(request)),
      [{ capsuleId: "cap-a", text: specification(3).text }],
    );
    const strict: JiraIssueTemplateSet = {
      templates: [template("summaryMinLength: 30")],
      unreadable: 0,
    };
    const result = await h.run(ARGS, { templates: strict });
    expect(result.isError).toBe(true);
    expect(result.data, s17Diagnostics(h, result.data)).toMatchObject({
      outcome: "failed",
      reason: "stage-rejection-unchanged",
      draftedCount: 0,
      failedCount: 3,
    });
    expect(h.requests).toHaveLength(2);
    expect(stagedItems(h)).toEqual([]);
    expect(proofLines(h).some((line) => line.outcome === "split")).toBe(false);
    expect(proofLines(h).at(-1)).toMatchObject({
      phase: "completed",
      stopReason: "stage-rejection-unchanged",
      outcome: "failed",
      errorKind: "validation-failed",
    });
  });
});
