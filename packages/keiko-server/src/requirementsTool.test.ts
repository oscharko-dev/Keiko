// #4179: the `knowledge.requirements` read tool pages the detected requirement units under byte and
// item bounds, states what it could not read, and never claims completeness.
import { sealedLocalPodModelUsePolicy } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { estimateTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createJiraReportStore, type JiraReportStore } from "@oscharko-dev/keiko-connectors";
import {
  REQUIREMENT_REVISION_LABEL_PREFIX,
  documentLabel,
  requirementLabel,
} from "@oscharko-dev/keiko-quality-intelligence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import {
  podFixture,
  specification,
  storeFinishedReport,
  storeReadingReport,
  type PodFixture,
  type ReportedIssue,
} from "./_requirementSupport.js";
import { estimateGatewayMessageTokens, fitToolContinuation } from "./chat-tool-continuation-fit.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetRequirementTurnCache } from "./requirement-inventory.js";
import {
  REQUIREMENTS_PAGE_BYTES_MAX,
  REQUIREMENTS_PAGE_LIMIT_MAX,
  createKnowledgeRequirementsProvider,
  type RequirementsToolContext,
} from "./requirementsTool.js";

let sink: BufferedServerLogSink;
let reports: JiraReportStore;
const fixtures: PodFixture[] = [];

beforeEach(() => {
  reports = createJiraReportStore();
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetServerLogger();
});

async function fixture(
  pods: Parameters<typeof podFixture>[0],
  options?: Parameters<typeof podFixture>[1],
): Promise<PodFixture> {
  const created = await podFixture(pods, options);
  fixtures.push(created);
  return created;
}

interface Page {
  readonly outcome: string;
  readonly reason?: string;
  readonly nextStep?: string;
  readonly view?: string;
  readonly totals?: Record<string, unknown>;
  readonly items?: readonly Record<string, unknown>[];
  readonly nextCursor?: string;
  readonly changes?: Record<string, unknown>;
}

async function call(f: PodFixture, args: CatalogJsonObject, turn = "turn-1"): Promise<Page> {
  const tool = createKnowledgeRequirementsProvider<RequirementsToolContext>(
    f.deps,
    reports,
  ).tools()[0];
  if (tool === undefined) throw new Error("expected the tool");
  const context: RequirementsToolContext = {
    invocationId: "inv-1",
    correlationId: "req-tool-0001",
    signal: new AbortController().signal,
    beforeEffect: () => true,
    chatId: f.chatId,
    userMessageId: turn,
  };
  const result = await tool.execute(args, context);
  return result.data as unknown as Page;
}

async function readAll(f: PodFixture, args: CatalogJsonObject = {}): Promise<readonly Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(f, { ...args, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length < 100);
  return pages;
}

function idsOf(pages: readonly Page[]): string[] {
  return pages.flatMap((page) => (page.items ?? []).map((item) => String(item.id)));
}

describe("paging (#4179 review, defect 2)", () => {
  it("pages 300 units in document order under the item and byte bounds, with honest totals", async () => {
    const spec = specification(300);
    const f = await fixture([{ capsuleId: "cap-big", text: spec.text }]);

    const pages = await readAll(f);

    expect(idsOf(pages)).toEqual(spec.ids);
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      expect(page.outcome).toBe("succeeded");
      expect((page.items ?? []).length).toBeLessThanOrEqual(25);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        REQUIREMENTS_PAGE_BYTES_MAX + 4096,
      );
    }
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    expect(pages[0]?.totals).toMatchObject({
      detectedCount: 300,
      matchedCount: 300,
      documentsScanned: 1,
      documentsNotExtracted: 0,
      documentsOmitted: 0,
      unitsOmitted: 0,
      cutReasons: [],
    });
  });

  it("fits a 32k-token model: every page stays within a quarter of the window and the turn continues", async () => {
    const f = await fixture([{ capsuleId: "cap-big", text: specification(300).text }]);
    const pages = await readAll(f);

    for (const page of pages)
      expect(estimateTokens(JSON.stringify(page))).toBeLessThanOrEqual(32_000 / 4);

    // The existing continuation fitting keeps the newest page whole and compacts older ones to
    // receipts that still name every unit read, so the model can list or reference them.
    const messages = pages.map((page, index) => ({
      role: "tool" as const,
      toolCallId: `call-${String(index)}`,
      content: JSON.stringify(page),
    }));
    const exchanges = pages.map(
      (page, index) =>
        ({
          call: { id: `call-${String(index)}` },
          result: { status: "completed", data: page },
        }) as unknown as ChatToolExchange,
    );
    const budget = 32_000 - 6_000 - 4_096;
    expect(estimateGatewayMessageTokens(messages)).toBeGreaterThan(budget);

    const fitted = fitToolContinuation(messages, exchanges, budget);

    expect(fitted.elidedCount).toBeGreaterThan(0);
    expect(estimateGatewayMessageTokens(fitted.messages)).toBeLessThanOrEqual(budget);
    expect(fitted.messages.at(-1)?.content).toBe(messages.at(-1)?.content);
    const compacted = JSON.parse(fitted.messages[0]?.content ?? "{}") as {
      requirements?: { reference: string; title: string }[];
    };
    expect(compacted.requirements?.[0]).toMatchObject({ title: "Thema 1" });
    expect(compacted.requirements).toHaveLength(25);
  });

  it("clamps the page size and keeps a single oversized unit as a page of its own", async () => {
    const f = await fixture([{ capsuleId: "cap-big", text: specification(80).text }]);

    const page = await call(f, { limit: REQUIREMENTS_PAGE_LIMIT_MAX });

    expect((page.items ?? []).length).toBeLessThanOrEqual(REQUIREMENTS_PAGE_LIMIT_MAX);
    expect(page.nextCursor).toBeDefined();
  });

  it("refuses a cursor from another selection or another version of a document", async () => {
    const f = await fixture([{ capsuleId: "cap-v1", text: specification(60).text }]);
    const first = await call(f, {});
    const cursor = first.nextCursor ?? "";

    const other = await call(f, { priorities: ["Soll"], cursor });
    const forged = await call(f, { cursor: "AAAA" });
    f.withStore((store) => {
      store._internal.db.prepare("UPDATE document_texts SET document_id = document_id").run();
    });
    resetRequirementTurnCache();
    const resumed = await call(f, { cursor });

    expect(other).toMatchObject({ outcome: "failed", reason: "cursor-stale" });
    expect(forged).toMatchObject({ outcome: "failed", reason: "cursor-stale" });
    expect(resumed.outcome).toBe("succeeded");
  });
});

describe("filters and views", () => {
  it("selects by ids, priorities, text and document without paging the rest", async () => {
    const spec = specification(40);
    const f = await fixture([{ capsuleId: "cap-a", text: spec.text }]);

    const byId = await readAll(f, { ids: ["LH-003", "LH-010"] });
    const byPriority = await readAll(f, { priorities: ["soll"] });
    const byText = await readAll(f, { query: "thema 17" });

    expect(idsOf(byId)).toEqual(["LH-003", "LH-010"]);
    expect(idsOf(byPriority).every((id) => Number(id.slice(3)) % 3 === 0)).toBe(true);
    expect(idsOf(byText)).toEqual(["LH-017"]);
    expect(byId[0]?.totals).toMatchObject({ detectedCount: 40, matchedCount: 2 });
  });

  it("returns the full unit: criteria, findings, location, scoped reference and revision", async () => {
    const f = await fixture([
      { capsuleId: "cap-a", text: specification(10).text, name: "Spec.md" },
    ]);

    const [page] = await readAll(f, { ids: ["LH-007"] });
    const unit = page?.items?.[0];

    expect(unit).toMatchObject({
      id: "LH-007",
      idOrigin: "explicit",
      unitKind: "block",
      title: "Thema 7",
      priority: "Muss",
      documentName: "Spec.md",
      sectionPath: ["Lastenheft", "LH-007 Thema 7"],
      pageLabel: "3",
      findings: ["ambiguity"],
      acceptanceCriteria: [
        { id: "LH-007/AC1", text: "Thema 7 ist verfügbar." },
        { id: "LH-007/AC2", text: "Fehler zu Thema 7 werden gemeldet." },
      ],
    });
    expect(String(unit?.reference)).toMatch(/^[0-9a-f]{8}:LH-007$/u);
    expect(String(unit?.revisionDigest)).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("lists the documents read, and label-only change queries batched per document", async () => {
    const f = await fixture([{ capsuleId: "cap-big", text: specification(120).text }]);

    const documents = await call(f, { view: "documents" });
    const queries = await readAll(f, { view: "change-queries" });

    expect(documents.items).toMatchObject([{ unitCount: 120, documentName: "cap-big.md" }]);
    const rows = queries.flatMap((page) => page.items ?? []);
    const stale = rows.filter((row) => row.purpose === "stale");
    expect(stale.length).toBeGreaterThan(3);
    expect(stale.every((row) => String(row.jql).length <= 1800)).toBe(true);
    expect(stale.flatMap((row) => row.requirementIds as string[])).toHaveLength(120);
    expect(rows.some((row) => row.purpose === "traced")).toBe(true);
  });

  it("redacts document text with the Chat content policy before it reaches the model", async () => {
    const text = specification(3).text.replace("Thema 2;", "Thema 2 mit SECRET-KEY-123;");
    const f = await fixture([{ capsuleId: "cap-a", text }], {
      redactor: (value) =>
        typeof value === "string" ? value.replaceAll("SECRET-KEY-123", "[REDACTED]") : value,
    });

    const [page] = await readAll(f, { ids: ["LH-002"] });

    expect(JSON.stringify(page)).not.toContain("SECRET-KEY-123");
    expect(JSON.stringify(page)).toContain("[REDACTED]");
  });
});

describe("what the tool says it could not read (#4179 review, defect 12)", () => {
  it("counts documents of the scope that are not text-extracted instead of hiding them", async () => {
    const f = await fixture([
      { capsuleId: "cap-a", text: specification(5).text },
      { capsuleId: "cap-b", text: specification(5, { prefix: "FR" }).text },
    ]);
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE documents SET status = 'unsupported' WHERE capsule_id = 'cap-b'")
        .run();
    });

    const [page] = await readAll(f);

    expect(page?.totals).toMatchObject({
      detectedCount: 5,
      documentsScanned: 1,
      documentsNotExtracted: 1,
    });
  });

  it.each([
    ["indexing", "indexing"],
    ["stale", "stale"],
    ["error", "error"],
    ["draft", "not-ready"],
  ])("refuses a Pod in state %s with the reason %s", async (state, reason) => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(5).text }]);
    f.withStore((store) => {
      store._internal.db.prepare("UPDATE capsules SET lifecycle_state = ?").run(state);
    });

    const page = await call(f, {});

    expect(page).toMatchObject({ outcome: "failed", reason });
  });

  describe("the sealed-local floor (#4179, #4180)", () => {
    const sealedText = specification(4, { prefix: "GEHEIM" }).text;

    function seal(f: PodFixture, capsuleId: string, policyJson: string | null): void {
      f.withStore((store) => {
        store._internal.db
          .prepare("UPDATE capsules SET model_use_policy_json = ? WHERE id = ?")
          .run(policyJson, capsuleId);
      });
    }

    it.each([
      ["an explicitly sealed-local Pod", JSON.stringify(sealedLocalPodModelUsePolicy())],
      ["a Pod without a recorded policy (legacy default)", null],
    ])("refuses %s with policy-denied and releases no document content", async (_name, policy) => {
      const f = await fixture([{ capsuleId: "cap-sealed", text: sealedText }]);
      seal(f, "cap-sealed", policy);

      const page = await call(f, {});

      expect(page).toMatchObject({ outcome: "failed", reason: "policy-denied" });
      expect(page.items).toBeUndefined();
      expect(JSON.stringify(page)).not.toContain("GEHEIM");
      expect(JSON.stringify(page)).not.toContain("Thema");
    });

    it("serves the open Pod of a Chat and nothing of its sealed-local sibling", async () => {
      const f = await fixture([
        { capsuleId: "cap-open", text: specification(3).text },
        { capsuleId: "cap-sealed", text: sealedText },
      ]);
      seal(f, "cap-sealed", JSON.stringify(sealedLocalPodModelUsePolicy()));

      const pages = await readAll(f);

      expect(idsOf(pages)).toEqual(["LH-001", "LH-002", "LH-003"]);
      expect(JSON.stringify(pages)).not.toContain("GEHEIM");
      expect(pages[0]?.totals).toMatchObject({
        documentsScanned: 1,
        refusals: ["policy-denied"],
        cutReasons: ["scope-refused"],
      });
    });

    it("records the refusal on the Activity Log without any document text", async () => {
      const f = await fixture([{ capsuleId: "cap-sealed", text: sealedText }]);
      seal(f, "cap-sealed", JSON.stringify(sealedLocalPodModelUsePolicy()));

      await call(f, {});

      const lines = sink.events
        .filter((event) => event.op === "knowledge.requirements.read")
        .map((event) =>
          expectActivityLogProof(
            "knowledge.requirements.read.line",
            formatActivityLogProofLine(event),
          ),
        );
      expect(lines).toHaveLength(1);
      // The sealed Pod was never opened: nothing was scanned, detected or returned.
      expect(lines[0]).toMatchObject({
        disposition: "refused",
        documentsScanned: 0,
        detectedCount: 0,
        returnedCount: 0,
      });
      expect(JSON.stringify(lines)).not.toContain("GEHEIM");
    });
  });

  it("answers a Chat without a Knowledge Pod with a closed reason, not an empty list", async () => {
    const f = await fixture([], { bindPods: false });

    expect(await call(f, {})).toMatchObject({ outcome: "failed", reason: "no-knowledge-pod" });
  });

  it("reads every Pod of the Chat, honouring the plural scope list", async () => {
    const f = await fixture([
      { capsuleId: "cap-a", text: specification(3).text },
      { capsuleId: "cap-b", text: specification(3, { prefix: "FR" }).text },
    ]);

    const pages = await readAll(f);

    expect(idsOf(pages)).toEqual(["LH-001", "LH-002", "LH-003", "FR-001", "FR-002", "FR-003"]);
    expect(pages[0]?.totals).toMatchObject({ documentsScanned: 2 });
  });
});

describe("several documents (#4179 review, defects 6 and 7)", () => {
  it("keeps equal identifiers of two documents apart, reports them as ambiguous and scopes each", async () => {
    const f = await fixture([
      { capsuleId: "cap-a", text: specification(3).text, name: "A.md" },
      {
        capsuleId: "cap-b",
        text: specification(3).text.replace("Thema 2;", "Thema zwei;"),
        name: "B.md",
      },
    ]);

    const pages = await readAll(f);
    const units = pages.flatMap((page) => page.items ?? []);

    expect(units).toHaveLength(6);
    expect(new Set(units.map((unit) => unit.reference)).size).toBe(6);
    expect(new Set(units.map((unit) => unit.documentScope)).size).toBe(2);
    expect(pages[0]?.totals).toMatchObject({ ambiguousIds: ["LH-001", "LH-002", "LH-003"] });
    const [first, second] = [
      units.find((unit) => unit.id === "LH-002" && unit.documentName === "A.md"),
      units.find((unit) => unit.id === "LH-002" && unit.documentName === "B.md"),
    ];
    expect(first?.revisionDigest).not.toBe(second?.revisionDigest);
  });

  it("gives the same statement in two documents different derived identifiers", async () => {
    const sentence = "Das System muss alle Eingaben protokollieren.";
    const f = await fixture([
      { capsuleId: "cap-a", text: sentence },
      { capsuleId: "cap-b", text: sentence },
    ]);

    const units = (await readAll(f)).flatMap((page) => page.items ?? []);

    expect(units.map((unit) => unit.idOrigin)).toEqual(["derived", "derived"]);
    expect(new Set(units.map((unit) => unit.id)).size).toBe(2);
  });
});

describe("evidence on the Activity Log (#4179)", () => {
  it("records each read with closed words and counts, without any document text", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(60).text }]);

    const first = await call(f, {});
    await call(f, { cursor: first.nextCursor ?? "" });

    const lines = sink.events
      .filter((event) => event.op === "knowledge.requirements.read")
      .map((event) =>
        expectActivityLogProof(
          "knowledge.requirements.read.line",
          formatActivityLogProofLine(event),
        ),
      );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      correlationId: "req-tool-0001",
      view: "units",
      disposition: "served",
      cursorUsed: false,
      detectedCount: 60,
      matchedCount: 60,
      returnedCount: 25,
      documentsScanned: 1,
      hasNextPage: true,
    });
    expect(lines[1]).toMatchObject({ cursorUsed: true, returnedCount: 25 });
    expect(JSON.stringify(lines)).not.toContain("Thema");
  });

  it("records a refusal and an unreadable store", async () => {
    const f = await fixture([], { bindPods: false });
    await call(f, {});
    const broken = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);
    broken.withStore((store) => {
      store._internal.db.prepare("DROP TABLE documents").run();
    });
    // The store is unreadable: the tool reports it as unavailable and logs a warning line.
    await call(broken, {});

    const dispositions = sink.events
      .filter((event) => event.op === "knowledge.requirements.read")
      .map(
        (event) =>
          expectActivityLogProof(
            "knowledge.requirements.read.line",
            formatActivityLogProofLine(event),
          ).disposition,
      );
    expect(dispositions).toEqual(["refused", "unavailable"]);
  });
});

// ─── The change set of a new document version (#4179) ───────────────────────────────────────────

/** The labels a trace of these units leaves on an item: what Jira holds about its source. */
async function traceLabels(f: PodFixture, ids: readonly string[]): Promise<readonly string[]> {
  const [page] = await readAll(f, { ids: [...ids] });
  const units = page?.items ?? [];
  return [
    "keiko-requirement",
    ...new Set(units.map((unit) => documentLabel(String(unit.documentScope)))),
    ...units.map((unit) => requirementLabel(String(unit.id))),
    ...units.map((unit) => `${REQUIREMENT_REVISION_LABEL_PREFIX}${String(unit.revisionDigest)}`),
  ];
}

function withoutRequirement(text: string, id: string): string {
  return text.replace(new RegExp(String.raw`### ${id} [\s\S]*?(?=### |$)`, "u"), "");
}

/** Version 1 has five requirements; version 2 revises LH-002, drops LH-004 and adds LH-006. */
async function twoVersions(): Promise<{ v1: PodFixture; v2: PodFixture }> {
  const v1 = await fixture([{ capsuleId: "cap-a", text: specification(5).text }]);
  const next = withoutRequirement(specification(6, { revise: [2] }).text, "LH-004");
  const v2 = await fixture([{ capsuleId: "cap-a", text: next }]);
  return { v1, v2 };
}
async function backlogOfVersion1(v1: PodFixture): Promise<readonly ReportedIssue[]> {
  const ids = ["LH-001", "LH-002", "LH-003", "LH-004"];
  const issues = await Promise.all(
    ids.map(async (id, index) => ({
      key: `REQ-${String(index + 1)}`,
      labels: await traceLabels(v1, [id]),
    })),
  );
  return [...issues, { key: "REQ-9", labels: ["unrelated"] }];
}

describe("the change set against the backlog (#4179)", () => {
  it("names the changed, removed and not yet traced requirements and the items they affect", async () => {
    const { v1, v2 } = await twoVersions();
    resetRequirementTurnCache();
    const reportId = storeFinishedReport(reports, v2.chatId, await backlogOfVersion1(v1));

    const page = await call(v2, { view: "changes", reportId });

    expect(page).toMatchObject({ outcome: "succeeded", view: "changes" });
    expect(page.changes).toMatchObject({
      baseline: { complete: true, tracedIssueCount: 4, unmatchedIssueCount: 0 },
      counts: { changed: 1, removed: 1, untraced: 2, unchanged: 2 },
      changed: [{ id: "LH-002", issues: ["REQ-2"] }],
      removed: [{ id: "LH-004", issues: ["REQ-4"] }],
      unchanged: ["LH-001", "LH-003"],
      untraced: ["LH-005", "LH-006"],
      affectedIssues: ["REQ-2", "REQ-4"],
    });
    expect(page.changes).not.toHaveProperty("truncated");
    expect(page.nextCursor).toBeUndefined();
  });

  it("states that a partly read backlog cannot prove a requirement is untraced", async () => {
    const { v1, v2 } = await twoVersions();
    resetRequirementTurnCache();
    const reportId = storeFinishedReport(reports, v2.chatId, await backlogOfVersion1(v1), {
      complete: false,
    });

    const page = await call(v2, { view: "changes", reportId });

    expect(page.changes).toMatchObject({ baseline: { complete: false, issuesRead: 5 } });
  });

  it.each([
    ["no report", undefined, "report-required"],
    ["an unknown report", "00000000-0000-4000-8000-000000000000", "report-not-found"],
  ])("refuses %s with a closed reason", async (_name, reportId, reason) => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);

    const page = await call(f, {
      view: "changes",
      ...(reportId === undefined ? {} : { reportId }),
    });

    expect(page).toMatchObject({ outcome: "failed", reason });
  });

  it("does not hand one Chat the report of another", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);
    const reportId = storeFinishedReport(reports, "another-chat", []);

    expect(await call(f, { view: "changes", reportId })).toMatchObject({
      outcome: "failed",
      reason: "report-not-found",
    });
  });

  it("bounds the lists, keeps every count exact and says what was cut", async () => {
    const f = await fixture([{ capsuleId: "cap-big", text: specification(300).text }]);
    const reportId = storeFinishedReport(reports, f.chatId, []);

    const page = await call(f, { view: "changes", reportId });

    expect(page.changes).toMatchObject({
      counts: { changed: 0, removed: 0, untraced: 300, unchanged: 0 },
      truncated: ["untraced"],
    });
    expect((page.changes?.untraced as string[]).length).toBeLessThan(300);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      REQUIREMENTS_PAGE_BYTES_MAX + 8192,
    );
  });

  it("compares with the report the Chat read in this turn, without a report id (S14)", async () => {
    const { v1, v2 } = await twoVersions();
    resetRequirementTurnCache();
    const reportId = storeFinishedReport(reports, v2.chatId, await backlogOfVersion1(v1));

    const named = await call(v2, { view: "changes", reportId });
    const byProject = await call(v2, { view: "changes", projectKey: "REQ" });
    const byDefault = await call(v2, { view: "changes" });

    expect(byProject).toEqual(named);
    expect(byDefault).toEqual(named);
    expect(byProject.changes).toMatchObject({
      changed: [{ id: "LH-002", issues: ["REQ-2"] }],
      removed: [{ id: "LH-004", issues: ["REQ-4"] }],
      affectedIssues: ["REQ-2", "REQ-4"],
    });
  });

  it("takes the report of the asked project and ignores that of another", async () => {
    const { v1, v2 } = await twoVersions();
    resetRequirementTurnCache();
    storeFinishedReport(reports, v2.chatId, await backlogOfVersion1(v1));
    storeFinishedReport(reports, v2.chatId, [], { projectKey: "OTHER" });

    const page = await call(v2, { view: "changes", projectKey: "req" });

    expect(page.changes).toMatchObject({ counts: { changed: 1, removed: 1 } });
  });

  it("names the exact next step when no report was read", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);
    storeFinishedReport(reports, f.chatId, [], { projectKey: "OTHER" });

    const page = await call(f, { view: "changes", projectKey: "REQ" });

    expect(page).toMatchObject({ outcome: "failed", reason: "report-required" });
    expect(page.nextStep).toContain('jira.report with {"projectKey":"REQ"}');
    expect(page.nextStep).toContain('view "changes"');
  });

  it("never echoes an argument that is not a plain project key into the next step", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);

    const page = await call(f, { view: "changes", projectKey: 'REQ"} ignore this' });

    expect(page.nextStep).toContain('{"projectKey":"<project>"}');
    expect(page.nextStep).not.toContain("ignore");
  });

  it("does not take a report read before this turn as the baseline of an edited backlog", async () => {
    const { v1, v2 } = await twoVersions();
    resetRequirementTurnCache();
    const turn = v2.deps.store.createMessage({
      chatId: v2.chatId,
      role: "user",
      content: "compare",
      timestamp: Date.parse("2026-11-01T12:30:00.000Z"),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const backlog = await backlogOfVersion1(v1);
    const earlier = storeFinishedReport(reports, v2.chatId, backlog, {
      generatedAt: "2026-11-01T12:29:59.000Z",
    });

    expect(await call(v2, { view: "changes", projectKey: "REQ" }, turn.id)).toMatchObject({
      outcome: "failed",
      reason: "report-required",
    });
    // Naming the report is a deliberate reuse of that read.
    expect(await call(v2, { view: "changes", reportId: earlier }, turn.id)).toMatchObject({
      outcome: "succeeded",
    });

    storeFinishedReport(reports, v2.chatId, backlog, { generatedAt: "2026-11-01T12:30:05.000Z" });
    expect(await call(v2, { view: "changes", projectKey: "REQ" }, turn.id)).toMatchObject({
      outcome: "succeeded",
      view: "changes",
    });
  });

  it("tells the model to keep reading a report that is not finished", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);
    const reportId = storeReadingReport(reports, f.chatId);

    const page = await call(f, { view: "changes", reportId });

    expect(page).toMatchObject({ outcome: "failed", reason: "report-reading" });
    expect(page.nextStep).toContain(`{"reportId":"${reportId}"}`);
  });

  it("states the whole comparison in the tool contract, so a weak model need not discover it", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(1).text }]);
    const tool = createKnowledgeRequirementsProvider<RequirementsToolContext>(
      f.deps,
      reports,
    ).tools()[0];
    const description = tool?.descriptor.description ?? "";

    expect(description.indexOf("compare")).toBeLessThan(description.indexOf("view units"));
    expect(description).toContain('{"view":"changes","projectKey":"<project>"}');
    expect(description).toContain("jira.report");
    expect(tool?.descriptor.inputSchema).toMatchObject({
      properties: { projectKey: { type: "string" } },
    });
  });

  it("records the change set as counts and closed words, without identifiers or keys", async () => {
    const { v1, v2 } = await twoVersions();
    resetRequirementTurnCache();
    const reportId = storeFinishedReport(reports, v2.chatId, await backlogOfVersion1(v1));
    await call(v2, { view: "changes", reportId });
    await call(v2, { view: "changes", projectKey: "REQ" });
    await call(v2, { view: "changes", reportId: "00000000-0000-4000-8000-000000000000" });

    const lines = sink.events
      .filter((event) => event.op === "knowledge.requirements.read")
      .map((event) =>
        expectActivityLogProof(
          "knowledge.requirements.read.line",
          formatActivityLogProofLine(event),
        ),
      )
      .filter((line) => line.view === "changes");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.baselineSource)).toEqual(["explicit", "turn", undefined]);
    expect(lines[0]).toMatchObject({
      view: "changes",
      disposition: "served",
      changedCount: 1,
      removedCount: 1,
      untracedCount: 2,
      unchangedCount: 2,
      affectedIssueCount: 2,
      baselineIssueCount: 4,
      baselineComplete: true,
    });
    expect(lines[2]).toMatchObject({
      view: "changes",
      disposition: "refused",
      refusal: "report-not-found",
    });
    expect(JSON.stringify(lines)).not.toMatch(/REQ-\d|LH-\d/u);
  });
});
