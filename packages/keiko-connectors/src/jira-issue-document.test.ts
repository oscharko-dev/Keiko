// Jira issue document composition tests (Issue #2243). Golden metadata/document output, hostile
// field degradation (fail-closed field validation), byte-budget truncation with explicit markers,
// and determinism. Hermetic and pure — no transport, no clock.

import { describe, expect, it } from "vitest";
import { isJiraIssueCitationMetadata } from "@oscharko-dev/keiko-contracts";
import {
  boundedJiraIssueTitle,
  buildJiraIssueCitationMetadata,
  composeJiraComment,
  composeJiraIssueDocument,
  JIRA_COMPOSED_DOCUMENT_MAX_BYTES,
  JIRA_DOCUMENT_TRUNCATION_MARKER,
  jiraBodyText,
  jiraIssueMetadataLine,
  serializeJiraIssueCitationMetadata,
} from "./jira-issue-document.js";

const FULL_FIELDS: Record<string, unknown> = {
  status: { name: "In Progress" },
  issuetype: { name: "Bug" },
  assignee: { displayName: "Alice Example" },
  reporter: { displayName: "Bob Reporter" },
  labels: ["auth", "backend"],
  priority: { name: "High" },
  resolution: { name: "Unresolved" },
  created: "2026-04-01T09:00:00.000+0000",
  updated: "2026-05-01T10:22:33.000+0000",
  timetracking: { originalEstimate: "1w", remainingEstimate: "2d" },
  parent: { key: "PLAT-1" },
  subtasks: [{ key: "PLAT-3" }, { key: "PLAT-4" }],
  issuelinks: [
    {
      type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      outwardIssue: { key: "PLAT-9" },
    },
    {
      type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      inwardIssue: { key: "CORE-2" },
    },
  ],
};

describe("buildJiraIssueCitationMetadata", () => {
  it("captures the full field list including estimates and issue relationships", () => {
    const metadata = buildJiraIssueCitationMetadata("PLAT-2", FULL_FIELDS);
    expect(metadata).toStrictEqual({
      issueKey: "PLAT-2",
      status: "In Progress",
      issueType: "Bug",
      assignee: "Alice Example",
      reporter: "Bob Reporter",
      priority: "High",
      resolution: "Unresolved",
      originalEstimate: "1w",
      remainingEstimate: "2d",
      parentKey: "PLAT-1",
      created: "2026-04-01T09:00:00.000+0000",
      updated: "2026-05-01T10:22:33.000+0000",
      labels: ["auth", "backend"],
      subtaskKeys: ["PLAT-3", "PLAT-4"],
      linkedIssues: [
        { linkType: "blocks", issueKey: "PLAT-9" },
        { linkType: "is blocked by", issueKey: "CORE-2" },
      ],
    });
    expect(isJiraIssueCitationMetadata(metadata)).toBe(true);
  });

  it("produces the minimal projection for an issue without any optional field", () => {
    expect(buildJiraIssueCitationMetadata("PLAT-7", {})).toStrictEqual({ issueKey: "PLAT-7" });
  });

  it("drops hostile field values fail-closed instead of carrying them", () => {
    const metadata = buildJiraIssueCitationMetadata("PLAT-8", {
      status: { name: "see https://evil.example/x" },
      issuetype: { name: "x".repeat(500) },
      assignee: { displayName: "user@evil.example" },
      labels: ["ok-label", "bad label ", 42],
      parent: { key: "not a key!" },
      subtasks: [{ key: "PLAT-10" }, { key: "in/valid" }],
      issuelinks: [{ type: { outward: "blocks" }, outwardIssue: { key: "in valid" } }],
    });
    expect(metadata).toStrictEqual({
      issueKey: "PLAT-8",
      labels: ["ok-label"],
      subtaskKeys: ["PLAT-10"],
    });
  });

  it("serializes deterministically and drops list fields when the bound is exceeded", () => {
    const metadata = buildJiraIssueCitationMetadata("PLAT-2", FULL_FIELDS);
    const first = serializeJiraIssueCitationMetadata(metadata);
    const second = serializeJiraIssueCitationMetadata(
      buildJiraIssueCitationMetadata(
        "PLAT-2",
        JSON.parse(JSON.stringify(FULL_FIELDS)) as Record<string, unknown>,
      ),
    );
    expect(second).toBe(first);
    const oversized = buildJiraIssueCitationMetadata("PLAT-2", {
      ...FULL_FIELDS,
      labels: Array.from({ length: 50 }, (_, index) => `label-${String(index)}-${"x".repeat(90)}`),
    });
    const compact = serializeJiraIssueCitationMetadata(oversized);
    expect(compact.length).toBeLessThanOrEqual(4_096);
    expect(compact).not.toContain("label-0");
    expect(compact).toContain("remainingEstimate");
  });
});

describe("jiraIssueMetadataLine", () => {
  it("renders every present field as retrievable labelled text", () => {
    const line = jiraIssueMetadataLine(buildJiraIssueCitationMetadata("PLAT-2", FULL_FIELDS));
    expect(line).toBe(
      "Status: In Progress | Type: Bug | Priority: High | Assignee: Alice Example | " +
        "Reporter: Bob Reporter | Resolution: Unresolved | Original estimate: 1w | " +
        "Remaining estimate: 2d | Parent: PLAT-1 | Labels: auth, backend | " +
        "Subtasks: PLAT-3, PLAT-4 | Links: blocks PLAT-9, is blocked by CORE-2",
    );
  });

  it("renders an empty line for metadata without optional fields", () => {
    expect(jiraIssueMetadataLine({ issueKey: "PLAT-7" })).toBe("");
  });
});

describe("jiraBodyText", () => {
  it("converts ADF, passes legacy strings through, and treats null as empty", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body text" }] }],
    };
    expect(jiraBodyText(adf)).toStrictEqual({ text: "Body text", degraded: false });
    expect(jiraBodyText("legacy plain description")).toStrictEqual({
      text: "legacy plain description",
      degraded: false,
    });
    expect(jiraBodyText(null)).toStrictEqual({ text: "", degraded: false });
    expect(jiraBodyText(undefined)).toStrictEqual({ text: "", degraded: false });
  });

  it("appends an explicit marker when unreadable and never returns silent emptiness", () => {
    const unreadable = jiraBodyText({ nonsense: true });
    expect(unreadable.degraded).toBe(true);
    expect(unreadable.text).toBe("[Content could not be converted]");
  });
});

describe("composeJiraComment", () => {
  it("composes an author — created header over the converted body", () => {
    const comment = composeJiraComment({
      author: { displayName: "Alice Example" },
      created: "2026-05-01T10:22:33.000+0000",
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good." }] }],
      },
    });
    expect(comment).toStrictEqual({
      headerLine: "Alice Example — 2026-05-01T10:22:33.000+0000",
      bodyText: "Looks good.",
    });
  });

  it("falls back to Unknown author, flattens hostile headers, and drops empty bodies", () => {
    const comment = composeJiraComment({
      created: "line\nbreak\ttimestamp",
      body: "plain body",
    });
    expect(comment).toStrictEqual({
      headerLine: "Unknown author — line break timestamp",
      bodyText: "plain body",
    });
    expect(composeJiraComment({ author: { displayName: "A" }, body: null })).toBeUndefined();
    expect(composeJiraComment("not a record")).toBeUndefined();
  });
});

describe("boundedJiraIssueTitle", () => {
  it("composes KEY: summary with fallbacks and bounds", () => {
    expect(boundedJiraIssueTitle("PLAT-2", "Fix login flow")).toBe("PLAT-2: Fix login flow");
    expect(boundedJiraIssueTitle("PLAT-2", "  ")).toBe("PLAT-2");
    expect(boundedJiraIssueTitle("PLAT-2", 42)).toBe("PLAT-2");
    expect(boundedJiraIssueTitle("PLAT-2", "x".repeat(600))).toHaveLength(500);
  });
});

describe("composeJiraIssueDocument", () => {
  it("composes one complete escaped HTML document with metadata, description, and comments", () => {
    const result = composeJiraIssueDocument({
      title: 'PLAT-2: Fix <login> & "flow"',
      metadataLine: "Status: In Progress | Type: Bug",
      descriptionText: "Steps:\n- one <tag>",
      comments: [{ headerLine: "Alice — 2026-05-01", bodyText: "LGTM & done" }],
    });
    expect(result.truncated).toBe(false);
    expect(result.contentHtml).toBe(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>PLAT-2: Fix &lt;login&gt; &amp; ' +
        "&quot;flow&quot;</title></head><body><main><h1>PLAT-2: Fix &lt;login&gt; &amp; " +
        '&quot;flow&quot;</h1><section data-connector-issue-metadata="true"><p>Status: In ' +
        'Progress | Type: Bug</p></section><section data-connector-description="true"><pre>' +
        "Steps:\n- one &lt;tag&gt;</pre></section>" +
        '<section data-connector-comments="true"><h2>Comments</h2>' +
        '<section data-connector-comment="true"><p>Alice — 2026-05-01</p><pre>LGTM &amp; done' +
        "</pre></section></section></main></body></html>",
    );
    expect(result.byteLength).toBe(new TextEncoder().encode(result.contentHtml).length);
  });

  it("truncates an over-budget description with an explicit marker, never a silent cut", () => {
    const result = composeJiraIssueDocument({
      title: "PLAT-2: Big",
      metadataLine: "",
      descriptionText: "d".repeat(JIRA_COMPOSED_DOCUMENT_MAX_BYTES + 100_000),
      comments: [],
    });
    expect(result.truncated).toBe(true);
    expect(result.byteLength).toBeLessThanOrEqual(JIRA_COMPOSED_DOCUMENT_MAX_BYTES);
    expect(result.contentHtml).toContain(JIRA_DOCUMENT_TRUNCATION_MARKER);
    expect(result.contentHtml.endsWith("</main></body></html>")).toBe(true);
  });

  it("omits over-budget comments with an explicit counted marker", () => {
    const bigComment = { headerLine: "A — t", bodyText: "c".repeat(900_000) };
    const result = composeJiraIssueDocument({
      title: "PLAT-2: Comments",
      metadataLine: "",
      descriptionText: "short",
      comments: [bigComment, bigComment, bigComment],
    });
    expect(result.truncated).toBe(true);
    expect(result.byteLength).toBeLessThanOrEqual(JIRA_COMPOSED_DOCUMENT_MAX_BYTES);
    expect(result.contentHtml).toContain(
      `${JIRA_DOCUMENT_TRUNCATION_MARKER} — 1 of 3 comments omitted`,
    );
  });

  it("is deterministic: identical input composes byte-identical HTML", () => {
    const input = {
      title: "PLAT-2: Same",
      metadataLine: "Status: Done",
      descriptionText: "body",
      comments: [{ headerLine: "A — t", bodyText: "c" }],
    };
    expect(composeJiraIssueDocument(input).contentHtml).toBe(
      composeJiraIssueDocument(input).contentHtml,
    );
  });
});
