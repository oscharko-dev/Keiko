import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  JIRA_AVATAR_MUTATIONS,
  JIRA_AVATAR_UPLOAD_MUTATIONS,
  JIRA_IDENTITY_MUTATIONS,
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_GROUP_MUTATIONS,
  JIRA_MAINTENANCE_MUTATIONS,
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
  JIRA_ENTITY_PROPERTY_MUTATIONS,
  JIRA_SAVED_CONFIGURATION_MUTATIONS,
  JIRA_SCREEN_CONFIGURATION_MUTATIONS,
  JIRA_BOARD_CONFIGURATION_MUTATIONS,
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  JIRA_ROLE_MUTATIONS,
  JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  JIRA_PROJECT_CATEGORY_MUTATIONS,
  JIRA_ANONYMIZATION_UNLOCK_MUTATIONS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_TEMPLATE_GOVERNANCE,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { checkJiraManagedMutation } from "./jira-managed-mutations.js";
import type { JiraIssueTemplateSet } from "./jira-managed-template-gate.js";

/**
 * The write-path inventory of #4354 as an executable contract. It lists EVERY Jira write operation of
 * the production registry with its rule class (`JIRA_TEMPLATE_GOVERNANCE`: template-governed create,
 * edit rule, transition, bulk impact, free by rule, switched off, not issue content), the decisive
 * code and the NAMED test that pins it. The gate sits below every autonomy mode and below both
 * surfaces (Chat and the Coding Workbench), which reach it through the one managed executor, so a
 * path is proven once here for all of them.
 *
 * Two things are resolved, not just mentioned:
 * - A site is a function or constant DECLARED in the named file whose body uses the named gate, so an
 *   import or a comment can never satisfy it.
 * - A pin is a test file plus a fragment of one test title; the fragment must open an `it(` or
 *   `it.each(` registration in that file, so a renamed or deleted test breaks the inventory.
 * The operation set is the production registry on one side; this table is the other.
 */
interface Pin {
  readonly file: string;
  /** A fragment of the pinning test's title, exactly as written in the file. */
  readonly title: string;
}
/** The function or constant `declares` is declared in `file`, and its body uses `calls`. */
interface Site {
  readonly file: string;
  readonly declares: string;
  readonly calls: string;
}
interface WritePath {
  readonly site: Site;
  readonly pin: Pin;
}
const site = (file: string, declares: string, calls: string): Site => ({ file, declares, calls });

const GATE = "gateJiraMutationByTemplates";
const MUTATIONS = "jira-managed-mutations.ts";
const WORKLOG = "gateJiraWorklogChange";
const AGILE = "gateJiraAgileIssueChange";
const BULK = "gateJiraBulkReferenceChange";
const IMPACT = "gateJiraSchemaRuleImpact";
const GATE_TEST = "jira-managed-template-gate.test.ts";
const LINK = "jira-managed-issue-link-mutations";
const REMOTE = "jira-managed-remote-link-mutations";
const PLANNING_SITE = site("jira-agile-planning-admission.ts", "formalGate", GATE);
const PLANNING_TEST = "jira-managed-agile-planning.test.ts";
const MEMBERSHIP_SITE = site("jira-agile-membership.ts", "mutateAgileMembership", AGILE);
const VERSION_SITE = site(
  "jira-managed-version-lifecycle.ts",
  "executeJiraVersionLifecycleMutation",
  BULK,
);
const SPRINT_SITE = site("jira-sprint-lifecycle-admission.ts", "lifecycleMembershipGate", BULK);
const SCHEMA_SITE = site("jira-schema-mutation-observations.ts", "admitSchemaMutation", IMPACT);
const REMOTE_SITE = site(`${REMOTE}.ts`, "admitRemoteLink", GATE);
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
const CREATE_SITE = site(MUTATIONS, "createTemplateGate", GATE);
const FIELD_SITE = site(MUTATIONS, "admitFieldMutation", GATE);

/** Every operation whose write is judged by the saved templates. */
const GOVERNED: Readonly<Record<string, WritePath>> = {
  "jira.create": {
    site: CREATE_SITE,
    pin: { file: GATE_TEST, title: "refuses a violating create with structured violations" },
  },
  "jira.create-issues": {
    site: CREATE_SITE,
    pin: {
      file: "jira-bulk-create-preparation.test.ts",
      title: "applies saved create rules independently to every reviewed issue",
    },
  },
  "jira.draft": {
    site: site(
      "jira-draft-stage-tool.ts",
      "firstJiraDraftTemplateRefusal",
      "checkJiraManagedMutationTemplates",
    ),
    pin: {
      file: "jira-draft-stage-tool.test.ts",
      title: "refuses a page with a template violation whole, naming the item and the rule",
    },
  },
  "jira.edit": {
    site: FIELD_SITE,
    pin: { file: GATE_TEST, title: "refuses an edit that breaks a field it touches" },
  },
  "jira.assign": {
    site: site(MUTATIONS, "admitAssignment", GATE),
    pin: {
      file: GATE_TEST,
      title: "refuses clearing a required assignee through jira.assign exactly as jira.edit does",
    },
  },
  "jira.transition": {
    site: FIELD_SITE,
    pin: {
      file: GATE_TEST,
      title: "refuses a transition into the activating status until the issue conforms",
    },
  },
  "jira.create-issue-link": {
    site: site(`${LINK}.ts`, "templateAdmission", GATE),
    pin: {
      file: `${LINK}.test.ts`,
      title: "jira.create-issue-link refuses an unreadable template library before any POST",
    },
  },
  "jira.delete-issue-link": {
    site: site(`${LINK}.ts`, "templateAdmission", GATE),
    pin: {
      file: `${LINK}.test.ts`,
      title: "refuses the last required parent relation using the planned complete post-delete",
    },
  },
  "jira.upsert-remote-link": { site: REMOTE_SITE, pin: REMOTE_PIN },
  "jira.update-remote-link": { site: REMOTE_SITE, pin: REMOTE_PIN },
  "jira.delete-remote-link": { site: REMOTE_SITE, pin: REMOTE_PIN },
  "jira.delete-remote-link-by-global-id": { site: REMOTE_SITE, pin: REMOTE_PIN },
  "jira.create-reciprocal-remote-link": {
    site: site("jira-managed-reciprocal-link.ts", "admit", GATE),
    pin: {
      file: "jira-managed-reciprocal-link.test.ts",
      title: "refuses before any write when the saved templates cannot be read, check=%s",
    },
  },
  "jira.create-worklog": {
    site: site("jira-managed-worklog-mutations.ts", "executeJiraWorklogMutation", WORKLOG),
    pin: {
      file: "jira-managed-worklog-mutations.test.ts",
      title: "refuses unreadable saved templates before effect",
    },
  },
  "jira.update-worklog": {
    site: site("jira-managed-worklog-mutations.ts", "executeJiraWorklogMutation", WORKLOG),
    pin: {
      file: "jira-managed-worklog-mutations.test.ts",
      title: "jira.update-worklog refuses an unreadable template library before effect",
    },
  },
  "jira.delete-worklog": {
    site: site("jira-managed-worklog-delete.ts", "executeJiraWorklogDelete", WORKLOG),
    pin: {
      file: "jira-managed-worklog-delete.test.ts",
      title: "jira.delete-worklog refuses an unreadable template library before DELETE",
    },
  },
  "jira.epic-remove-issues": {
    site: PLANNING_SITE,
    pin: { file: PLANNING_TEST, title: "enforces required Epic Link removal" },
  },
  "jira.rank-epic": { site: PLANNING_SITE, pin: RANK_PIN },
  "jira.rank-issues": { site: PLANNING_SITE, pin: RANK_PIN },
  "jira.set-issue-estimation": {
    site: PLANNING_SITE,
    pin: {
      file: PLANNING_TEST,
      title: "does not use old remaining-estimate evidence to admit an unknown time post-state",
    },
  },
  "jira.sprint-move-issues": { site: MEMBERSHIP_SITE, pin: MEMBERSHIP_PIN },
  "jira.epic-move-issues": { site: MEMBERSHIP_SITE, pin: MEMBERSHIP_PIN },
  "jira.backlog-move-issues": { site: MEMBERSHIP_SITE, pin: MEMBERSHIP_PIN },
  "jira.epic-update": {
    site: site("jira-agile-mutations.ts", "updateAdmission", AGILE),
    pin: {
      file: "jira-agile-templates.test.ts",
      title: "refuses an epic's proposed summary before POST",
    },
  },
  "jira.sprint-update": {
    site: site("jira-agile-mutations.ts", "updateAdmission", BULK),
    pin: {
      file: "jira-agile-mutations.test.ts",
      title: "applies saved %s rules before the existing partial sprint completion effect",
    },
  },
  "jira.delete-component": {
    site: site("jira-managed-component-delete.ts", "executeJiraComponentDelete", BULK),
    pin: {
      file: "jira-managed-release-lifecycle.test.ts",
      title: "refuses required components before deletion, including preflight=%s",
    },
  },
  "jira.merge-version": { site: VERSION_SITE, pin: RELEASE_PIN },
  "jira.remove-and-swap-version": { site: VERSION_SITE, pin: RELEASE_PIN },
  "jira.delete-sprint": {
    site: SPRINT_SITE,
    pin: {
      file: "jira-managed-sprint-lifecycle.test.ts",
      title: "refuses deletion before any effect for a required Sprint field",
    },
  },
  "jira.replace-sprint": {
    site: SPRINT_SITE,
    pin: {
      file: "jira-managed-sprint-lifecycle.test.ts",
      title:
        "jira.replace-sprint refuses an automatic start/stop replacement under a required Sprint",
    },
  },
  "jira.delete-issue": {
    site: site("jira-managed-issue-lifecycle.ts", "jiraIssueDeletionAdmission", IMPACT),
    pin: {
      file: "jira-managed-issue-lifecycle.test.ts",
      title:
        "composes the real deletion-impact owner and refuses surviving formal parent relations",
    },
  },
  "jira.delete-project": {
    site: site("jira-project-lifecycle-observations.ts", "admitProjectLifecycle", IMPACT),
    pin: {
      file: "jira-managed-project-lifecycle.test.ts",
      title: "uses global surviving-reference formal admission for project deletion",
    },
  },
  "jira.delete-issue-type": {
    site: SCHEMA_SITE,
    pin: {
      file: "jira-managed-schema-mutations.test.ts",
      title: "refuses schema migration when any active source/target type rule has unprovable",
    },
  },
  "jira.update-issue-type": {
    site: SCHEMA_SITE,
    pin: {
      file: "jira-managed-schema-mutations.test.ts",
      title: "checks type rename against name-selected formal rules",
    },
  },
  "jira.delete-custom-fields": { site: SCHEMA_SITE, pin: SCHEMA_PIN },
  "jira.update-link-type": { site: SCHEMA_SITE, pin: SCHEMA_PIN },
  "jira.delete-link-type": { site: SCHEMA_SITE, pin: SCHEMA_PIN },
};

const GOVERNANCE_SOURCE = "../../keiko-contracts/src/jira-template-governance.ts";
const GOVERNANCE_TEST = "../../keiko-contracts/src/jira-template-governance.test.ts";
const FREE_PIN = (title: string): Pin => ({ file: GOVERNANCE_TEST, title });
const governanceSite = (constant: string, reason: string): Site =>
  site(GOVERNANCE_SOURCE, constant, reason);
/**
 * Free by rule: the owner decided that a status change, a comment, a watcher or a vote is not
 * judged by a template, and archive, restore and subtask reordering change no governed field. The
 * decisive record is the classification itself, resolved by the declaration that holds the class.
 */
const FREE_PIN_COMMENT = FREE_PIN(
  "leaves comments, watchers and the withdrawn attachments ungoverned on purpose",
);
/** The same record for several operations. */
const forEach = (
  operations: readonly string[],
  path: WritePath,
): readonly (readonly [string, WritePath])[] => operations.map((operation) => [operation, path]);
const FREE: Readonly<Record<string, WritePath>> = Object.fromEntries([
  ...forEach(
    ["jira.archive-issue", "jira.archive-issues", "jira.restore-issue", "jira.move-subtask"],
    {
      site: governanceSite("LIFECYCLE", "issue-lifecycle"),
      pin: FREE_PIN("names move-subtask, archive and restore explicitly, with their reason"),
    },
  ),
  ...forEach(
    [
      "jira.comment",
      "jira.update-comment",
      "jira.delete-comment",
      "jira.pin-comment",
      "jira.notify-issue",
    ],
    { site: governanceSite("COMMENT", "comment"), pin: FREE_PIN_COMMENT },
  ),
  ...forEach(["jira.watch", "jira.unwatch", "jira.vote", "jira.unvote"], {
    site: governanceSite("PARTICIPATION", "participation"),
    pin: FREE_PIN_COMMENT,
  }),
]);
/** Switched off for Release 1 behind the one switch; the executor and its dry run refuse them. */
const RELEASE_SWITCH_PIN: Pin = {
  file: "jira-release-scope.test.ts",
  title: "refuses %s with a readable message and sends no request, executing or checking",
};
const SWITCHED_OFF: Readonly<Record<string, WritePath>> = Object.fromEntries(
  forEach(["jira.attach", "jira.delete-attachment"], {
    site: site(MUTATIONS, "executeJiraManagedMutationInner", "jiraOperationInReleaseScope"),
    pin: RELEASE_SWITCH_PIN,
  }),
);
/** Administration, project and agile structure, accounts and instance settings: no issue field. */
const NOT_ISSUE_CONTENT: WritePath = {
  site: governanceSite("NOT_ISSUE_CONTENT", "not-issue-content"),
  pin: FREE_PIN("uses every closed reason at least once, so none is dead"),
};

/**
 * Records that are not an operation of their own but a refusal every write path shares: the Epic
 * Link target check on its three call sites, the moved-away transition mapping and the release
 * switch on the executor and on its dry run.
 */
const SHARED_RECORDS: readonly (readonly [name: string, WritePath])[] = [
  [
    "Epic Link target, single edit",
    {
      site: site(MUTATIONS, "admitFieldMutation", "epicLinkTargetRefusal"),
      pin: {
        file: "jira-epic-link-target.test.ts",
        title: "refuses an edit that sets the Epic Link to a Task, and sends nothing",
      },
    },
  ],
  [
    "Epic Link target, create",
    {
      site: site(MUTATIONS, "prepareCreateWithMetadata", "epicLinkTargetRefusal"),
      pin: {
        file: "jira-epic-link-target.test.ts",
        title: "refuses a creation whose Epic Link points to a Task before any write",
      },
    },
  ],
  [
    "Epic Link target, draft item",
    {
      site: site(MUTATIONS, "draftItemEpicFailure", "epicLinkTargetRefusal"),
      pin: {
        file: "jira-epic-link-target.test.ts",
        title: "is refused before the review card when its Epic Link points to a Task",
      },
    },
  ],
  [
    "moved-away transition mapping",
    {
      site: site(MUTATIONS, "statusMutation", "transitionMovedAway"),
      pin: {
        file: "jira-transition-fields.test.ts",
        title: "maps a %i on the POST of a listed transition to invalid-transition",
      },
    },
  ],
  [
    "release switch, executor",
    {
      site: site(MUTATIONS, "executeJiraManagedMutationInner", "jiraOperationInReleaseScope"),
      pin: RELEASE_SWITCH_PIN,
    },
  ],
  [
    "release switch, dry run",
    {
      site: site(MUTATIONS, "checkJiraManagedMutation", "jiraOperationInReleaseScope"),
      pin: RELEASE_SWITCH_PIN,
    },
  ],
];

/**
 * The families the governance table classifies as administration with one call. The stated count of
 * each is pinned here against the registry's own array, so an operation added to such a family fails
 * this test until someone confirms it is administration and raises the count.
 */
const ADMINISTRATION_FAMILIES: readonly (readonly [
  name: string,
  members: readonly string[],
  count: number,
])[] = [
  ["JIRA_AVATAR_MUTATIONS", JIRA_AVATAR_MUTATIONS, 15],
  ["JIRA_AVATAR_UPLOAD_MUTATIONS", JIRA_AVATAR_UPLOAD_MUTATIONS, 5],
  ["JIRA_IDENTITY_MUTATIONS", JIRA_IDENTITY_MUTATIONS, 6],
  ["JIRA_PRIVATE_ACCOUNT_MUTATIONS", JIRA_PRIVATE_ACCOUNT_MUTATIONS, 6],
  ["JIRA_GROUP_MUTATIONS", JIRA_GROUP_MUTATIONS, 4],
  ["JIRA_MAINTENANCE_MUTATIONS", JIRA_MAINTENANCE_MUTATIONS, 12],
  ["JIRA_DIRECTORY_ACCESS_MUTATIONS", JIRA_DIRECTORY_ACCESS_MUTATIONS, 6],
  ["JIRA_ENTITY_PROPERTY_MUTATIONS", JIRA_ENTITY_PROPERTY_MUTATIONS, 16],
  ["JIRA_SAVED_CONFIGURATION_MUTATIONS", JIRA_SAVED_CONFIGURATION_MUTATIONS, 10],
  ["JIRA_SCREEN_CONFIGURATION_MUTATIONS", JIRA_SCREEN_CONFIGURATION_MUTATIONS, 6],
  ["JIRA_BOARD_CONFIGURATION_MUTATIONS", JIRA_BOARD_CONFIGURATION_MUTATIONS, 2],
  ["JIRA_OPTION_SCHEME_MUTATIONS", JIRA_OPTION_SCHEME_MUTATIONS, 10],
  ["JIRA_WORKFLOW_SCHEME_MUTATIONS", JIRA_WORKFLOW_SCHEME_MUTATIONS, 18],
  ["JIRA_INSTANCE_SETTING_MUTATIONS", JIRA_INSTANCE_SETTING_MUTATIONS, 4],
  ["JIRA_EMAIL_TEMPLATE_MUTATIONS", JIRA_EMAIL_TEMPLATE_MUTATIONS, 3],
  ["JIRA_PERMISSION_SCHEME_MUTATIONS", JIRA_PERMISSION_SCHEME_MUTATIONS, 6],
  ["JIRA_ROLE_MUTATIONS", JIRA_ROLE_MUTATIONS, 9],
  ["JIRA_VERSION_REMOTE_LINK_MUTATIONS", JIRA_VERSION_REMOTE_LINK_MUTATIONS, 4],
  ["JIRA_PROJECT_CATEGORY_MUTATIONS", JIRA_PROJECT_CATEGORY_MUTATIONS, 3],
  ["JIRA_ANONYMIZATION_UNLOCK_MUTATIONS", JIRA_ANONYMIZATION_UNLOCK_MUTATIONS, 1],
];
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
const OPERATIONS = [...JIRA_MUTATION_OPERATIONS].sort();
/** The registry's rule class of an operation, by name; an unknown name is a defect of the table. */
function classOf(name: string): string {
  const operation = OPERATIONS.find((candidate) => candidate === name);
  if (operation === undefined) throw new TypeError(`${name} is not a registered Jira mutation`);
  const governance = JIRA_TEMPLATE_GOVERNANCE[operation];
  return governance.class === "not-governed" ? `free:${governance.reason}` : governance.class;
}
const governed = OPERATIONS.filter((operation) =>
  GOVERNED_CLASSES.has(JIRA_TEMPLATE_GOVERNANCE[operation].class),
);
const notIssueContent = OPERATIONS.filter(
  (operation) => classOf(operation) === "free:not-issue-content",
);

/** The source with every comment removed, so a comment can never satisfy a site. */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
}
/** The body of the top-level function or constant `name`, up to the next top-level declaration. */
function declarationBody(source: string, name: string): string | undefined {
  const text = code(source);
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\b)`,
    "mu",
  ).exec(text);
  if (declaration === null) return undefined;
  const rest = text.slice(declaration.index + declaration[0].length);
  const next = /^(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type|let)\s/mu.exec(
    rest,
  );
  return next === null ? rest : rest.slice(0, next.index);
}
/** Whether `declares` is declared in `source` and its body names `calls` (word-bounded or quoted). */
function siteHolds(source: string, { declares, calls }: Pick<Site, "declares" | "calls">): boolean {
  const body = declarationBody(source, declares);
  return body !== undefined && new RegExp(`(?<![\\w-])${calls}(?![\\w-])`, "u").test(body);
}
/** A title fragment opens a test registration: `it("…`, `it.each(…)("…` or `it.each(…)(\n "…`. */
function registersTest(source: string, title: string): boolean {
  const at = source.indexOf(`"${title}`);
  if (at < 0) return false;
  return /\bit(?:\.each\([\s\S]*?\))?\(\s*$/u.test(source.slice(Math.max(0, at - 4000), at));
}

const ENTRIES: readonly (readonly [name: string, rule: string, path: WritePath])[] = [
  ...[GOVERNED, FREE, SWITCHED_OFF].flatMap((table) =>
    Object.entries(table).map(
      ([operation, path]) => [operation, classOf(operation), path] as const,
    ),
  ),
  [
    `all ${String(notIssueContent.length)} administration, project, agile-structure, account and instance operations`,
    "free:not-issue-content",
    NOT_ISSUE_CONTENT,
  ],
  ...SHARED_RECORDS.map(([name, path]) => [name, "shared refusal", path] as const),
];

describe("the write-path inventory (#4354)", () => {
  it("lists every registered write operation exactly once, with the rule class the registry gives", () => {
    const listed = [
      ...Object.keys(GOVERNED),
      ...Object.keys(FREE),
      ...Object.keys(SWITCHED_OFF),
      ...notIssueContent,
    ].sort();
    expect(listed).toEqual(OPERATIONS);
    expect(Object.keys(GOVERNED).sort()).toEqual(governed);
    for (const operation of Object.keys(FREE))
      expect(classOf(operation)).toMatch(/^free:(issue-lifecycle|comment|participation)$/u);
    for (const operation of Object.keys(SWITCHED_OFF))
      expect(classOf(operation)).toBe("free:attachment-withdrawn");
  });

  it.each(ENTRIES)("%s [%s]: the site is declared and uses its gate", (_name, _rule, path) => {
    expect(
      siteHolds(read(path.site.file), path.site),
      `${path.site.file}: ${path.site.declares} -> ${path.site.calls}`,
    ).toBe(true);
  });

  it.each(ENTRIES)("%s [%s]: the named pinning test is registered in its file", (_n, _r, path) => {
    expect(
      registersTest(read(path.pin.file), path.pin.title),
      `${path.pin.file}: ${path.pin.title}`,
    ).toBe(true);
  });

  describe("the families classified as administration with one call", () => {
    it("are exactly the ones the governance table names, no more and no fewer", () => {
      const call =
        /\.\.\.administration\(\[([\s\S]*?)\]\)/u.exec(read(GOVERNANCE_SOURCE))?.[1] ?? "";
      const named = [...call.matchAll(/JIRA_[A-Z_]+_MUTATIONS/gu)].map((match) => match[0]);
      expect(named.sort()).toEqual(ADMINISTRATION_FAMILIES.map(([name]) => name).sort());
    });

    it.each(ADMINISTRATION_FAMILIES)(
      "%s holds exactly the stated number of operations, all of them administration",
      (_name, members, count) => {
        expect(members).toHaveLength(count);
        for (const operation of members)
          expect(classOf(operation), operation).toBe("free:not-issue-content");
      },
    );
  });

  // The group of administration operations is derived from the registry above, so a new one joins it
  // automatically, and this runs once per member: the dry run of a not-issue-content operation never
  // so much as asks for the template library, even when the library would refuse every governed
  // write, and is never refused by a template rule. The arguments are empty on purpose: the case
  // proves the gate is not reached, not that the operation succeeds.
  describe.each(notIssueContent)("%s [free:not-issue-content]", (operation) => {
    it("is classified once, outside every governed table, and never consults the templates", async () => {
      expect(classOf(operation)).toBe("free:not-issue-content");
      for (const table of [GOVERNED, FREE, SWITCHED_OFF])
        expect(table).not.toHaveProperty(operation);
      const templates = vi.fn<() => JiraIssueTemplateSet>(() => ({ templates: [], unreadable: 1 }));
      const http = vi.fn<AtlassianHttpBodyPort>(() =>
        Promise.resolve({
          kind: "response",
          status: 404,
          bodyText: "",
          bodyBytes: 0,
          truncated: false,
        }),
      );
      const result = await checkJiraManagedMutation(
        operation,
        {},
        {
          invocationId: "inventory",
          correlationId: "inventory",
          signal: new AbortController().signal,
          beforeEffect: () => true,
        },
        {
          deployment: "data-center",
          baseUrl: "https://jira.example.invalid/context",
          http,
          issueTemplates: templates,
        },
      );
      expect(templates).not.toHaveBeenCalled();
      expect(result.ok || result.violations === undefined).toBe(true);
    });
  });

  // The site and pin checks are only worth anything if they can fail: each of these shapes is what
  // an import, a comment or an unrelated mention would look like.
  describe("the checks themselves", () => {
    const source = [
      'import { gate } from "./gate.js";',
      "// function applies() { gate(); }",
      "/* function applies() { gate(); } */",
      "export function other() {",
      "  return gate();",
      "}",
      "async function applies() {",
      "  return gate();",
      "}",
      "const declared = () => 1;",
    ].join("\n");

    it("resolves a declaration whose body uses the gate", () => {
      expect(siteHolds(source, { declares: "applies", calls: "gate" })).toBe(true);
      expect(siteHolds(source, { declares: "other", calls: "gate" })).toBe(true);
    });

    it("does not accept an import, a comment, an undeclared name or another function's call", () => {
      expect(siteHolds(source, { declares: "missing", calls: "gate" })).toBe(false);
      expect(siteHolds(source, { declares: "declared", calls: "gate" })).toBe(false);
      expect(siteHolds(source, { declares: "applies", calls: "gat" })).toBe(false);
      expect(
        siteHolds('import { gate } from "x";\n// function f() { gate(); }\nconst g = 1;', {
          declares: "f",
          calls: "gate",
        }),
      ).toBe(false);
    });

    it("does not accept a fragment that is only mentioned, not registered as a test", () => {
      expect(registersTest('const x = "a title";\nit("other", () => {});', "a title")).toBe(false);
      expect(registersTest('it.each([1])(\n  "a title %s",\n  () => {},\n);', "a title")).toBe(
        true,
      );
      expect(registersTest('describe("x", () => {\n  it(\n    "a title",', "a title")).toBe(true);
    });
  });

  // The counts the ADR states are derived from the classification, so a reclassification that does
  // not update the decision record fails here instead of leaving the record stale.
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
    expect(adr).toContain(`the ${String(notIssueContent.length)} administration operations`);
  });
});
