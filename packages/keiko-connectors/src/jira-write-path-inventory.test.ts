import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JIRA_MUTATION_OPERATIONS,
  JIRA_TEMPLATE_GOVERNANCE,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The write-path inventory of #4354 as an executable contract. `JIRA_TEMPLATE_GOVERNANCE` says which
 * class every mutating operation is in; this table says, for every operation that is governed, the
 * decisive code that applies the template gate to it and the NAMED test that pins its refusal. The
 * gate sits below every autonomy mode and below both surfaces (Chat and the Coding Workbench), which
 * reach it through the one managed executor, so a path is proven once here for all of them.
 *
 * A pin is a test file plus a fragment of one test title. This suite resolves it: the fragment must
 * open an `it(` or `it.each(` registration in that file, so a renamed or deleted test breaks the
 * inventory instead of leaving an unrelated file that merely mentions templates.
 */
interface Pin {
  readonly file: string;
  /** A fragment of the pinning test's title, exactly as written in the file. */
  readonly title: string;
}
interface WritePath {
  /** The source file that applies the gate, and the identifier it applies it with. */
  readonly site: readonly [file: string, identifier: string];
  readonly pin: Pin;
}
const GATE = "gateJiraMutationByTemplates";
const MUTATIONS = "jira-managed-mutations.ts";
const WORKLOG = "gateJiraWorklogChange";
const AGILE = "gateJiraAgileIssueChange";
const BULK = "gateJiraBulkReferenceChange";
const IMPACT = "gateJiraSchemaRuleImpact";
const GATE_TEST = "jira-managed-template-gate.test.ts";
const LINK = "jira-managed-issue-link-mutations";
const REMOTE = "jira-managed-remote-link-mutations";
const PLANNING = ["jira-agile-planning-admission.ts", GATE] as const;
const PLANNING_TEST = "jira-managed-agile-planning.test.ts";
const REMOTE_PIN: Pin = {
  file: `${REMOTE}.test.ts`,
  title: "%s refuses an unreadable template library before any write",
};
const MEMBERSHIP_PIN: Pin = {
  file: "jira-agile-templates.test.ts",
  title: "%s refuses an unreadable template library before any POST",
};
const RELEASE_PIN: Pin = {
  file: "jira-managed-release-lifecycle.test.ts",
  title: "refuses %s for an affected active formal field before dispatch",
};
const RANK_PIN: Pin = {
  file: PLANNING_TEST,
  title: "refuses $name when a saved rule requires the rank field, before any write",
};
const SCHEMA_PIN: Pin = {
  file: "jira-managed-schema-mutations.test.ts",
  title: "%s refuses an unreadable template library before any write",
};
const SCHEMA_SITE = ["jira-schema-mutation-observations.ts", IMPACT] as const;

const PATHS: Readonly<Record<string, WritePath>> = {
  "jira.create": {
    site: [MUTATIONS, "createTemplateGate"],
    pin: { file: GATE_TEST, title: "refuses a violating create with structured violations" },
  },
  "jira.create-issues": {
    site: [MUTATIONS, "createTemplateGate"],
    pin: {
      file: "jira-bulk-create-preparation.test.ts",
      title: "applies saved create rules independently to every reviewed issue",
    },
  },
  "jira.draft": {
    site: ["jira-draft-stage-tool.ts", "checkJiraManagedMutationTemplates"],
    pin: {
      file: "jira-draft-stage-tool.test.ts",
      title: "refuses a page with a template violation whole, naming the item and the rule",
    },
  },
  "jira.edit": {
    site: [MUTATIONS, "admitFieldMutation"],
    pin: { file: GATE_TEST, title: "refuses an edit that breaks a field it touches" },
  },
  "jira.assign": {
    site: [MUTATIONS, "admitAssignment"],
    pin: {
      file: GATE_TEST,
      title: "refuses clearing a required assignee through jira.assign exactly as jira.edit does",
    },
  },
  "jira.transition": {
    site: [MUTATIONS, "admitFieldMutation"],
    pin: {
      file: GATE_TEST,
      title: "refuses a transition into the activating status until the issue conforms",
    },
  },
  "jira.create-issue-link": {
    site: [`${LINK}.ts`, GATE],
    pin: {
      file: `${LINK}.test.ts`,
      title: "jira.create-issue-link refuses an unreadable template library before any POST",
    },
  },
  "jira.delete-issue-link": {
    site: [`${LINK}.ts`, GATE],
    pin: {
      file: `${LINK}.test.ts`,
      title: "refuses the last required parent relation using the planned complete post-delete",
    },
  },
  "jira.upsert-remote-link": { site: [`${REMOTE}.ts`, GATE], pin: REMOTE_PIN },
  "jira.update-remote-link": { site: [`${REMOTE}.ts`, GATE], pin: REMOTE_PIN },
  "jira.delete-remote-link": { site: [`${REMOTE}.ts`, GATE], pin: REMOTE_PIN },
  "jira.delete-remote-link-by-global-id": { site: [`${REMOTE}.ts`, GATE], pin: REMOTE_PIN },
  "jira.create-reciprocal-remote-link": {
    site: ["jira-managed-reciprocal-link.ts", GATE],
    pin: {
      file: "jira-managed-reciprocal-link.test.ts",
      title: "refuses before any write when the saved templates cannot be read, check=%s",
    },
  },
  "jira.create-worklog": {
    site: ["jira-managed-worklog-mutations.ts", WORKLOG],
    pin: {
      file: "jira-managed-worklog-mutations.test.ts",
      title: "refuses unreadable saved templates before effect",
    },
  },
  "jira.update-worklog": {
    site: ["jira-managed-worklog-mutations.ts", WORKLOG],
    pin: {
      file: "jira-managed-worklog-mutations.test.ts",
      title: "jira.update-worklog refuses an unreadable template library before effect",
    },
  },
  "jira.delete-worklog": {
    site: ["jira-managed-worklog-delete.ts", WORKLOG],
    pin: {
      file: "jira-managed-worklog-delete.test.ts",
      title: "jira.delete-worklog refuses an unreadable template library before DELETE",
    },
  },
  "jira.epic-remove-issues": {
    site: [...PLANNING],
    pin: { file: PLANNING_TEST, title: "enforces required Epic Link removal" },
  },
  "jira.rank-epic": { site: [...PLANNING], pin: RANK_PIN },
  "jira.rank-issues": { site: [...PLANNING], pin: RANK_PIN },
  "jira.set-issue-estimation": {
    site: [...PLANNING],
    pin: {
      file: PLANNING_TEST,
      title: "does not use old remaining-estimate evidence to admit an unknown time post-state",
    },
  },
  "jira.sprint-move-issues": { site: ["jira-agile-membership.ts", AGILE], pin: MEMBERSHIP_PIN },
  "jira.epic-move-issues": { site: ["jira-agile-membership.ts", AGILE], pin: MEMBERSHIP_PIN },
  "jira.backlog-move-issues": { site: ["jira-agile-membership.ts", AGILE], pin: MEMBERSHIP_PIN },
  "jira.epic-update": {
    site: ["jira-agile-mutations.ts", AGILE],
    pin: {
      file: "jira-agile-templates.test.ts",
      title: "refuses an epic's proposed summary before POST",
    },
  },
  "jira.sprint-update": {
    site: ["jira-agile-mutations.ts", BULK],
    pin: {
      file: "jira-agile-mutations.test.ts",
      title: "applies saved %s rules before the existing partial sprint completion effect",
    },
  },
  "jira.delete-component": {
    site: ["jira-managed-component-delete.ts", BULK],
    pin: {
      file: "jira-managed-release-lifecycle.test.ts",
      title: "refuses required components before deletion, including preflight=%s",
    },
  },
  "jira.merge-version": { site: ["jira-managed-version-lifecycle.ts", BULK], pin: RELEASE_PIN },
  "jira.remove-and-swap-version": {
    site: ["jira-managed-version-lifecycle.ts", BULK],
    pin: RELEASE_PIN,
  },
  "jira.delete-sprint": {
    site: ["jira-sprint-lifecycle-admission.ts", BULK],
    pin: {
      file: "jira-managed-sprint-lifecycle.test.ts",
      title: "refuses deletion before any effect for a required Sprint field",
    },
  },
  "jira.replace-sprint": {
    site: ["jira-sprint-lifecycle-admission.ts", BULK],
    pin: {
      file: "jira-managed-sprint-lifecycle.test.ts",
      title:
        "jira.replace-sprint refuses an automatic start/stop replacement under a required Sprint",
    },
  },
  "jira.delete-issue": {
    site: ["jira-managed-issue-lifecycle.ts", IMPACT],
    pin: {
      file: "jira-managed-issue-lifecycle.test.ts",
      title:
        "composes the real deletion-impact owner and refuses surviving formal parent relations",
    },
  },
  "jira.delete-project": {
    site: ["jira-project-lifecycle-observations.ts", IMPACT],
    pin: {
      file: "jira-managed-project-lifecycle.test.ts",
      title: "uses global surviving-reference formal admission for project deletion",
    },
  },
  "jira.delete-issue-type": {
    site: [...SCHEMA_SITE],
    pin: {
      file: "jira-managed-schema-mutations.test.ts",
      title: "refuses schema migration when any active source/target type rule has unprovable",
    },
  },
  "jira.update-issue-type": {
    site: [...SCHEMA_SITE],
    pin: {
      file: "jira-managed-schema-mutations.test.ts",
      title: "checks type rename against name-selected formal rules",
    },
  },
  "jira.delete-custom-fields": { site: [...SCHEMA_SITE], pin: SCHEMA_PIN },
  "jira.update-link-type": { site: [...SCHEMA_SITE], pin: SCHEMA_PIN },
  "jira.delete-link-type": { site: [...SCHEMA_SITE], pin: SCHEMA_PIN },
};

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
const governed = JIRA_MUTATION_OPERATIONS.filter((operation) =>
  GOVERNED_CLASSES.has(JIRA_TEMPLATE_GOVERNANCE[operation].class),
).sort();

/** A title fragment opens a test registration: `it("…`, `it.each(…)("…` or `it.each(…)(\n "…`. */
function registersTest(source: string, title: string): boolean {
  const at = source.indexOf(`"${title}`);
  if (at < 0) return false;
  return /\bit(?:\.each\([\s\S]*?\))?\(\s*$/u.test(source.slice(Math.max(0, at - 4000), at));
}

describe("the write-path inventory (#4354)", () => {
  it("covers every registered mutation, classified exactly once", () => {
    expect(Object.keys(JIRA_TEMPLATE_GOVERNANCE).sort()).toEqual(
      [...JIRA_MUTATION_OPERATIONS].sort(),
    );
  });

  it("names the decisive code of every governed operation, and of nothing else", () => {
    expect(Object.keys(PATHS).sort()).toEqual(governed);
  });

  it.each(governed)("%s: the gate is applied where the inventory says", (operation) => {
    const path = PATHS[operation];
    if (path === undefined) throw new TypeError(`unlisted governed operation ${operation}`);
    expect(read(path.site[0]), `${operation} in ${path.site[0]}`).toContain(path.site[1]);
  });

  it.each(governed)("%s: the named pinning test is registered in its file", (operation) => {
    const pin = PATHS[operation]?.pin;
    if (pin === undefined) throw new TypeError(`no pin for ${operation}`);
    expect(registersTest(read(pin.file), pin.title), `${pin.file}: ${pin.title}`).toBe(true);
  });

  // The counts the ADR states are derived from the table, so a reclassification that does not
  // update the decision record fails here instead of leaving the record stale.
  it("keeps the counts stated in ADR-0128 equal to the classification", () => {
    const adr = read(
      "../../../docs/adr/ADR-0128-atlassian-connector-authority-and-security-design.md",
    );
    const count = (predicate: (governance: { readonly class: string }) => boolean): number =>
      JIRA_MUTATION_OPERATIONS.filter((operation) => predicate(JIRA_TEMPLATE_GOVERNANCE[operation]))
        .length;
    expect(adr).toContain(`${String(JIRA_MUTATION_OPERATIONS.length)} mutation operations`);
    expect(adr).toContain(
      `${String(count((g) => g.class === "bulk-impact"))} operations change issues in bulk`,
    );
    expect(adr).toContain(
      `the ${String(count((g) => g.class === "not-governed" && "reason" in g && g.reason === "not-issue-content"))} administration operations`,
    );
  });

  it("does not accept a fragment that is only mentioned, not registered as a test", () => {
    expect(registersTest('const x = "a title";\nit("other", () => {});', "a title")).toBe(false);
    expect(registersTest('it.each([1])(\n  "a title %s",\n  () => {},\n);', "a title")).toBe(true);
    expect(registersTest('describe("x", () => {\n  it(\n    "a title",', "a title")).toBe(true);
  });
});
