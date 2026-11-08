// Source regressions for the live journey's independent verdicts, not live qualification.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  gradeRuleRefusal,
  gradeCorrectedCreate,
  gradeProseBoundary,
  completeRequirementPages,
  gradeDocumentInventory,
  gradeDerivedEpics,
  gradeEpicVisibility,
} from "../testing/jira-chat-lab/rules-knowledge-oracles.mjs";
import { buildCorpus, STRUCTURE_RULES } from "../testing/jira-chat-lab/requirements/corpus.mjs";

const old = { id: "1", key: "REQ-1", fields: { summary: "Existing", labels: [] } };
const exchange = (operation, data, args = {}, status = "completed") => ({
  call: { id: "synthetic-call", name: operation.replaceAll(/[.-]/gu, "_"), arguments: args },
  result: {
    schemaVersion: 1,
    invocationId: "synthetic-invocation",
    toolRef: { canonicalId: `keiko.${operation}`, contractVersion: 1 },
    projectionDigest: null,
    effectStarted: false,
    metrics: { inputBytes: 0, outputBytes: 0, resultCount: 1, durationMs: 0 },
    status,
    reason: status === "completed" ? "none" : "provider-reported-error",
    page: status === "completed" ? { truncated: false, reason: "none", cursor: null } : null,
    data,
  },
});
const refusal = () =>
  exchange(
    "jira.create",
    {
      outcome: "rejected",
      reason: "field-validation",
      violations: [{ ruleId: "summary-pattern", template: "REQ/Epic" }],
    },
    {},
    "failed",
  );
const success = (key) => exchange("jira.create", { outcome: "succeeded", issueKey: key });
const nativeEpic = (id, requirement = "LH-901") => ({
  id,
  key: `REQ-${id}`,
  fields: {
    issuetype: { name: "Epic" },
    summary: `[${requirement}] Synthetic title`,
    labels: ["anforderung"],
    description: STRUCTURE_RULES.Epic.sections
      .map((name) => `h2. ${name}\nMeaningful text.`)
      .join("\n\n"),
  },
});

describe("formal-rule evidence from normal UI turns", () => {
  it("requires the actual parent-type refusal, not a generic missing-parent or content failure", () => {
    const evidence = {
      before: [old],
      after: [old],
      template: "REQ/Sub-task",
      ruleId: "parent-type-mismatch",
      exchanges: [
        exchange(
          "jira.create",
          {
            outcome: "rejected",
            reason: "field-validation",
            violations: [{ ruleId: "parent-type-mismatch", template: "REQ/Sub-task" }],
          },
          {},
          "failed",
        ),
      ],
    };
    expect(gradeRuleRefusal(evidence)).toBe(true);
    for (const ruleId of ["parent-missing", "section-missing", "template-unreadable"])
      expect(
        gradeRuleRefusal({
          ...evidence,
          exchanges: [
            exchange(
              "jira.create",
              {
                outcome: "rejected",
                reason: "field-validation",
                violations: [{ ruleId, template: "REQ/Sub-task" }],
              },
              {},
              "failed",
            ),
          ],
        }),
      ).toBe(false);
    expect(gradeRuleRefusal({ ...evidence, after: [old, nativeEpic("2")] })).toBe(false);
  });
  it("requires native non-effect and the actual scoped rule refusal, not assistant prose or a generic failure", () => {
    const evidence = { before: [old], after: [old], template: "REQ/Epic", exchanges: [refusal()] };
    expect(gradeRuleRefusal(evidence)).toBe(true);
    expect(gradeRuleRefusal({ ...evidence, exchanges: [] })).toBe(false);
    expect(
      gradeRuleRefusal({
        ...evidence,
        exchanges: [exchange("jira.create", { outcome: "rejected", reason: "permission-denied" })],
      }),
    ).toBe(false);
    expect(gradeRuleRefusal({ ...evidence, template: "OTHER/Epic" })).toBe(false);
    expect(gradeRuleRefusal({ ...evidence, after: [old, nativeEpic("2")] })).toBe(false);
    expect(
      gradeRuleRefusal({ ...evidence, after: [{ ...old, fields: { summary: "Changed" } }] }),
    ).toBe(false);
    expect(
      gradeRuleRefusal({ ...evidence, exchanges: [{ ...refusal(), effectStarted: true }] }),
    ).toBe(false);
  });

  it("rejects a formal refusal whose actual result receipt says an effect started", () => {
    const refused = refusal();
    const started = { ...refused, result: { ...refused.result, effectStarted: true } };
    expect(
      gradeRuleRefusal({ before: [old], after: [old], template: "REQ/Epic", exchanges: [started] }),
    ).toBe(false);
  });

  it("does not infer native non-effect from a missing result receipt flag", () => {
    const refused = refusal();
    const { effectStarted, ...result } = refused.result;
    expect(effectStarted).toBe(false);
    expect(
      gradeRuleRefusal({
        before: [old],
        after: [old],
        template: "REQ/Epic",
        exchanges: [{ ...refused, result }],
      }),
    ).toBe(false);
  });

  it("rejects failed data outside the provider-reported-error envelope arm", () => {
    const refused = refusal();
    const invalid = { ...refused, result: { ...refused.result, reason: "none" } };
    expect(
      gradeRuleRefusal({ before: [old], after: [old], template: "REQ/Epic", exchanges: [invalid] }),
    ).toBe(false);
  });

  it("does not count a corrected answer without exact confirmed receipt and independently conforming Jira fields", () => {
    const epic = nativeEpic("2");
    const evidence = {
      before: [old],
      after: [old, epic],
      requirementId: "LH-901",
      exchanges: [success("REQ-2")],
    };
    expect(gradeCorrectedCreate(evidence)).toBe(true);
    expect(gradeCorrectedCreate({ ...evidence, exchanges: [success("REQ-9")] })).toBe(false);
    expect(
      gradeCorrectedCreate({
        ...evidence,
        after: [old, { ...epic, fields: { ...epic.fields, labels: [] } }],
      }),
    ).toBe(false);
    expect(
      gradeCorrectedCreate({
        ...evidence,
        exchanges: [exchange("jira.create", { outcome: "unconfirmed", issueKey: "REQ-2" })],
      }),
    ).toBe(false);
    expect(gradeCorrectedCreate({ ...evidence, after: [old, epic, nativeEpic("3")] })).toBe(false);
  });

  it("proves prose is not a hard gate only when the deliberate label exception actually persists", () => {
    const epic = nativeEpic("2");
    const evidence = {
      before: [old],
      after: [old, epic],
      exchanges: [success("REQ-2")],
      forbiddenLabel: "prose-only-required",
    };
    expect(gradeProseBoundary(evidence)).toBe(true);
    expect(
      gradeProseBoundary({
        ...evidence,
        after: [old, { ...epic, fields: { ...epic.fields, labels: ["prose-only-required"] } }],
      }),
    ).toBe(false);
    expect(gradeProseBoundary({ ...evidence, exchanges: [refusal()] })).toBe(false);
  });

  it("independently binds corrected Task/Bug Epic fields and the Sub-task's native parent and subtype", () => {
    for (const issueType of ["Task", "Bug", "Sub-task"]) {
      const subtask = issueType === "Sub-task";
      const rule = subtask ? STRUCTURE_RULES.Task : STRUCTURE_RULES[issueType];
      const issue = {
        id: "2",
        key: "REQ-2",
        fields: {
          issuetype: { name: issueType, subtask },
          summary: "[LH-902] Corrected child",
          description: rule.sections.map((section) => `h2. ${section}\nText.`).join("\n\n"),
          customfield_10000: "REQ-1",
          parent: { key: "REQ-1" },
          priority: { id: "3" },
        },
      };
      const evidence = {
        before: [old],
        after: [old, issue],
        exchanges: [success("REQ-2")],
        requirementId: "LH-902",
        issueType,
        parentKey: "REQ-1",
        epicLinkFieldId: "customfield_10000",
      };
      expect(gradeCorrectedCreate(evidence)).toBe(true);
      expect(gradeCorrectedCreate({ ...evidence, parentKey: "REQ-999" })).toBe(false);
      if (issueType === "Bug")
        expect(
          gradeCorrectedCreate({
            ...evidence,
            after: [old, { ...issue, fields: { ...issue.fields, priority: undefined } }],
          }),
        ).toBe(false);
      if (subtask)
        expect(
          gradeCorrectedCreate({
            ...evidence,
            after: [
              old,
              {
                ...issue,
                fields: { ...issue.fields, issuetype: { name: "Sub-task", subtask: false } },
              },
            ],
          }),
        ).toBe(false);
    }
  });
});

function inventory(cursor, nextCursor, items = []) {
  return exchange(
    "knowledge.requirements",
    {
      outcome: "succeeded",
      view: "units",
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      totals: { documentsNotExtracted: 0 },
    },
    cursor === undefined ? {} : { cursor },
  );
}

describe("document retrieval, source trace and distinct board views", () => {
  it("does not let an unrelated terminal page, missing middle page or cursor cycle prove complete retrieval", () => {
    expect(
      completeRequirementPages([inventory(undefined, "middle"), inventory("middle", undefined)]),
    ).toHaveLength(2);
    expect(
      completeRequirementPages([inventory(undefined, "missing"), inventory("foreign", undefined)]),
    ).toBeUndefined();
    expect(
      completeRequirementPages([inventory(undefined, "loop"), inventory("loop", "loop")]),
    ).toBeUndefined();
    expect(completeRequirementPages([inventory("tail", undefined)])).toBeUndefined();
  });

  it("requires each supported format's actual extracted IDs, priorities and criteria", () => {
    const truth = buildCorpus(1).truth;
    const items = [".docx", ".pdf", ".xlsx", ".pptx"].flatMap((extension) =>
      truth.map((item) => ({
        id: item.id,
        idOrigin: "explicit",
        title: item.title,
        priority: item.priority,
        acceptanceCriteria: item.acceptance.map((text) => ({ text })),
        documentName: `Specification${extension}`,
      })),
    );
    expect(gradeDocumentInventory([inventory(undefined, undefined, items)], truth)).toBe(true);
    expect(
      gradeDocumentInventory(
        [
          inventory(
            undefined,
            undefined,
            items.filter((item) => !item.documentName.endsWith(".pdf")),
          ),
        ],
        truth,
      ),
    ).toBe(false);
    expect(
      gradeDocumentInventory(
        [
          inventory(
            undefined,
            undefined,
            items.map((item) => ({ ...item, priority: "invented" })),
          ),
        ],
        truth,
      ),
    ).toBe(false);
    expect(
      gradeDocumentInventory(
        [
          inventory(
            undefined,
            undefined,
            items.map((item) => ({
              ...item,
              acceptanceCriteria: item.acceptanceCriteria.map(() => ({
                text: "fabricated criterion",
              })),
            })),
          ),
        ],
        truth,
      ),
    ).toBe(false);
    expect(gradeDocumentInventory([], truth)).toBe(false);
  });

  it("rejects UUID-only references, wrong issue types, duplicate epics and answer-only keys", () => {
    const requirement = buildCorpus(1).truth[0];
    const reference = "document-scope:LH-001";
    const epic = nativeEpic("2", requirement.id);
    epic.fields.description +=
      `\n${requirement.acceptance.join("\n")}\nKeiko traceability\n` +
      `Requirement: ${requirement.id}\nReference: ${reference}\nSource: Specification.docx · 2. Anmeldung\nEnd of Keiko traceability`;
    const evidence = {
      before: [old],
      after: [old, epic],
      truth: [requirement],
      answer: "Created REQ-2",
      documentNames: ["Specification.docx"],
      inventoryExchanges: [inventory(undefined, undefined, [{ id: requirement.id, reference }])],
      exchanges: [
        exchange(
          "jira.create",
          { outcome: "succeeded", issueKey: "REQ-2" },
          { requirementIds: [reference] },
        ),
      ],
    };
    expect(gradeDerivedEpics(evidence)).toBe(true);
    expect(gradeDerivedEpics({ ...evidence, answer: "All done" })).toBe(false);
    expect(gradeDerivedEpics({ ...evidence, exchanges: [success("REQ-2")] })).toBe(false);
    expect(
      gradeDerivedEpics({
        ...evidence,
        inventoryExchanges: [inventory(undefined, undefined, [{ id: "LH-999", reference }])],
      }),
    ).toBe(false);
    expect(
      gradeDerivedEpics({
        ...evidence,
        after: [
          old,
          {
            ...epic,
            fields: { ...epic.fields, description: "5a9f6306-119d-4ca0-ac4d-7326b4f65843" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      gradeDerivedEpics({
        ...evidence,
        after: [old, { ...epic, fields: { ...epic.fields, issuetype: { name: "Task" } } }],
      }),
    ).toBe(false);
    expect(
      gradeDerivedEpics({ ...evidence, after: [old, epic, { ...epic, id: "3", key: "REQ-3" }] }),
    ).toBe(false);
  });

  it("requires separate actual Epic and backlog reads and does not treat backlog absence as missing Epic", () => {
    const created = [nativeEpic("2")];
    const exchanges = ["jira.board-epics", "jira.board-backlog"].map((operation) =>
      exchange(operation, {}, { boardId: "7" }),
    );
    const evidence = {
      created,
      boardEpics: [{ id: "2" }],
      backlog: [{ id: "8" }],
      exchanges,
      boardId: "7",
    };
    expect(gradeEpicVisibility(evidence)).toBe(true);
    expect(gradeEpicVisibility({ ...evidence, boardEpics: [] })).toBe(false);
    expect(gradeEpicVisibility({ ...evidence, backlog: [{ id: "2" }] })).toBe(false);
    expect(gradeEpicVisibility({ ...evidence, exchanges: exchanges.slice(0, 1) })).toBe(false);
    expect(gradeEpicVisibility({ ...evidence, boardId: "9" })).toBe(false);
  });
});

describe("live UI journey wiring", () => {
  const read = (name) =>
    readFileSync(new globalThis.URL(`../testing/jira-chat-lab/${name}`, import.meta.url), "utf8");

  it("uses real UI controls for all setup mutations and shares the real browser turn owner", () => {
    const setup = read("browser-rules-knowledge-setup.mjs");
    for (const control of [
      "Create Knowledge Pod",
      "Source path",
      "Relative document paths",
      "Index this Knowledge Pod now",
      "Use in this chat",
      "Active in this chat",
      "Matches Jira.",
    ])
      expect(setup).toContain(control);
    expect(setup).not.toMatch(
      /page\.route\(|\.request\.(?:post|put|patch|delete)\(|jsonRequest\(/u,
    );
    expect(setup).toMatch(
      /assert\.equal\(\s*templates\.some\(\(entry\) => entry\.id === skill\.id\),\s*false,/u,
    );
    const journey = read("browser-rules-knowledge-journey.mjs");
    expect(journey).toContain('from "./browser-workflow-turn.mjs"');
    expect(journey).toContain("await opened.page.reload()");
    expect(journey).toContain('name: "Jira results"');
    expect(journey).toContain('parentField: "parent"');
    expect(journey).toContain('parentIssueTypes: ["Task"]');
    expect(journey).toContain('ruleId: "parent-type-mismatch"');
    expect(journey).toContain("taskParentTypeRuleSupported: true");
    const cli = read("browser-rules-knowledge.mjs");
    expect(cli).toContain("withWorkProjectLock");
    const source = ts.createSourceFile("journey.mjs", cli, ts.ScriptTarget.Latest, true);
    const reservations = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "privateJson" &&
        node.arguments.length === 3
      )
        reservations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(reservations).toHaveLength(1);
    const [path, state, exclusive] = reservations[0].arguments;
    expect(path.getText(source)).toBe("intentPath");
    expect(ts.isObjectLiteralExpression(state)).toBe(true);
    expect(
      Object.fromEntries(
        state.properties.map((property) => [
          property.name.getText(source),
          property.initializer.getText(source),
        ]),
      ),
    ).toEqual({ schemaVersion: "1", scenario: '"rules-knowledge"', phase: '"reserved"' });
    expect(exclusive.kind).toBe(ts.SyntaxKind.TrueKeyword);
    expect(cli).toContain("embeddingModelId: options.embeddingModelId");
    expect(cli).not.toContain("clearWorkProject");
  });
});
