// The native issue reader and canonical rule checker remain real. Only authenticated History
// and installed-template reads are substituted; assistant prose never supplies a verdict.
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { canonicalDesktopChatTurnReferenceSeed } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as oracles from "../testing/jira-chat-lab/rules-knowledge-oracles.mjs";
import { workflowHistory } from "../testing/jira-chat-lab/browser-workflow-turn.mjs";
import { readInstalledTemplateScope } from "../testing/jira-chat-lab/requirements/progress-simulation.mjs";
import {
  GOLDEN_NO_CRITERIA_TEXT,
  loadGoldenManifest,
} from "../testing/jira-chat-lab/requirements/golden-jira-oracle.mjs";
import { templateMarkdown } from "../testing/jira-chat-lab/requirements/templates.mjs";

vi.mock("../testing/jira-chat-lab/browser-workflow-turn.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  workflowHistory: vi.fn(),
}));

vi.mock(
  "../testing/jira-chat-lab/requirements/progress-simulation.mjs",
  async (importOriginal) => ({
    ...(await importOriginal()),
    readInstalledTemplateScope: vi.fn(),
  }),
);

const PROJECT = "LIM7";
const CHAT_ID = "11111111-2222-4333-8444-555555555555";
const STEP = "ac1-bulk-refusals";
const GOLDEN = loadGoldenManifest();
const FIELD_CATALOG = [
  { id: "summary", name: "Summary" },
  { id: "description", name: "Description" },
  { id: "labels", name: "Labels" },
  { id: "issuelinks", name: "Issue Links" },
  { id: "customfield_10200", name: "Review Classification" },
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const reference = (requirement) => `a1b2c3d4:${requirement.id}`;
const clientTurnId = (index) => `33333333-4444-4555-8666-${String(index + 1).padStart(12, "0")}`;

beforeEach(() => {
  vi.mocked(workflowHistory).mockReset();
  vi.mocked(readInstalledTemplateScope).mockReset();
});

function entrypoint() {
  expect(oracles.gradeBulkRefusals, "the contracted bulk-refusal oracle must exist").toBeTypeOf(
    "function",
  );
  return oracles.gradeBulkRefusals;
}

function nativeEpic(requirement, index) {
  return {
    id: String(20001 + index),
    key: `${PROJECT}-${index + 1}`,
    fields: {
      project: { id: "10000", key: PROJECT },
      issuetype: { id: "10001", name: "Epic", subtask: false },
      status: { id: "11", name: "To Do", statusCategory: { key: "new" } },
      summary: `[${requirement.id}] ${requirement.title}`,
      description: [
        "h2. Requirement",
        "A complete synthetic requirement statement.",
        "",
        "h2. Acceptance criteria",
        ...(requirement.acceptanceCriteria.length === 0
          ? [GOLDEN_NO_CRITERIA_TEXT]
          : requirement.acceptanceCriteria.map((criterion) => `* ${criterion}`)),
        "",
        "----",
        "Keiko traceability",
        `Requirement: ${requirement.id} · ${requirement.title}`,
        `Reference: ${reference(requirement)}`,
        `Source: synthetic.pdf · ${requirement.sectionPath.join(" · ")}`,
        "End of Keiko traceability",
      ].join("\n"),
      labels: ["anforderung"],
      issuelinks: [],
      customfield_10200: "observed-classification",
    },
  };
}

function installedScope(requiredFields = []) {
  const body = templateMarkdown({
    project: PROJECT,
    issueType: "Epic",
    rule: { labels: ["anforderung"], sections: ["Requirement", "Acceptance criteria"] },
    summaryPattern: String.raw`^\[`,
    requiredFields,
  });
  const parsed = parseJiraIssueTemplate(body);
  if (!parsed.ok) throw new TypeError("Synthetic formal template must parse");
  return {
    project: PROJECT,
    issueTypes: ["Epic"],
    labelsForTypes: ["Epic"],
    parentForTypes: {},
    templates: [{ id: "template-epic", revision: 1, sha256: sha256(body), rules: parsed.template }],
  };
}

function refusalMessage(requirement, index) {
  return {
    id: `user-${index + 1}`,
    chatId: CHAT_ID,
    role: "user",
    content: "Synthetic deliberate formal-rule probe.",
    timestamp: 1805068800000 + index,
    canonicalTurnRef: sha256(canonicalDesktopChatTurnReferenceSeed(CHAT_ID, clientTurnId(index))),
    turnState: "completed",
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [
        {
          call: {
            id: `call-${index + 1}`,
            name: "jira_create",
            arguments: {
              projectId: "10000",
              issueTypeId: "10001",
              fields: { summary: "Deliberately missing the required bracketed identity" },
              requirementIds: [reference(requirement)],
            },
          },
          result: {
            schemaVersion: 1,
            invocationId: `invocation-${index + 1}`,
            toolRef: { canonicalId: "keiko.jira.create", contractVersion: 1 },
            projectionDigest: null,
            effectStarted: false,
            metrics: { inputBytes: 0, outputBytes: 0, resultCount: 1, durationMs: 0 },
            status: "failed",
            reason: "provider-reported-error",
            page: null,
            data: {
              outcome: "rejected",
              reason: "field-validation",
              violations: [
                { ruleId: "summary-pattern", template: `${PROJECT}/Epic`, subject: "summary" },
              ],
            },
          },
        },
      ],
    },
  };
}

function correctionExchange(requirement, issue, index) {
  const exchange = refusalMessage(requirement, index).toolTranscript.exchanges[0];
  exchange.call.id = `corrected-call-${index + 1}`;
  exchange.call.arguments.fields = {
    summary: issue.fields.summary,
    description: issue.fields.description,
    labels: [...issue.fields.labels],
    customfield_10200: issue.fields.customfield_10200,
  };
  exchange.result = {
    ...exchange.result,
    invocationId: `corrected-invocation-${index + 1}`,
    effectStarted: true,
    status: "completed",
    reason: "none",
    page: { truncated: false, reason: "none", cursor: null },
    data: { outcome: "succeeded", issueId: issue.id, issueKey: issue.key },
  };
  return exchange;
}

function correctionMessage(requirements, issues) {
  const message = refusalMessage(requirements[0], 1000);
  message.content = "Create the corrected synthetic Epics after the deliberate probes.";
  message.toolTranscript.exchanges = requirements.map((requirement, index) =>
    correctionExchange(requirement, issues[index], index),
  );
  return message;
}

function knowledgeRead() {
  const exchange = refusalMessage(GOLDEN.requirements[0], 2000).toolTranscript.exchanges[0];
  exchange.call = {
    id: "knowledge-read-call",
    name: "knowledge_requirements",
    arguments: { view: "units" },
  };
  exchange.result = {
    ...exchange.result,
    invocationId: "knowledge-read-invocation",
    toolRef: { canonicalId: "keiko.knowledge.requirements", contractVersion: 1 },
    effectStarted: true,
    status: "completed",
    reason: "none",
    page: { truncated: false, reason: "none", cursor: null },
    data: { outcome: "succeeded", view: "units", items: [], totals: { documentsNotExtracted: 0 } },
  };
  return exchange;
}

function harness({ anchors = false } = {}) {
  const issues = GOLDEN.requirements.map((requirement, index) => nativeEpic(requirement, index));
  const selected = GOLDEN.requirements.slice(0, 37);
  const seeded = selected.map((requirement) => ({
    requirementId: requirement.id,
    ruleId: "summary-pattern",
  }));
  const messages = selected.map((requirement, index) => refusalMessage(requirement, index));
  const correction = correctionMessage(selected, issues);
  messages.push(correction);
  vi.mocked(workflowHistory).mockResolvedValue({ messages });
  vi.mocked(readInstalledTemplateScope).mockResolvedValue(installedScope());
  const state = {};
  if (anchors)
    state[STEP] = {
      projectKey: PROJECT,
      chatId: CHAT_ID,
      refusals: seeded.map((seed, index) => ({ ...seed, clientTurnId: clientTurnId(index) })),
    };
  const ctx = {
    projectKey: PROJECT,
    truth: GOLDEN,
    chat: { id: CHAT_ID },
    signal: new globalThis.AbortController().signal,
    read: vi.fn((path) => {
      if (path === "/rest/api/2/field") return Promise.resolve(structuredClone(FIELD_CATALOG));
      const url = new URL(path, "https://synthetic.invalid");
      expect(url.pathname).toBe("/rest/api/2/search");
      expect(url.searchParams.get("jql")).toBe(`project = "${PROJECT}" ORDER BY key ASC`);
      expect(url.searchParams.get("maxResults")).toBe("100");
      const startAt = Number(url.searchParams.get("startAt"));
      return Promise.resolve({
        startAt,
        maxResults: 100,
        total: issues.length,
        issues: structuredClone(issues.slice(startAt, startAt + 100)),
      });
    }),
    turn: vi.fn(() => Promise.reject(new TypeError("The oracle must not submit a turn"))),
    intent: {
      state,
      record: vi.fn((step, value) => {
        expect(step).toBe(STEP);
        state[step] = structuredClone(value);
        return Promise.resolve();
      }),
    },
  };
  return { ctx, seeded, issues, messages, correction };
}

function noObservation(ctx) {
  expect(ctx.read).not.toHaveBeenCalled();
  expect(workflowHistory).not.toHaveBeenCalled();
  expect(readInstalledTemplateScope).not.toHaveBeenCalled();
  expect(ctx.turn).not.toHaveBeenCalled();
}

function firstExchange(fixture) {
  return fixture.messages[0].toolTranscript.exchanges[0];
}

async function grade(fixture) {
  return entrypoint()(fixture.ctx, { seeded: fixture.seeded });
}

function publicEvidence(result) {
  expect(result.step).toBe(STEP);
  expect(typeof result.detail).toBe("string");
  expect(result.detail).not.toMatch(/[\r\n]/u);
  expect(Object.values(result.counts).every((value) => Number.isFinite(value))).toBe(true);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(GOLDEN.requirements[0].title);
  expect(serialized).not.toContain(GOLDEN.requirements[0].id);
  expect(serialized).not.toContain("LIM7-1");
  expect(serialized).not.toContain(CHAT_ID);
  expect(serialized).not.toContain(clientTurnId(0));
  expect(serialized).not.toContain("Synthetic deliberate formal-rule probe");
}

describe("gradeBulkRefusals native and structured evidence", () => {
  it("exports the contracted asynchronous bulk-refusal grader", () => {
    entrypoint();
  });

  it("refuses an empty seed list before any observation or turn", async () => {
    const { ctx } = harness();
    expect(await entrypoint()(ctx, { seeded: [] })).toMatchObject({
      step: STEP,
      status: "unverified",
    });
    noObservation(ctx);
  });

  it("refuses duplicate requirement seeds before any observation or turn", async () => {
    const { ctx, seeded } = harness();
    seeded[1] = { ...seeded[0] };
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "unverified" });
    noObservation(ctx);
  });

  it("refuses an unknown rule id before any observation or turn", async () => {
    const { ctx, seeded } = harness();
    seeded[0].ruleId = "invented-rule";
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "unverified" });
    noObservation(ctx);
  });

  it("does not substitute conforming native issues or model prose for missing stored refusals", async () => {
    const { ctx, seeded } = harness();
    vi.mocked(workflowHistory).mockResolvedValue({
      messages: [{ role: "assistant", content: "All 37 deliberate probes were refused." }],
    });
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "unverified" });
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("rejects a native label violation despite authentic structured refusals", async () => {
    const { ctx, seeded, issues } = harness();
    issues[0].fields.labels = [];
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "red" });
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("rejects two native Epics for one requirement even when their Jira identities differ", async () => {
    const { ctx, seeded, issues } = harness();
    issues[1].fields = structuredClone(issues[0].fields);
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "red" });
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("rejects altered native acceptance criteria despite correct totals and titles", async () => {
    const { ctx, seeded, issues } = harness();
    const index = GOLDEN.requirements.findIndex(
      (requirement) => requirement.acceptanceCriteria.length > 0,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const criterion = GOLDEN.requirements[index].acceptanceCriteria[0];
    issues[index].fields.description = issues[index].fields.description.replace(
      `* ${criterion}`,
      "* A different synthetic acceptance criterion.",
    );
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "red" });
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("checks current full formal rules instead of only the seeded summary rule", async () => {
    const { ctx, seeded, issues } = harness();
    vi.mocked(readInstalledTemplateScope).mockResolvedValue(
      installedScope(["Review Classification"]),
    );
    issues[0].fields.customfield_10200 = null;
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "red" });
    expect(readInstalledTemplateScope).toHaveBeenCalledWith(ctx);
    expect(ctx.read).toHaveBeenCalledWith("/rest/api/2/field");
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("keeps unreadable current formal rules unavailable instead of treating them as an empty scope", async () => {
    const { ctx, seeded } = harness();
    vi.mocked(readInstalledTemplateScope).mockRejectedValue(
      new TypeError("Formal template is unreadable"),
    );
    expect(await entrypoint()(ctx, { seeded })).toMatchObject({ step: STEP, status: "unverified" });
    expect(ctx.turn).not.toHaveBeenCalled();
  });
});

describe("gradeBulkRefusals anchored History and read-only resume", () => {
  it("proves 37 distinct stored refusals against all 370 native Epics without another browser turn", async () => {
    const fixture = harness({ anchors: true });
    const result = await grade(fixture);
    expect(result).toMatchObject({
      status: "green",
      counts: { seededCount: 37, refusedCount: 37, correctedCount: 37 },
    });
    expect(workflowHistory).toHaveBeenCalledWith(fixture.ctx, CHAT_ID, { limit: 500 });
    const searches = fixture.ctx.read.mock.calls
      .map(([path]) => new URL(path, "https://synthetic.invalid"))
      .filter((url) => url.pathname === "/rest/api/2/search");
    expect(searches.map((url) => url.searchParams.get("startAt"))).toEqual([
      "0",
      "100",
      "200",
      "300",
    ]);
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
    publicEvidence(result);
  });

  it("counts a refused call once even when its structured result repeats the same rule violation", async () => {
    const fixture = harness({ anchors: true });
    for (const message of fixture.messages.slice(0, fixture.seeded.length)) {
      const data = message.toolTranscript.exchanges[0].result.data;
      data.violations.push(structuredClone(data.violations[0]));
    }
    expect(await grade(fixture)).toMatchObject({
      status: "green",
      counts: { seededCount: 37, refusedCount: 37 },
    });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not claim current-run refusals from unanchored otherwise authentic history", async () => {
    const fixture = harness();
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("refuses an anchor belonging to another Chat", async () => {
    const fixture = harness({ anchors: true });
    fixture.ctx.intent.state[STEP].chatId = "99999999-2222-4333-8444-555555555555";
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("refuses an anchor belonging to another native project", async () => {
    const fixture = harness({ anchors: true });
    fixture.ctx.intent.state[STEP].projectKey = "OTHER";
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not replace a missing current turn with an older refusal of the same requirement", async () => {
    const fixture = harness({ anchors: true });
    fixture.messages[0].canonicalTurnRef = sha256(
      canonicalDesktopChatTurnReferenceSeed(CHAT_ID, "older-synthetic-client-turn"),
    );
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not treat a cancelled user turn as settled refusal evidence", async () => {
    const fixture = harness({ anchors: true });
    fixture.messages[0].turnState = "cancelled";
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("binds the call's requirement reference to the exact native trace scope", async () => {
    const fixture = harness({ anchors: true });
    firstExchange(fixture).call.arguments.requirementIds = [
      `deadbeef:${fixture.seeded[0].requirementId}`,
    ];
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not substitute another closed rule for the deliberately seeded rule", async () => {
    const fixture = harness({ anchors: true });
    firstExchange(fixture).result.data.violations[0].ruleId = "label-missing";
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not substitute another project's template refusal", async () => {
    const fixture = harness({ anchors: true });
    firstExchange(fixture).result.data.violations[0].template = "OTHER/Epic";
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("requires the envelope's explicit no-effect fact even if an outer lookalike claims false", async () => {
    const fixture = harness({ anchors: true });
    firstExchange(fixture).result.effectStarted = true;
    firstExchange(fixture).effectStarted = false;
    expect(await grade(fixture)).toMatchObject({ status: "red" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not count a rejected result carrying an issue receipt as a pre-effect refusal", async () => {
    const fixture = harness({ anchors: true });
    firstExchange(fixture).result.data.issueKey = "LIM7-1";
    firstExchange(fixture).result.data.issueId = "20001";
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("cannot cover 37 seeds with one refused call carrying 37 violation entries", async () => {
    const fixture = harness({ anchors: true });
    const exchange = firstExchange(fixture);
    exchange.result.data.violations = Array.from({ length: 37 }, () =>
      structuredClone(exchange.result.data.violations[0]),
    );
    fixture.messages.splice(1);
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("rejects two actual refused create calls for the same seeded requirement", async () => {
    const fixture = harness({ anchors: true });
    const duplicate = structuredClone(firstExchange(fixture));
    duplicate.call.id = "second-actual-create-call";
    duplicate.result.invocationId = "second-actual-create-invocation";
    fixture.messages[0].toolTranscript.exchanges.push(duplicate);
    expect(await grade(fixture)).toMatchObject({ status: "red" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("rereads native issues on resume and rejects new drift without reusing a green verdict", async () => {
    const fixture = harness({ anchors: true });
    fixture.ctx.intent.state.unrelated = { retained: true };
    expect(await grade(fixture)).toMatchObject({ status: "green" });
    fixture.ctx.read.mockClear();
    fixture.issues[0].fields.labels = [];
    const result = await grade(fixture);
    expect(result).toMatchObject({ status: "red" });
    expect(fixture.ctx.read).toHaveBeenCalled();
    expect(fixture.ctx.intent.state.unrelated).toEqual({ retained: true });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
    publicEvidence(result);
    expect(JSON.stringify(fixture.ctx.intent.record.mock.calls)).not.toContain(
      "A complete synthetic requirement statement",
    );
  });

  it("does not reuse a prior green count when authenticated History becomes unavailable", async () => {
    const fixture = harness({ anchors: true });
    expect(await grade(fixture)).toMatchObject({ status: "green" });
    vi.mocked(workflowHistory).mockRejectedValue(
      new TypeError("Synthetic private History unavailable"),
    );
    const result = await grade(fixture);
    expect(result).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
    publicEvidence(result);
    expect(JSON.stringify(result)).not.toContain("Synthetic private History unavailable");
  });
});

describe("gradeBulkRefusals correction provenance and bounded History", () => {
  it("accepts the actual not-dispatched preflight receipt", async () => {
    const fixture = harness({ anchors: true });
    for (const message of fixture.messages.slice(0, fixture.seeded.length))
      message.toolTranscript.exchanges[0].mutationOutcome = "not-dispatched";
    expect(await grade(fixture)).toMatchObject({
      status: "green",
      counts: { seededCount: 37, refusedCount: 37, correctedCount: 37 },
    });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it.each([500, 501])("does not claim complete evidence from %i History rows", async (count) => {
    const fixture = harness({ anchors: true });
    const padding = Array.from({ length: count - fixture.messages.length }, (_, index) => ({
      id: `assistant-padding-${index + 1}`,
      chatId: CHAT_ID,
      role: "assistant",
      timestamp: 1805070000000 + index,
      content: "Synthetic unrelated answer.",
    }));
    fixture.messages.push(...padding);
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(workflowHistory).toHaveBeenCalledWith(fixture.ctx, CHAT_ID, { limit: 500 });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("allows a completed Knowledge READ's started effect beside the no-effect rejected create", async () => {
    const fixture = harness({ anchors: true });
    fixture.messages[0].toolTranscript.exchanges.unshift(knowledgeRead());
    expect(await grade(fixture)).toMatchObject({
      status: "green",
      counts: { seededCount: 37, refusedCount: 37, correctedCount: 37 },
    });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not infer a missing correction receipt from a currently conforming native issue", async () => {
    const fixture = harness({ anchors: true });
    fixture.correction.toolTranscript.exchanges.shift();
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not credit creation receipts that all precede the deliberate refusals", async () => {
    const fixture = harness({ anchors: true });
    fixture.correction.timestamp = fixture.messages[0].timestamp - 1;
    fixture.messages.pop();
    fixture.messages.unshift(fixture.correction);
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it.each([
    ["issueId", "999999"],
    ["issueKey", "LIM7-999999"],
  ])(
    "binds the later correction's %s to the independently read native issue",
    async (field, value) => {
      const fixture = harness({ anchors: true });
      fixture.correction.toolTranscript.exchanges[0].result.data[field] = value;
      expect(await grade(fixture)).toMatchObject({ status: "unverified" });
      expect(fixture.ctx.turn).not.toHaveBeenCalled();
    },
  );

  it("allows a model call id reused in different canonical turns", async () => {
    const fixture = harness({ anchors: true });
    for (const message of fixture.messages.slice(0, fixture.seeded.length))
      message.toolTranscript.exchanges[0].call.id = "model-reuses-call-1";
    expect(await grade(fixture)).toMatchObject({
      status: "green",
      counts: { seededCount: 37, refusedCount: 37, correctedCount: 37 },
    });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });

  it("does not accept one invocation identity for two different calls in the same turn", async () => {
    const fixture = harness({ anchors: true });
    const read = knowledgeRead();
    read.result.invocationId = firstExchange(fixture).result.invocationId;
    fixture.messages[0].toolTranscript.exchanges.unshift(read);
    expect(await grade(fixture)).toMatchObject({ status: "unverified" });
    expect(fixture.ctx.turn).not.toHaveBeenCalled();
  });
});
