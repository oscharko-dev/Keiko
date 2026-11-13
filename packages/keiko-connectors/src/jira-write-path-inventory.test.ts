import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JIRA_TEMPLATE_GOVERNANCE } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The write-path inventory of #4354 as an executable contract. `JIRA_TEMPLATE_GOVERNANCE` says which
 * class every mutating operation is in; this table says, for every operation that is governed, the
 * decisive code that applies the template gate to it and the test that pins its refusal. The gate
 * sits below every autonomy mode and below both surfaces (Chat and the Coding Workbench), which
 * reach it through the one managed executor, so a path is proven once here for all of them.
 *
 * `pin: undefined` is an open gap, stated rather than hidden: a governed operation whose own refusal
 * is not yet pinned by a behavioural test. The list of gaps may only shrink.
 */
interface WritePath {
  /** The source file that applies the gate, and the identifier it applies it with. */
  readonly site: readonly [file: string, identifier: string];
  /** The test file that pins this operation's refusal before any effect, or undefined: a gap. */
  readonly pin: string | undefined;
}
const GATE = "gateJiraMutationByTemplates";
const MUTATIONS = "jira-managed-mutations.ts";
const WORKLOG = ["jira-worklog-templates.ts", "gateJiraWorklogChange"] as const;
const AGILE = ["jira-agile-templates.ts", "gateJiraAgileIssueChange"] as const;
const PLANNING = ["jira-agile-planning-admission.ts", GATE] as const;
const BULK = ["jira-managed-template-gate.ts", "gateJiraBulkReferenceChange"] as const;
const GATE_TEST = "jira-managed-template-gate.test.ts";

const PATHS: Readonly<Record<string, WritePath>> = {
  "jira.create": { site: [MUTATIONS, "createTemplateGate"], pin: GATE_TEST },
  "jira.create-issues": {
    site: [MUTATIONS, "createTemplateGate"],
    pin: "jira-bulk-create-preparation.test.ts",
  },
  "jira.draft": {
    site: ["jira-draft-stage-tool.ts", "checkJiraManagedMutationTemplates"],
    pin: "jira-draft-stage-tool.test.ts",
  },
  "jira.edit": { site: [MUTATIONS, "admitFieldMutation"], pin: GATE_TEST },
  "jira.assign": { site: [MUTATIONS, "admitAssignment"], pin: GATE_TEST },
  "jira.transition": { site: [MUTATIONS, "admitFieldMutation"], pin: GATE_TEST },
  "jira.create-issue-link": {
    site: ["jira-managed-issue-link-mutations.ts", GATE],
    pin: "jira-managed-issue-link-mutations.test.ts",
  },
  "jira.delete-issue-link": {
    site: ["jira-managed-issue-link-mutations.ts", GATE],
    pin: "jira-managed-issue-link-mutations.test.ts",
  },
  "jira.upsert-remote-link": {
    site: ["jira-managed-remote-link-mutations.ts", GATE],
    pin: "jira-managed-remote-link-mutations.test.ts",
  },
  "jira.update-remote-link": {
    site: ["jira-managed-remote-link-mutations.ts", GATE],
    pin: "jira-managed-remote-link-mutations.test.ts",
  },
  "jira.delete-remote-link": {
    site: ["jira-managed-remote-link-mutations.ts", GATE],
    pin: "jira-managed-remote-link-mutations.test.ts",
  },
  "jira.delete-remote-link-by-global-id": {
    site: ["jira-managed-remote-link-mutations.ts", GATE],
    pin: "jira-managed-remote-link-mutations.test.ts",
  },
  "jira.create-reciprocal-remote-link": {
    site: ["jira-managed-reciprocal-link.ts", GATE],
    pin: undefined,
  },
  "jira.create-worklog": {
    site: ["jira-managed-worklog-mutations.ts", WORKLOG[1]],
    pin: "jira-managed-worklog-mutations.test.ts",
  },
  "jira.update-worklog": {
    site: ["jira-managed-worklog-mutations.ts", WORKLOG[1]],
    pin: "jira-managed-worklog-mutations.test.ts",
  },
  "jira.delete-worklog": {
    site: ["jira-managed-worklog-delete.ts", WORKLOG[1]],
    pin: "jira-managed-worklog-mutations.test.ts",
  },
  "jira.epic-remove-issues": { site: [...PLANNING], pin: "jira-managed-agile-planning.test.ts" },
  "jira.rank-epic": { site: [...PLANNING], pin: undefined },
  "jira.rank-issues": { site: [...PLANNING], pin: undefined },
  "jira.set-issue-estimation": { site: [...PLANNING], pin: "jira-managed-agile-planning.test.ts" },
  "jira.sprint-move-issues": {
    site: ["jira-agile-membership.ts", AGILE[1]],
    pin: "jira-agile-templates.test.ts",
  },
  "jira.epic-move-issues": {
    site: ["jira-agile-membership.ts", AGILE[1]],
    pin: "jira-agile-templates.test.ts",
  },
  "jira.backlog-move-issues": {
    site: ["jira-agile-membership.ts", AGILE[1]],
    pin: "jira-agile-templates.test.ts",
  },
  "jira.epic-update": {
    site: ["jira-agile-mutations.ts", AGILE[1]],
    pin: "jira-agile-templates.test.ts",
  },
  "jira.sprint-update": {
    site: ["jira-agile-mutations.ts", BULK[1]],
    pin: "jira-agile-mutations.test.ts",
  },
  "jira.delete-component": { site: ["jira-managed-component-delete.ts", BULK[1]], pin: undefined },
  "jira.merge-version": {
    site: ["jira-managed-version-lifecycle.ts", BULK[1]],
    pin: "jira-managed-release-lifecycle.test.ts",
  },
  "jira.remove-and-swap-version": {
    site: ["jira-managed-version-lifecycle.ts", BULK[1]],
    pin: "jira-managed-release-lifecycle.test.ts",
  },
  "jira.delete-sprint": {
    site: ["jira-sprint-lifecycle-admission.ts", BULK[1]],
    pin: "jira-managed-sprint-lifecycle.test.ts",
  },
  "jira.replace-sprint": {
    site: ["jira-sprint-lifecycle-admission.ts", BULK[1]],
    pin: "jira-managed-sprint-lifecycle.test.ts",
  },
};
/** The gaps, exactly. A pin written for one of these removes it from here; the list never grows. */
const OPEN_GAPS = [
  "jira.create-reciprocal-remote-link",
  "jira.delete-component",
  "jira.rank-epic",
  "jira.rank-issues",
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(join(HERE, file), "utf8");
const GOVERNED_CLASSES = new Set([
  "create",
  "create-batch",
  "draft",
  "edit",
  "transition",
  "bulk-impact",
]);
const governed = Object.entries(JIRA_TEMPLATE_GOVERNANCE)
  .filter(([, governance]) => GOVERNED_CLASSES.has(governance.class))
  .map(([operation]) => operation)
  .sort();

describe("the write-path inventory (#4354)", () => {
  it("names the decisive code of every governed operation, and of nothing else", () => {
    expect(Object.keys(PATHS).sort()).toEqual(governed);
  });

  it.each(governed)("%s: the gate is applied where the inventory says", (operation) => {
    const path = PATHS[operation];
    if (path === undefined) throw new TypeError(`unlisted governed operation ${operation}`);
    expect(read(path.site[0]), `${operation} in ${path.site[0]}`).toContain(path.site[1]);
  });

  it.each(governed.filter((operation) => PATHS[operation]?.pin !== undefined))(
    "%s: its pinning test exists and names the operation or its owner family",
    (operation) => {
      const pin = PATHS[operation]?.pin;
      if (pin === undefined) throw new TypeError(`no pin for ${operation}`);
      const source = read(pin);
      const family = operation.replace("jira.", "").split("-")[0] ?? operation;
      expect(source.includes(operation) || source.includes(family)).toBe(true);
    },
  );

  it("keeps the list of unpinned operations exact and shrinking", () => {
    const gaps = governed.filter((operation) => PATHS[operation]?.pin === undefined);
    expect(gaps).toEqual([...OPEN_GAPS].sort());
  });
});
