import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as goldenOracle from "../testing/jira-chat-lab/requirements/golden-jira-oracle.mjs";
import { EPIC_SUMMARY_VIOLATION } from "../testing/jira-chat-lab/requirements/templates.mjs";
import {
  goldenJiraReadAdapter,
  gradeGoldenEpics,
  gradeGoldenEpicViews,
  readGoldenBoardViews,
  readGoldenIssues,
  validateGoldenManifest,
} from "../testing/jira-chat-lab/requirements/golden-jira-oracle.mjs";
import {
  planDeliberateViolations,
  planEpicBatches,
  runBrowserEpicsBulk,
  runBulkEpics,
} from "../testing/jira-chat-lab/browser-epics-bulk.mjs";

const PROJECT = "LIM7";
const REQUIREMENTS = [
  {
    id: "REQ-FA-001",
    title: "Exact first requirement",
    acceptanceCriteria: ["Preserve false and zero.", "Keep the complete source."],
    sectionPath: ["1 Context", "1.1 First source"],
    layout: { pdf: { firstPage: 3, lastPage: 4 } },
  },
  {
    id: "MIG_ROL-003",
    title: "Exact second requirement",
    acceptanceCriteria: ["Preserve the identifier."],
    sectionPath: ["2 Migration", "2.1 Roles"],
    layout: { pdf: { firstPage: 8, lastPage: 8 } },
  },
];
const TRUTH = { requirementCount: REQUIREMENTS.length, requirements: REQUIREMENTS };
const GOLDEN = JSON.parse(
  readFileSync(
    new URL(
      "../../tests/fixtures/requirements/lastenheft-kundenportal/manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const VIOLATION = {
  ruleId: "summary-pattern",
  prompt: "Deliberately omit the required bracketed requirement ID from the summary.",
};

function epic(requirement, index) {
  return {
    id: String(10000 + index),
    key: `${PROJECT}-${index}`,
    fields: {
      project: { key: PROJECT },
      issuetype: { name: "Epic" },
      summary: `[${requirement.id}] ${requirement.title}`,
      description: [
        "h2. Requirement",
        "Complete business statement.",
        "",
        "h2. Acceptance criteria",
        ...requirement.acceptanceCriteria.map((criterion) => `* ${criterion}`),
        "",
        "----",
        "Keiko traceability",
        `Requirement: ${requirement.id} · ${requirement.title}`,
        `Reference: ${requirement.id}@doc-1`,
        `Source: synthetic.pdf · ${requirement.sectionPath.join(" · ")}`,
        "End of Keiko traceability",
      ].join("\n"),
    },
  };
}

function issueRead(issues) {
  return vi.fn(async (path) => {
    const query = new URL(path, "https://synthetic.invalid").searchParams;
    const startAt = Number(query.get("startAt"));
    return {
      startAt,
      maxResults: 100,
      total: issues.length,
      issues: structuredClone(issues.slice(startAt, startAt + 100)),
    };
  });
}

const grade = (issues) => gradeGoldenEpics({ manifest: TRUTH, issues, projectKey: PROJECT });
const issueSet = () => REQUIREMENTS.map((requirement, index) => epic(requirement, index + 1));

function bulkHarness() {
  const issues = [];
  const search = issueRead(issues);
  // The shapes the project and template steps actually record in the limit-run intent.
  const state = {
    "ac5-project": { phase: "completed", resources: { boardId: "7" } },
    "w12-templates": { phase: "completed", resources: {} },
  };
  const read = vi.fn(async (path) => {
    if (path.startsWith("/rest/api/2/search?")) return search(path);
    const query = new URL(path, "https://synthetic.invalid").searchParams;
    const startAt = Number(query.get("startAt"));
    if (path.includes("/epic?"))
      return {
        startAt,
        total: issues.length,
        values: issues.slice(startAt, startAt + 50).map(({ id, key }) => ({ id, key })),
      };
    return { startAt, total: 0, issues: [] };
  });
  const turn = vi.fn(async (_chat, prompt) => {
    if (prompt.includes("deliberate formal violation"))
      return {
        clientTurnId: "synthetic-refusal-turn",
        exchanges: [
          {
            call: { name: "jira_create" },
            result: {
              toolRef: { canonicalId: "keiko.jira.create" },
              status: "failed",
              reason: "provider-reported-error",
              effectStarted: false,
              data: {
                outcome: "rejected",
                reason: "field-validation",
                violations: [
                  { ruleId: "summary-pattern", subject: "summary", template: `${PROJECT}/Epic` },
                ],
              },
            },
          },
        ],
      };
    for (const requirement of GOLDEN.requirements)
      if (prompt.includes(`[${requirement.id}] ${requirement.title}`))
        issues.push(epic(requirement, issues.length + 1));
    return { exchanges: [] };
  });
  return {
    projectKey: PROJECT,
    truth: GOLDEN,
    chat: { id: "chat-1" },
    read,
    turn,
    checkLicense: vi.fn(async () => 3600),
    intent: {
      state,
      record: vi.fn(async (name, value) => {
        state[name] = value;
      }),
    },
  };
}

describe("Golden independent native JQL reads", () => {
  it("reads all 370 at 100 per request, including the final 70, with complete native fields", async () => {
    const issues = GOLDEN.requirements.map((requirement, index) => epic(requirement, index + 1));
    const read = issueRead(issues);
    await expect(readGoldenIssues(read, PROJECT)).resolves.toEqual(issues);
    const queries = read.mock.calls.map(
      ([path]) => new URL(path, "https://synthetic.invalid").searchParams,
    );
    expect(queries.map((query) => query.get("startAt"))).toEqual(["0", "100", "200", "300"]);
    expect(queries.every((query) => query.get("maxResults") === "100")).toBe(true);
    expect(queries.every((query) => query.get("fields") === "*all")).toBe(true);
    expect(queries.every((query) => query.get("jql") === 'project = "LIM7" ORDER BY key ASC')).toBe(
      true,
    );
  });
  it("preserves requested hierarchy fields and adds the fields the independent grader requires", async () => {
    const read = issueRead(issueSet());
    await readGoldenIssues(read, PROJECT, { fields: "parent,issuelinks,customfield_10000" });
    const fields = new URL(read.mock.calls[0][0], "https://synthetic.invalid").searchParams
      .get("fields")
      .split(",");
    expect(fields).toEqual([
      "parent",
      "issuelinks",
      "customfield_10000",
      "summary",
      "description",
      "issuetype",
      "project",
    ]);
  });
  it("honors a declared server cap without silently accepting a partial page", async () => {
    const issues = issueSet();
    const read = vi.fn(async (path) => {
      const startAt = Number(
        new URL(path, "https://synthetic.invalid").searchParams.get("startAt"),
      );
      return { startAt, maxResults: 1, total: 2, issues: [issues[startAt]] };
    });
    await expect(readGoldenIssues(read, PROJECT)).resolves.toEqual(issues);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(
    [
      undefined,
      null,
      {},
      { startAt: 0, maxResults: 100, total: 0 },
      { startAt: 0, maxResults: 100, issues: [] },
      { startAt: 1, maxResults: 100, total: 0, issues: [] },
      { startAt: 0, maxResults: 101, total: 0, issues: [] },
      { startAt: 0, maxResults: 100, total: 1, issues: [] },
      { startAt: 0, maxResults: 100, total: 0, isLast: false, issues: [] },
      { startAt: 0, maxResults: 100, total: -1, issues: [] },
    ].map((body) => ({ body })),
  )("refuses an unavailable, malformed or partial page %#", async ({ body }) => {
    await expect(readGoldenIssues(async () => body, PROJECT)).rejects.toThrow();
  });
  it("refuses changing totals and duplicate native IDs or keys across pages", async () => {
    const issues = issueSet();
    const first = { startAt: 0, maxResults: 1, total: 2, issues: [issues[0]] };
    for (const second of [
      { startAt: 1, maxResults: 1, total: 3, issues: [issues[1]] },
      { startAt: 1, maxResults: 1, total: 2, issues: [issues[0]] },
      { startAt: 1, maxResults: 1, total: 2, issues: [{ ...issues[1], key: issues[0].key }] },
    ]) {
      const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      await expect(readGoldenIssues(read, PROJECT)).rejects.toThrow();
    }
  });
  it("refuses foreign projects, imprecise IDs and absent native issue fields", async () => {
    const original = issueSet()[0];
    for (const issue of [
      { ...original, fields: { ...original.fields, project: { key: "OTHER" } } },
      { ...original, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...original, fields: {} },
    ])
      await expect(readGoldenIssues(issueRead([issue]), PROJECT)).rejects.toThrow();
    await expect(readGoldenIssues(issueRead([]), 'LIM7" OR project=OTHER')).rejects.toThrow();
  });
  it("uses GET only and refuses missing/denied native bodies instead of manufacturing emptiness", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      value: { startAt: 0, maxResults: 100, total: 0, issues: [] },
    }));
    const read = goldenJiraReadAdapter({}, { request, auth: "synthetic-private-auth" });
    await expect(readGoldenIssues(read, PROJECT)).resolves.toEqual([]);
    expect(request.mock.calls[0][1]).toBe("GET");
    expect(request.mock.calls[0][4]).toBeUndefined();
    await expect(read("/rest/api/2/issue")).rejects.toThrow();
    await expect(read("https://elsewhere.invalid/rest/api/2/search?x=1")).rejects.toThrow();
    request.mockResolvedValue({ status: 200 });
    await expect(readGoldenIssues(read, PROJECT)).rejects.toThrow();
    request.mockResolvedValue({ status: 403, value: {} });
    await expect(readGoldenIssues(read, PROJECT)).rejects.toThrow();
  });
});

describe("Golden manifest exact content and source grading", () => {
  it("preserves actual zero criteria while refusing missing, malformed or invented criteria", () => {
    const zero = GOLDEN.requirements.find((requirement) => requirement.id === "REQ-FA-006");
    expect(zero.acceptanceCriteria).toEqual([]);
    expect(
      GOLDEN.requirements.filter((requirement) => requirement.acceptanceCriteria.length === 0),
    ).toHaveLength(56);
    const manifest = { requirementCount: 1, requirements: [zero] };
    expect(validateGoldenManifest(manifest)).toEqual([zero]);
    const issue = epic(zero, 1);
    expect(gradeGoldenEpics({ manifest, issues: [issue], projectKey: PROJECT })).toMatchObject({
      ok: true,
      counts: { acTotal: 0, acPresent: 0, acUnexpected: 0 },
    });
    const invented = {
      ...issue,
      fields: {
        ...issue.fields,
        description: issue.fields.description.replace(
          "h2. Acceptance criteria",
          "h2. Acceptance criteria\n* Invented criterion.",
        ),
      },
    };
    expect(gradeGoldenEpics({ manifest, issues: [invented], projectKey: PROJECT })).toMatchObject({
      ok: false,
      counts: { acUnexpected: 1 },
    });
    for (const acceptanceCriteria of [undefined, null, "", [""], ["same", "same"], [123]])
      expect(() =>
        validateGoldenManifest({
          requirementCount: 1,
          requirements: [{ ...zero, acceptanceCriteria }],
        }),
      ).toThrow();
    expect(() =>
      validateGoldenManifest({ requirementCount: 1, requirements: [{ ...zero, sectionPath: [] }] }),
    ).toThrow();
  });
  it("admits every committed manifest identity including real dots and underscores", () => {
    expect(validateGoldenManifest(GOLDEN)).toHaveLength(370);
    expect(GOLDEN.requirements.map((requirement) => requirement.id)).toContain("ABN-45.6");
    expect(GOLDEN.requirements.map((requirement) => requirement.id)).toContain("MIG_ROL-003");
    for (const id of ["", "REQ-FA-001\n", "REQ-FA-001\u0000", "[REQ-FA-001]", "ABN-45X6"])
      expect(() =>
        validateGoldenManifest({ requirementCount: 1, requirements: [{ ...REQUIREMENTS[0], id }] }),
      ).toThrow();
  });
  it("requires one exact Epic per ID with every title, criterion and owned source trace", () => {
    expect(grade(issueSet())).toMatchObject({
      ok: true,
      counts: {
        truthCount: 2,
        matched: 2,
        titleHit: 2,
        idHit: 2,
        traceHit: 2,
        acTotal: 3,
        acPresent: 3,
        acDuplicated: 0,
      },
    });
    expect(grade(issueSet()).privateMappings).toEqual([
      { requirementId: "REQ-FA-001", id: "10001", key: "LIM7-1" },
      { requirementId: "MIG_ROL-003", id: "10002", key: "LIM7-2" },
    ]);
    const all = GOLDEN.requirements.map((requirement, index) => epic(requirement, index + 1));
    expect(gradeGoldenEpics({ manifest: GOLDEN, issues: all, projectKey: PROJECT })).toMatchObject({
      ok: true,
      counts: {
        matched: 370,
        titleHit: 370,
        idHit: 370,
        acTotal: 1029,
        acPresent: 1029,
        traceHit: 370,
      },
    });
  });
  it("rejects missing, duplicate, unexpected and non-exact summary identities", () => {
    const [first, second] = issueSet();
    for (const issues of [
      [first],
      [first, second, { ...first, id: "10003", key: "LIM7-3" }],
      [
        first,
        second,
        {
          ...first,
          id: "10003",
          key: "LIM7-3",
          fields: { ...first.fields, summary: "[REQ-FA-999] Unexpected" },
        },
      ],
      [
        { ...first, fields: { ...first.fields, summary: `Prefix ${first.fields.summary}` } },
        second,
      ],
      [
        {
          ...first,
          fields: { ...first.fields, summary: first.fields.summary.replace("001]", "0010]") },
        },
        second,
      ],
      [{ ...first, fields: { ...first.fields, summary: "Exact first requirement" } }, second],
    ])
      expect(grade(issues).ok).toBe(false);
  });
  it("never uses a requirement mention in another Epic's description as identity", () => {
    const [first, second] = issueSet();
    const unrelated = {
      ...first,
      fields: { ...first.fields, summary: "[REQ-FA-999] Exact first requirement" },
    };
    expect(grade([unrelated, second])).toMatchObject({
      ok: false,
      counts: { matched: 1, unexpectedEpicCount: 1 },
    });
  });
  it("does not accept fuzzy criterion substrings, duplicates, or criteria copied only into the footer", () => {
    const [first, second] = issueSet();
    const criterion = REQUIREMENTS[0].acceptanceCriteria[0];
    for (const description of [
      first.fields.description.replace(`* ${criterion}`, `* Prefix ${criterion} extra`),
      first.fields.description.replace(`* ${criterion}`, `* ${criterion}\n* ${criterion}`),
      first.fields.description
        .replace(`* ${criterion}\n`, "")
        .replace("End of Keiko traceability", `${criterion}\nEnd of Keiko traceability`),
    ])
      expect(grade([{ ...first, fields: { ...first.fields, description } }, second]).ok).toBe(
        false,
      );
  });
  it("preserves hard-wrapped criterion text while requiring the complete source path", () => {
    const [first, second] = issueSet();
    const wrapped = first.fields.description.replace(
      "Preserve false and zero.",
      "Preserve false\n  and zero.",
    );
    expect(
      grade([{ ...first, fields: { ...first.fields, description: wrapped } }, second]).ok,
    ).toBe(true);
    const partial = first.fields.description.replace(
      "1 Context · 1.1 First source",
      "1.1 First source",
    );
    expect(
      grade([{ ...first, fields: { ...first.fields, description: partial } }, second]).ok,
    ).toBe(false);
    const descendant = first.fields.description.replace(
      "1 Context · 1.1 First source",
      "1 Context · 1.1 First source · Unrelated descendant",
    );
    expect(
      grade([{ ...first, fields: { ...first.fields, description: descendant } }, second]).ok,
    ).toBe(false);
  });
  it("accepts an exact source page range and rejects a prefix, subset or unrelated mention", () => {
    const [first, second] = issueSet();
    const replaceSource = (source) =>
      first.fields.description.replace("synthetic.pdf · 1 Context · 1.1 First source", source);
    expect(
      grade([
        {
          ...first,
          fields: { ...first.fields, description: replaceSource("synthetic.pdf · page 3–4") },
        },
        second,
      ]).ok,
    ).toBe(true);
    for (const source of [
      "synthetic.pdf · page 3",
      "synthetic.pdf · page 3-40",
      "synthetic.pdf · page 2-4",
    ])
      expect(
        grade([
          { ...first, fields: { ...first.fields, description: replaceSource(source) } },
          second,
        ]).ok,
      ).toBe(false);
    const misleading = `${replaceSource("wrong source")}\n* Source: synthetic.pdf · 1 Context · 1.1 First source`;
    expect(
      grade([{ ...first, fields: { ...first.fields, description: misleading } }, second]).ok,
    ).toBe(false);
  });
  it("requires the source to belong to this exact requirement's footer group", () => {
    const [first, second] = issueSet();
    for (const description of [
      first.fields.description.replace("Requirement: REQ-FA-001", "Requirement: REQ-FA-0010"),
      first.fields.description.replace(
        "Source: synthetic.pdf",
        "\nRequirement: REQ-FA-999\nSource: synthetic.pdf",
      ),
      first.fields.description +
        "\nKeiko traceability\nSource: unrelated\nEnd of Keiko traceability",
    ])
      expect(grade([{ ...first, fields: { ...first.fields, description } }, second]).ok).toBe(
        false,
      );
  });
});

describe("criteria followed by Keiko's own source labels (LIM32)", () => {
  // Keiko replaces a model's `[n]` marker after a criterion with its source label before review;
  // the grader removes only labels that name a staged Lastenheft document.
  const requirement = REQUIREMENTS[0];
  const grade = (lines) => {
    const counts = { acPresent: 0, acDuplicated: 0, acUnexpected: 0 };
    goldenOracle.gradeCriteria(
      ["h2. Akzeptanzkriterien", ...lines].join("\n"),
      requirement,
      counts,
    );
    return counts;
  };
  const source = goldenOracle.GOLDEN_EPIC_SOURCE_DOCUMENT;

  it("counts a criterion with a staged document's label as present and not unexpected", () => {
    expect(
      grade([
        `* Preserve false and zero. (${source} · Lastenheft > 1 Context > REQ-FA-001)`,
        `* Keep the complete source. (${goldenOracle.GOLDEN_LASTENHEFT_FILES[1]} · Seite 3; ${source})`,
      ]),
    ).toEqual({ acPresent: 2, acDuplicated: 0, acUnexpected: 0 });
  });

  it.each([
    "* Preserve false and zero. (nur montags)",
    "* Preserve false and zero. (fremd.md · Seite 3)",
    `* Preserve false and zero. (${source} · Seite 3) außer montags`,
  ])("still counts other trailing text as unexpected: %s", (line) => {
    expect(grade([line, "* Keep the complete source."])).toEqual({
      acPresent: 1,
      acDuplicated: 0,
      acUnexpected: 1,
    });
  });
});

describe("Golden requirement trace reference", () => {
  const reference = "a1b2c3d4:REQ-FA-001";
  const group = [
    "Requirement: REQ-FA-001 · Exact first requirement",
    `Reference: ${reference}`,
    "Source: synthetic.pdf · 1 Context · 1.1 First source",
    "Document digest: 0123456789abcdef",
    "Requirement digest: fedcba9876543210",
    "Quality findings: none",
  ].join("\n");
  const footer = (value) => `Keiko traceability\n${value}\nEnd of Keiko traceability`;
  const description = `Human description.\n\n${footer(group)}`;
  const selectedReference = (value, requirement = REQUIREMENTS[0]) => {
    expect(goldenOracle.goldenRequirementTraceReference).toBeTypeOf("function");
    return goldenOracle.goldenRequirementTraceReference(value, requirement);
  };

  it("returns the exact native scoped reference from its owned source group", () => {
    expect(selectedReference(description)).toBe(reference);
    const extended = "a1b2c3d4e5f60708:REQ-FA-001";
    expect(selectedReference(description.replace(reference, extended))).toBe(extended);
    expect(selectedReference(description.replaceAll("\n", "\r\n"))).toBe(reference);
  });

  it("preserves the existing exact page-range source alternative", () => {
    expect(selectedReference(description.replace("1 Context · 1.1 First source", "page 3–4"))).toBe(
      reference,
    );
    expect(
      selectedReference(description.replace("1 Context · 1.1 First source", "page 3")),
    ).toBeUndefined();
  });

  it("takes the reference only from the selected requirement in a multi-group footer", () => {
    const other = [
      "Requirement: MIG_ROL-003 · Exact second requirement",
      "Reference: 11223344:MIG_ROL-003",
      "Source: synthetic.pdf · 2 Migration · 2.1 Roles",
    ].join("\n");
    const combined = footer(`${other}\n\n${group}`);
    expect(selectedReference(combined)).toBe(reference);
    expect(selectedReference(combined, REQUIREMENTS[1])).toBe("11223344:MIG_ROL-003");
  });

  it.each([
    ["missing reference", footer(group.replace(`Reference: ${reference}\n`, ""))],
    ["empty reference", footer(group.replace(reference, ""))],
    [
      "duplicate reference",
      footer(
        group.replace(
          `Reference: ${reference}`,
          `Reference: ${reference}\nReference: ${reference}`,
        ),
      ),
    ],
    ["foreign requirement reference", footer(group.replace(reference, "a1b2c3d4:REQ-FA-0010"))],
    ["unscoped reference", footer(group.replace(reference, "REQ-FA-001"))],
    ["legacy fuzzy reference", footer(group.replace(reference, "REQ-FA-001@doc-1"))],
    ["reference trailing prose", footer(group.replace(reference, `${reference} extra`))],
    [
      "reference in another group",
      footer(
        group.replace(`Reference: ${reference}\n`, "") +
          `\n\nRequirement: MIG_ROL-003 · Other\nReference: ${reference}\nSource: synthetic.pdf · 2 Migration · 2.1 Roles`,
      ),
    ],
    [
      "source in another group",
      footer(
        group.replace(
          "Source: synthetic.pdf",
          "\nRequirement: MIG_ROL-003 · Other\nSource: synthetic.pdf",
        ),
      ),
    ],
    ["duplicate requirement group", footer(`${group}\n\n${group}`)],
    ["duplicate source", footer(`${group}\nSource: synthetic.pdf · 1 Context · 1.1 First source`)],
    [
      "wrong source path",
      footer(group.replace("1.1 First source", "1.1 First source · Descendant")),
    ],
    ["duplicate owned block", `${description}\n\n${footer(group)}`],
    ["missing end marker", description.replace("\nEnd of Keiko traceability", "")],
    [
      "reference before block",
      `Reference: ${reference}\n${footer(group.replace(`Reference: ${reference}\n`, ""))}`,
    ],
    [
      "reference after block",
      `${footer(group.replace(`Reference: ${reference}\n`, ""))}\nReference: ${reference}`,
    ],
    ["unowned prose only", group],
  ])("refuses %s instead of borrowing an unrelated reference", (_name, value) => {
    expect(selectedReference(value)).toBeUndefined();
  });
});

describe("separate Epic and ordinary Backlog observations", () => {
  it("reports Epic visibility and Epic exclusion from the Backlog separately", async () => {
    const epics = issueSet();
    const read = vi.fn(async (path) =>
      path.includes("/epic?")
        ? { startAt: 0, total: 2, values: epics.map(({ id, key }) => ({ id, key })) }
        : { startAt: 0, total: 0, issues: [] },
    );
    const views = await readGoldenBoardViews(read, "7");
    expect(gradeGoldenEpicViews({ epics, ...views })).toEqual({
      ok: true,
      epics: { ok: true, expectedCount: 2, visibleCount: 2, missingCount: 0, unexpectedCount: 0 },
      backlog: { ok: true, issueCount: 0, queuedEpicCount: 0 },
    });
    expect(gradeGoldenEpicViews({ epics, boardEpics: epics, backlog: [epics[0]] }).backlog.ok).toBe(
      false,
    );
    expect(gradeGoldenEpicViews({ epics, boardEpics: [epics[0]], backlog: [] }).epics.ok).toBe(
      false,
    );
    expect(() => gradeGoldenEpicViews({ epics: [{}], boardEpics: [{}], backlog: [] })).toThrow();
  });
});

describe("ordinary browser bulk orchestration", () => {
  it("names the one source document and its qualified reference before the first write", () => {
    // One Knowledge Pod stages the Lastenheft as Markdown, DOCX and PDF, so a bare requirement ID
    // matches three documents and the product refuses it as ambiguous (LIM31). Every prompt must
    // therefore name one source document and its qualified <documentScope>:<ID> form up front.
    const source = goldenOracle.GOLDEN_EPIC_SOURCE_DOCUMENT;
    expect(goldenOracle.GOLDEN_LASTENHEFT_FILES).toHaveLength(3);
    expect(goldenOracle.GOLDEN_LASTENHEFT_FILES).toContain(source);
    const prompts = [
      ...planEpicBatches(GOLDEN, { projectKey: PROJECT }),
      ...planDeliberateViolations(GOLDEN, { projectKey: PROJECT, bulkViolation: VIOLATION }),
    ].map((entry) => entry.prompt);
    for (const prompt of prompts) {
      expect(prompt).toContain(source);
      expect(prompt).toContain("<documentScope>:");
    }
    for (const entry of planDeliberateViolations(GOLDEN, {
      projectKey: PROJECT,
      bulkViolation: VIOLATION,
    }))
      expect(entry.prompt).toContain(`<documentScope>:${entry.requirementId}`);
  });
  it("plans all 370 exactly once with 1029 criteria and runtime project keys", () => {
    const batches = planEpicBatches(GOLDEN, { projectKey: PROJECT });
    expect(batches).toHaveLength(19);
    expect(batches.map((batch) => batch.count)).toEqual([...Array(18).fill(20), 10]);
    expect(new Set(batches.flatMap((batch) => batch.requirementIds)).size).toBe(370);
    expect(batches.reduce((sum, batch) => sum + batch.acceptanceCriteriaCount, 0)).toBe(1029);
    expect(batches.every((batch) => batch.prompt.includes(`project ${PROJECT}`))).toBe(true);
    expect(new Set(batches.map((batch) => batch.identity)).size).toBe(19);
    expect(() => planEpicBatches(GOLDEN, { projectKey: 'REQ" OR project=X' })).toThrow();
    expect(() => planEpicBatches(GOLDEN, { projectKey: PROJECT, batchSize: 0 })).toThrow();
  });
  it.each([
    [0.1, 37],
    [0.125, 46],
    [0.15, 55],
  ])(
    "seeds independent unique requirements using the 370 denominator: %s",
    (violationRate, count) => {
      const seeded = planDeliberateViolations(GOLDEN, {
        projectKey: PROJECT,
        violationRate,
        bulkViolation: VIOLATION,
      });
      expect(seeded).toHaveLength(count);
      expect(new Set(seeded.map((entry) => entry.requirementId)).size).toBe(count);
      expect(seeded.every((entry) => entry.ruleId === "summary-pattern")).toBe(true);
      expect(seeded.every((entry) => entry.prompt.includes("Do not correct"))).toBe(true);
      // The oracle grades the refused create's requirementIds binding, so the prompt must ask for it.
      expect(
        seeded.every((entry) =>
          entry.prompt.includes(
            `Bind requirementIds to the one requirement [${entry.requirementId}]`,
          ),
        ),
      ).toBe(true);
      // The rule under test is the only refusal: the Epic Name Data Center requires is supplied.
      expect(
        seeded.every((entry) =>
          entry.prompt.includes(`Set the Epic Name Jira requires to ${entry.requirementId}.`),
        ),
      ).toBe(true);
    },
  );
  it("records exact batch identities and uncertain-submit state before each visible turn", async () => {
    const issues = [];
    const states = [];
    const turn = vi.fn(async (_chat, prompt) => {
      expect(states.at(-1).phase).toBe("submission-may-have-started");
      for (const requirement of REQUIREMENTS)
        if (prompt.includes(`[${requirement.id}] ${requirement.title}`))
          issues.push(epic(requirement, issues.length + 1));
      return { exchanges: [] };
    });
    const beforeBatch = vi.fn(),
      afterBatch = vi.fn();
    const result = await runBrowserEpicsBulk(
      { turn },
      {
        chat: { id: "chat-1" },
        manifest: TRUTH,
        projectKey: PROJECT,
        read: issueRead(issues),
        batchSize: 1,
        onState: (state) => {
          states.push(state);
        },
        beforeBatch,
        afterBatch,
      },
    );
    expect(result.privateMappings).toHaveLength(2);
    expect(result.counts.completedBatches).toBe(2);
    expect(states.at(-1).phase).toBe("completed");
    expect(turn).toHaveBeenCalledTimes(2);
    expect(beforeBatch).toHaveBeenCalledTimes(2);
    expect(afterBatch.mock.calls.map(([entry]) => entry.progress)).toEqual([0.5, 1]);
    expect(
      states
        .filter((state) => state.phase === "observed")
        .every((state) => typeof state.current.identity === "string"),
    ).toBe(true);
  });
  it("cannot submit after the private intent sink failed", async () => {
    const turn = vi.fn();
    await expect(
      runBrowserEpicsBulk(
        { turn },
        {
          chat: { id: "chat-1" },
          manifest: TRUTH,
          projectKey: PROJECT,
          read: issueRead([]),
          onState: () => {
            throw new TypeError("Synthetic durable write failure");
          },
        },
      ),
    ).rejects.toThrow();
    expect(turn).not.toHaveBeenCalled();
  });
  it("checks the license after a delegated fault and keeps a rejected batch prepared without writes", async () => {
    const states = [];
    const order = [];
    const turn = vi.fn();
    const checkLicense = vi.fn(async () => {
      order.push("license");
      throw new TypeError("Synthetic expired license");
    });
    await expect(
      runBrowserEpicsBulk(
        { turn, checkLicense },
        {
          manifest: TRUTH,
          chat: { id: "chat-1" },
          projectKey: PROJECT,
          read: issueRead([]),
          onState: (state) => {
            states.push(state);
          },
          beforeBatch: async () => {
            order.push("fault");
          },
        },
      ),
    ).rejects.toThrow();
    expect(order).toEqual(["fault", "license"]);
    expect(states.at(-1)).toMatchObject({ phase: "prepared", current: { kind: "batch" } });
    expect(turn).not.toHaveBeenCalled();
  });
  it("runs the fixed public export with actual refusal turns, all 370 native Epics and separate views", async () => {
    const ctx = bulkHarness();
    const faults = { maybeInject: vi.fn(async () => undefined) };
    const result = await runBulkEpics(ctx, { faults });
    expect(result).toMatchObject({
      step: "ac2-bulk-epics",
      status: "green",
      counts: {
        matched: 370,
        acPresent: 1029,
        seededCount: 46,
        refusedCount: 46,
        completedBatches: 19,
        epicViewCount: 370,
        backlogIssueCount: 0,
        backlogEpicCount: 0,
      },
    });
    expect(ctx.turn).toHaveBeenCalledTimes(65);
    expect(ctx.checkLicense).toHaveBeenCalledTimes(65);
    expect(faults.maybeInject).toHaveBeenCalledTimes(38);
    expect(ctx.intent.state.bulkEpics.seeded).toHaveLength(46);
    expect(
      new Set(ctx.intent.state.bulkEpics.seeded.map((entry) => entry.requirementId)).size,
    ).toBe(46);
    expect(ctx.intent.state.bulkEpics.refusals).toHaveLength(46);
    expect(ctx.intent.state.bulkEpics.privateMappings).toHaveLength(370);
    expect(JSON.stringify(result)).not.toMatch(/REQ-FA|MIG_ROL|LIM7-|synthetic-refusal/u);
  });
  it("requires completed project-bound exact seed/refusal sets for read-only green reconciliation", async () => {
    const ctx = bulkHarness();
    expect((await runBulkEpics(ctx)).status).toBe("green");
    const complete = structuredClone(ctx.intent.state.bulkEpics);
    const calls = ctx.turn.mock.calls.length;
    const records = ctx.intent.record.mock.calls.length;
    for (const state of [
      { ...complete, phase: "submission-may-have-started" },
      { ...complete, projectKey: "OTHER" },
      { ...complete, seeded: complete.seeded.map(() => complete.seeded[0]) },
      { ...complete, refusals: [] },
      { ...complete, refusals: complete.refusals.map(() => complete.refusals[0]) },
      {
        ...complete,
        refusals: complete.refusals.map((refusal) => ({ ...refusal, nativeAfterCount: 1 })),
      },
      { ...complete, coveredIds: complete.coveredIds.slice(1) },
    ]) {
      ctx.intent.state.bulkEpics = state;
      expect(await runBulkEpics(ctx)).toMatchObject({
        status: "unverified",
        counts: { reconciliationOnly: 1 },
      });
    }
    ctx.intent.state.bulkEpics = complete;
    expect(await runBulkEpics(ctx)).toMatchObject({
      status: "green",
      counts: { reconciliationOnly: 1, seededCount: 46, refusedCount: 46 },
    });
    expect(ctx.turn).toHaveBeenCalledTimes(calls);
    expect(ctx.intent.record).toHaveBeenCalledTimes(records);
  });
  it("checks a deliberate violation's license before any UI attempt and retains its prepared identity", async () => {
    const ctx = bulkHarness();
    ctx.checkLicense.mockRejectedValue(new TypeError("Synthetic expired license"));
    expect(await runBulkEpics(ctx)).toMatchObject({ status: "red", counts: { refusedCount: 0 } });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ctx.intent.state.bulkEpics).toMatchObject({
      phase: "prepared",
      current: { kind: "violation" },
    });
  });
  it("blocks before any write when the native board identity is unavailable", async () => {
    const ctx = bulkHarness();
    delete ctx.intent.state["ac5-project"].resources.boardId;
    expect(await runBulkEpics(ctx)).toMatchObject({
      status: "unverified",
      counts: { attemptedCount: 0 },
    });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ctx.read).not.toHaveBeenCalled();
    expect(ctx.intent.record).not.toHaveBeenCalled();
  });
  it("takes its deliberate violation from the installed Epic template only after that step completed", async () => {
    const ctx = bulkHarness();
    ctx.intent.state["w12-templates"].phase = "pending";
    expect(await runBulkEpics(ctx)).toMatchObject({
      status: "unverified",
      counts: { attemptedCount: 0 },
    });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(EPIC_SUMMARY_VIOLATION).toEqual(VIOLATION);
  });
  it("exports the fixed public StepResult contract and blocks writes without observed template metadata", async () => {
    const ctx = {
      projectKey: PROJECT,
      truth: GOLDEN,
      boardId: "7",
      read: vi.fn(),
      turn: vi.fn(),
      intent: { state: {}, record: vi.fn() },
    };
    expect(await runBulkEpics(ctx)).toMatchObject({
      step: "ac2-bulk-epics",
      status: "unverified",
      counts: { attemptedCount: 0 },
    });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ctx.read).not.toHaveBeenCalled();
    expect(ctx.intent.record).not.toHaveBeenCalled();
  });
  it("reconciles an interrupted existing intent by reads only and never resumes or replays writes", async () => {
    const turn = vi.fn();
    const ctx = {
      projectKey: PROJECT,
      truth: GOLDEN,
      read: issueRead([]),
      turn,
      intent: {
        state: { bulkEpics: { phase: "submission-may-have-started", seeded: [], refusedCount: 0 } },
        record: vi.fn(),
      },
    };
    expect(await runBulkEpics(ctx)).toMatchObject({
      step: "ac2-bulk-epics",
      status: "unverified",
      counts: { reconciliationOnly: 1 },
    });
    expect(turn).not.toHaveBeenCalled();
    expect(ctx.intent.record).not.toHaveBeenCalled();
  });
});
