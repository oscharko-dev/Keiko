import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  BULK_CREATE_ARGUMENTS as ARGS,
  bulkCreateFixture,
} from "../../../tests/support/jira-bulk-create-fixture.js";
import {
  permissiveJiraTemplates,
  SYNTHETIC_ISSUE_TYPES,
} from "../../../tests/support/jira-test-templates.js";
import { asRecord } from "./atlassian-sync-classify.js";
import { executeJiraBulkCreate, type JiraBulkCreatePorts } from "./jira-managed-bulk-create.js";
import { prepareJiraCreate } from "./jira-managed-mutations.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";

function preparedFixture(
  templates?: JiraIssueTemplateSource,
): ReturnType<typeof bulkCreateFixture> & { readonly ports: JiraBulkCreatePorts } {
  const native = bulkCreateFixture();
  return {
    ...native,
    ports: {
      prepare: (
        args: Parameters<typeof prepareJiraCreate>[1],
        trace: Parameters<typeof prepareJiraCreate>[3],
      ): ReturnType<typeof prepareJiraCreate> =>
        prepareJiraCreate(
          native.request,
          args,
          templates ?? (() => permissiveJiraTemplates(["SYN"], SYNTHETIC_ISSUE_TYPES)),
          trace,
        ),
    },
  };
}
describe("bulk reuses the actual individual create admission owner", () => {
  it("prepares native metadata and all fields before the single bulk effect", async () => {
    const native = preparedFixture();
    expect(
      await executeJiraBulkCreate("jira.create-issues", ARGS, native.request, native.ports),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(native.calls.filter((call) => call.path.includes("createmeta"))).toHaveLength(2);
    expect(native.calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([
      "issue/bulk",
    ]);
  });
  it("refuses a missing native required field in a later item before the batch effect", async () => {
    const native = preparedFixture();
    native.controls.requiredCustom = true;
    const issues = [
      { ...ARGS.issues[0], fields: { ...ARGS.issues[0].fields, customfield_10000: "Reviewed" } },
      ARGS.issues[1],
    ];
    expect(
      await executeJiraBulkCreate(
        "jira.create-issues",
        { ...ARGS, issues },
        native.request,
        native.ports,
      ),
    ).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "customfield_10000" },
    });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("applies saved create rules independently to every reviewed issue", async () => {
    const parsed = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: SYN\nissueType: Story\nactivateOn: [create]\nsummaryMinLength: 12\n---\n",
    );
    if (!parsed.ok) throw new TypeError("Synthetic rule must parse");
    const native = preparedFixture(() => ({ templates: [parsed.template], unreadable: 0 }));
    const issues = [ARGS.issues[0], { ...ARGS.issues[1], fields: { summary: "Short" } }];
    expect(
      await executeJiraBulkCreate(
        "jira.create-issues",
        { ...ARGS, issues },
        native.request,
        native.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("carries the existing description conversion and validated trace into each payload", async () => {
    const native = preparedFixture();
    native.controls.includeLabels = true;
    const report = vi.fn();
    const trace = {
      labels: ["requirement-1"],
      footer: "Start\nRequirement\nEnd",
      footerStart: "Start",
      footerEnd: "End",
      replaceLabelPrefixes: [],
      report,
    };
    const issues = ARGS.issues.map((issue) => ({
      ...issue,
      fields: {
        ...issue.fields,
        description: { format: "markdown", text: "## Context\nReviewed" },
      },
    }));
    await executeJiraBulkCreate(
      "jira.create-issues",
      { ...ARGS, issues, requirementIds: ["REQ-1"] },
      native.request,
      { ...native.ports, trace },
    );
    const values = asRecord(native.submitted())?.issueUpdates;
    expect(Array.isArray(values)).toBe(true);
    if (!Array.isArray(values)) throw new TypeError("Expected native issue updates");
    for (const value of values) {
      const fields = asRecord(asRecord(value)?.fields);
      expect(fields?.description).toContain("h2. Context");
      expect(fields?.description).toContain(trace.footer);
      expect(fields?.labels).toContain("requirement-1");
    }
    expect(report).toHaveBeenCalledTimes(2);
  });
  it("refuses an existing draft twin without a native bulk POST", async () => {
    const native = preparedFixture();
    native.controls.includeLabels = true;
    native.controls.duplicateExists = true;
    expect(
      await executeJiraBulkCreate("jira.create-issues", ARGS, native.request, native.ports),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
  it("preserves inline-only admission and refuses a plan requiring another native effect", async () => {
    const native = preparedFixture();
    native.controls.includeLinks = false;
    const issues = [
      { ...ARGS.issues[0], links: [{ type: "Blocks", direction: "outward", issueKey: "SYN-3" }] },
      ARGS.issues[1],
    ];
    expect(
      await executeJiraBulkCreate(
        "jira.create-issues",
        { ...ARGS, issues },
        native.request,
        native.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.snapshot()).toEqual({ effects: 0 });
  });
});
