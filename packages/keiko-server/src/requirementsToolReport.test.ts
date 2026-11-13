// #4181: `jira.report` with requirementsFromPods asks Keiko for the Chat's requirement
// identifiers, so a model with a small window never copies dozens of them into a call.
import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJiraReportStore } from "@oscharko-dev/keiko-connectors";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

import { podFixture, specification, type PodFixture, type PodSpec } from "./_requirementSupport.js";
import { createJiraProviderForCatalog } from "./atlassian/jiraManagedProvider.js";
import { openTraceSession } from "./requirement-trace.js";
import { resetRequirementTurnCache } from "./requirement-inventory.js";
import {
  chatReportRequirementIds,
  createKnowledgeRequirementsProvider,
  type RequirementsToolContext,
} from "./requirementsTool.js";

const fixtures: PodFixture[] = [];

beforeEach(() => {
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(
  pods: readonly PodSpec[],
  options?: Parameters<typeof podFixture>[1],
): Promise<PodFixture> {
  const created = await podFixture(pods, options);
  fixtures.push(created);
  return created;
}

const context = (f: PodFixture): RequirementsToolContext => ({
  invocationId: "inv-1",
  correlationId: "req-tool-0001",
  signal: new AbortController().signal,
  beforeEffect: () => true,
  chatId: f.chatId,
  userMessageId: "turn-1",
});

interface DetectedUnit {
  readonly id: string;
  readonly idOrigin: string;
  readonly reference: string;
}

/** The units the requirements tool lists for the Chat, as a model reads them. */
async function detectedUnits(f: PodFixture): Promise<readonly DetectedUnit[]> {
  const tool = createKnowledgeRequirementsProvider<RequirementsToolContext>(f.deps).tools()[0];
  const read = await tool?.execute({}, context(f));
  const items: unknown = read?.data.items;
  if (!Array.isArray(items)) throw new TypeError("the requirements tool listed no items");
  return (items as readonly DetectedUnit[]).map((unit) => ({
    id: unit.id,
    idOrigin: unit.idOrigin,
    reference: unit.reference,
  }));
}

/** What a Jira write carries for one requirement reference, from the production trace. */
function traceOf(f: PodFixture, reference: string): Trace {
  const session = openTraceSession(f.deps, {
    chatId: f.chatId,
    userMessageId: "turn-1",
    correlationId: "req-trace-0001",
  });
  try {
    const resolution = session.resolve([reference]);
    if (!resolution.ok) throw new TypeError(`trace refused: ${resolution.reason}`);
    return { labels: resolution.trace.labels, description: resolution.trace.footer };
  } finally {
    session.close();
  }
}

interface Trace {
  readonly labels: readonly string[];
  readonly description: string;
}

interface SyntheticIssue extends Trace {
  readonly key: string;
  readonly summary: string;
}

function jiraReading(issues: readonly SyntheticIssue[]): AtlassianHttpBodyPort {
  const respond = (body: unknown): Promise<AtlassianHttpBodyResult> => {
    const bodyText = JSON.stringify(body);
    return Promise.resolve({
      kind: "response",
      status: 200,
      bodyText,
      bodyBytes: Buffer.byteLength(bodyText),
      truncated: false,
    });
  };
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/field")) return respond([]);
    if (url.pathname.includes("/createmeta/"))
      return respond({
        values: [{ id: "11", name: "Story", subtask: false }],
        isLast: true,
        total: 1,
      });
    return respond({
      startAt: 0,
      maxResults: issues.length,
      total: issues.length,
      issues: issues.map((issue, index) => ({
        id: String(index + 1),
        key: issue.key,
        fields: {
          summary: issue.summary,
          project: { key: "SYN" },
          labels: [...issue.labels],
          description: issue.description,
          issuelinks: [],
          assignee: null,
          duedate: null,
          timeoriginalestimate: null,
          issuetype: { id: "11", name: "Story", subtask: false },
          status: { id: "1", name: "Open", statusCategory: { key: "new", name: "To Do" } },
        },
      })),
    });
  };
}

/** The requirement coverage `jira.report` serves through the production provider and Pod list. */
async function coverage(
  f: PodFixture,
  issues: readonly SyntheticIssue[],
  scope: CatalogJsonObject,
): Promise<readonly unknown[]> {
  const provider = createJiraProviderForCatalog<RequirementsToolContext>(
    () => ({
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      identity: "credential-1",
      http: jiraReading(issues),
    }),
    ["jira.report"],
    undefined,
    {
      store: createJiraReportStore(),
      owner: (invocation) => invocation.chatId,
      requirements: (invocation) => chatReportRequirementIds(f.deps, invocation),
    },
  );
  const result = await provider
    .tools()[0]
    ?.execute({ projectKey: "SYN", section: "requirements", ...scope }, context(f));
  expect(result?.isError).toBeUndefined();
  return (result?.data.section as { readonly items: readonly unknown[] }).items;
}

/** The coverage headline of the summary `jira.report` serves, as the person sees it. */
async function headline(
  f: PodFixture,
  issues: readonly SyntheticIssue[],
  scope: CatalogJsonObject,
): Promise<Record<string, unknown>> {
  const provider = createJiraProviderForCatalog<RequirementsToolContext>(
    () => ({
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      identity: "credential-1",
      http: jiraReading(issues),
    }),
    ["jira.report"],
    undefined,
    {
      store: createJiraReportStore(),
      owner: (invocation) => invocation.chatId,
      requirements: (invocation) => chatReportRequirementIds(f.deps, invocation),
    },
  );
  const result = await provider.tools()[0]?.execute({ projectKey: "SYN", ...scope }, context(f));
  expect(result?.isError).toBeUndefined();
  const report = result?.data.report as { coverage: { requirements: Record<string, unknown> } };
  return report.coverage.requirements;
}

describe("the requirement list Keiko hands jira.report", () => {
  it("lists the explicit identifiers of every Pod once, in the detected order", async () => {
    const f = await fixture([
      { capsuleId: "cap-a", text: specification(3).text },
      { capsuleId: "cap-b", text: specification(2, { prefix: "FR" }).text },
    ]);

    expect(chatReportRequirementIds(f.deps, context(f))).toEqual({
      ok: true,
      ids: ["LH-001", "LH-002", "LH-003", "FR-001", "FR-002"],
      labels: {},
    });
  });

  it("lists the derived handles with the explicit identifiers, in the detected order", async () => {
    const text = `${specification(2).text}\n### Ohne Kennung\n\nDas Portal muss Belege innerhalb von 5 Minuten verarbeiten.\n`;
    const f = await fixture([{ capsuleId: "cap-a", text }]);
    const detected = await detectedUnits(f);

    expect(detected.map((unit) => unit.idOrigin)).toEqual(["explicit", "explicit", "derived"]);
    const listed = chatReportRequirementIds(f.deps, context(f));
    expect(listed).toMatchObject({ ok: true, ids: detected.map((unit) => unit.id) });
    // Only the derived handle is named; it carries its section and the start of its statement.
    expect(Object.keys(listed.ok ? (listed.labels ?? {}) : {})).toEqual([detected[2]?.id]);
    expect(listed.ok ? listed.labels?.[detected[2]?.id ?? ""] : undefined).toMatch(
      /^Ohne Kennung: Das Portal muss Belege/u,
    );
  });

  it("lists a Pod whose requirements all carry derived handles", async () => {
    const text = "# Lastenheft\n\nDas Portal muss Belege innerhalb von 5 Minuten verarbeiten.\n";
    const f = await fixture([{ capsuleId: "cap-a", text }]);
    const detected = await detectedUnits(f);

    expect(detected.map((unit) => unit.idOrigin)).toEqual(["derived"]);
    const listed = chatReportRequirementIds(f.deps, context(f));
    expect(listed).toMatchObject({ ok: true, ids: [detected[0]?.id] });
    expect(listed.ok ? listed.labels?.[detected[0]?.id ?? ""] : undefined).toContain(
      "Das Portal muss Belege",
    );
  });

  it("keeps every unit and covered state of the explicit-id control, the derived one beside the headline", async () => {
    const text = `${specification(1).text}\n### Ohne Kennung\n\nDas Portal muss Belege innerhalb von 5 Minuten verarbeiten.\n`;
    const f = await fixture([{ capsuleId: "cap-a", text }]);
    const detected = await detectedUnits(f);
    const [explicit, derived] = [detected[0]?.id ?? "", detected[1]?.id ?? ""];
    const trace = traceOf(f, detected[0]?.reference ?? "");
    const issues = [{ key: "SYN-1", summary: "Delivers the explicit requirement", ...trace }];

    const automatic = await coverage(f, issues, { requirementsFromPods: true });
    const control = await coverage(f, issues, { requirementIds: [explicit, derived] });

    // Every item of the explicit-id control is still there, compared whole (coveredBy, itemCount,
    // byType …): the derived unit differs only by being flagged and named beside the headline.
    const plain = automatic.map((item) => {
      const { label: _label, derived: _derived, ...rest } = item as Record<string, unknown>;
      return rest;
    });
    expect(plain).toEqual(control);
    expect(automatic[0]).toMatchObject({ id: explicit, covered: true, coveredBy: ["SYN-1"] });
    expect(automatic[1]).toMatchObject({ id: derived, covered: false, derived: true });
    expect((automatic[1] as { label?: string }).label).toContain("Das Portal muss Belege");
    // The figure the person sees: the headline counts the explicit identifier only, the derived
    // unit is counted beside it and not in the denominator.
    expect(await headline(f, issues, { requirementsFromPods: true })).toMatchObject({
      declared: 1,
      covered: 1,
      derived: { declared: 1, covered: 0 },
    });
  });

  it("covers the derived requirement once an issue carries its production trace", async () => {
    const text = `${specification(1).text}\n### Ohne Kennung\n\nDas Portal muss Belege innerhalb von 5 Minuten verarbeiten.\n`;
    const f = await fixture([{ capsuleId: "cap-a", text }]);
    const detected = await detectedUnits(f);
    const trace = traceOf(f, detected[1]?.reference ?? "");

    const items = await coverage(f, [{ key: "SYN-2", summary: "Derived", ...trace }], {
      requirementsFromPods: true,
    });

    // The explicit headline first, then the derived unit beside it, covered by its trace.
    expect(items).toEqual([
      { id: detected[0]?.id, covered: false },
      expect.objectContaining({
        id: detected[1]?.id,
        covered: true,
        derived: true,
        coveredBy: ["SYN-2"],
      }),
    ]);
  });

  it("says in plain words what to do when the Chat has no Pod", async () => {
    const f = await fixture([], { bindPods: false });

    expect(chatReportRequirementIds(f.deps, context(f))).toMatchObject({
      ok: false,
      message: expect.stringContaining("requirementIds") as unknown,
    });
  });

  it("names the closed reason a Pod cannot be read yet", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);
    f.withStore((store) => {
      store._internal.db.prepare("UPDATE capsules SET lifecycle_state = 'indexing'").run();
    });

    expect(chatReportRequirementIds(f.deps, context(f))).toMatchObject({
      ok: false,
      message: expect.stringContaining("(indexing)") as unknown,
    });
  });

  it("answers a Pod without any identifier with a refusal, not an empty list", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: "# Leer\n\nNichts Verbindliches.\n" }]);

    expect(chatReportRequirementIds(f.deps, context(f))).toMatchObject({ ok: false });
  });
});
