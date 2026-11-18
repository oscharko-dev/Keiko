import { describe, expect, it } from "vitest";
import {
  bindJiraIssueTemplateText,
  editJiraTemplateForm,
  isJiraNativeId,
  jiraTemplateBindingDigest,
  jiraTemplateBoundFieldId,
  jiraTemplateBoundStatusId,
  jiraTemplateForInstance,
  jiraTemplateIssueTypeMatches,
  jiraTemplateParentEntryMatches,
  jiraTemplateParentTypeMatches,
  parseJiraIssueTemplate,
  rebindJiraTemplateAfterEdit,
  resolveJiraTemplateFieldIds,
  type JiraIssueTemplate,
  type JiraTemplateBinding,
  type JiraTemplateBindingIds,
} from "./jira-issue-template.js";

// #4354: a template's binding is written by the product into its front matter, so it travels with an
// exported copy. It is in force only for the Jira, the typed names and the ids it was written with.
const INSTANCE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const PLAIN = [
  "---",
  "keiko: jira-issue-template",
  "version: 1",
  "project: SYN",
  "issueType: Aufgabe",
  "activateOn: [create, edit, transition:In Arbeit, transition:21]",
  "requiredFields: [Fälligkeitsdatum, Priorität]",
  "parentField: Epic Link",
  "parentIssueTypes: [Epos]",
  "---",
  "# Aufgabe",
  "",
  "## Kontext",
].join("\n");

function template(markdown: string): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(markdown);
  if (!result.ok) throw new TypeError("Expected a parseable template");
  return result.template;
}

/** The binding the product would write for this document in this Jira: the digest comes from its producer. */
function bindingFor(
  markdown: string,
  instance: string,
  ids: JiraTemplateBindingIds,
): JiraTemplateBinding {
  return { digest: jiraTemplateBindingDigest(instance, template(markdown), ids), ...ids };
}

const IDS: JiraTemplateBindingIds = {
  issueTypeId: "10002",
  parentIssueTypeIds: ["10000"],
  requiredFieldIds: ["duedate", "priority"],
  parentFieldId: "customfield_10109",
  transitionStatusIds: ["3", "none"],
};
const BINDING = bindingFor(PLAIN, INSTANCE, IDS);
const BOUND = bindJiraIssueTemplateText(PLAIN, BINDING) ?? "";
const BINDING_LINE =
  /^(issueTypeId|parentIssueTypeIds|requiredFieldIds|parentFieldId|transitionStatusIds|jiraBinding):/u;

describe("the binding lines the product writes", () => {
  it("are parsed back as the template's binding and leave every other line as it was", () => {
    expect(BOUND).not.toBe("");
    expect(template(BOUND).binding).toEqual(BINDING);
    const lines = BOUND.split("\n").filter((line) => !BINDING_LINE.test(line));
    expect(lines).toEqual(PLAIN.split("\n"));
  });

  it("replace an earlier binding instead of adding a second one", () => {
    const again = bindJiraIssueTemplateText(
      BOUND,
      bindingFor(PLAIN, OTHER, { ...IDS, issueTypeId: "10009" }),
    );
    expect(template(again ?? "").binding?.issueTypeId).toBe("10009");
    expect((again ?? "").match(/^issueTypeId:/gmu)).toHaveLength(1);
    expect((again ?? "").match(/^jiraBinding:/gmu)).toHaveLength(1);
  });

  it("are not offered without a closed front matter or without an issueType line", () => {
    expect(bindJiraIssueTemplateText("# no front matter", BINDING)).toBeUndefined();
    expect(
      bindJiraIssueTemplateText(PLAIN.replace("issueType: Aufgabe\n", ""), BINDING),
    ).toBeUndefined();
  });
});

// B1: a binding that is not confirmed by everything it was written from never governs.
describe("a binding is in force only for the Jira, the typed names and the ids it was written with", () => {
  const edited = (from: string, to: string): JiraIssueTemplate => template(BOUND.replace(from, to));

  it("survives an edit that changes neither the names, the ids nor the Jira (case and blanks do not matter)", () => {
    expect(jiraTemplateForInstance(template(BOUND), INSTANCE).binding).toEqual(BINDING);
    expect(
      jiraTemplateForInstance(edited("issueType: Aufgabe", "issueType:   aufgabe "), INSTANCE)
        .binding,
    ).toEqual(BINDING);
  });

  it("is dropped when the typed issue type is edited, so the old id no longer governs the new type", () => {
    const bug = jiraTemplateForInstance(edited("issueType: Aufgabe", "issueType: Bug"), INSTANCE);
    expect(bug.binding).toBeUndefined();
    // Name matching: the template now governs Bug, not the type whose id it still carries.
    expect(jiraTemplateIssueTypeMatches(bug, { id: "10002", name: "Aufgabe" })).toBe(false);
    expect(jiraTemplateIssueTypeMatches(bug, { id: "10005", name: "Bug" })).toBe(true);
  });

  it("is dropped when the typed parent types, fields or transition targets are edited", () => {
    for (const [from, to] of [
      ["parentIssueTypes: [Epos]", "parentIssueTypes: [Story]"],
      [
        "requiredFields: [Fälligkeitsdatum, Priorität]",
        "requiredFields: [Fälligkeitsdatum, Lösung]",
      ],
      ["parentField: Epic Link", "parentField: Epic Name"],
      ["transition:In Arbeit", "transition:Fertig"],
    ] as const)
      expect(jiraTemplateForInstance(edited(from, to), INSTANCE).binding, to).toBeUndefined();
  });

  // The audit's finding: editing ONLY an id left a valid binding that governed another type.
  it("is dropped when an id alone is edited by hand, whichever id it is", () => {
    for (const [from, to] of [
      ['issueTypeId: "10002"', 'issueTypeId: "10999"'],
      ['parentIssueTypeIds: ["10000"]', 'parentIssueTypeIds: ["10999"]'],
      ['requiredFieldIds: ["duedate","priority"]', 'requiredFieldIds: ["duedate","summary"]'],
      ['parentFieldId: "customfield_10109"', 'parentFieldId: "customfield_10999"'],
      ['transitionStatusIds: ["3","none"]', 'transitionStatusIds: ["4","none"]'],
    ] as const) {
      const hand = template(BOUND.replace(from, to));
      expect(hand.binding, to).toBeDefined();
      expect(jiraTemplateForInstance(hand, INSTANCE).binding, to).toBeUndefined();
    }
    const type = jiraTemplateForInstance(template(BOUND.replace('"10002"', '"10999"')), INSTANCE);
    expect(jiraTemplateIssueTypeMatches(type, { id: "10002", name: "Aufgabe" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(type, { id: "10999", name: "Bug" })).toBe(false);
  });

  it("is dropped on another Jira", () => {
    const foreign = jiraTemplateForInstance(template(BOUND), OTHER);
    expect(foreign.binding).toBeUndefined();
    expect(jiraTemplateIssueTypeMatches(foreign, { id: "10002", name: "Task" })).toBe(false);
    expect(jiraTemplateForInstance(template(BOUND), undefined).binding).toBeUndefined();
  });

  it("is never made by a hand-written id: ids without the digest are no binding, a wrong digest is dropped", () => {
    const body = (extra: string): string => PLAIN.replace("activateOn:", `${extra}\nactivateOn:`);
    const handWritten = template(body('issueTypeId: "10002"'));
    expect(handWritten.binding).toBeUndefined();
    expect(jiraTemplateIssueTypeMatches(handWritten, { id: "10002", name: "Task" })).toBe(false);
    const forged = template(body(`issueTypeId: "10002"\njiraBinding: "${"0".repeat(32)}"`));
    expect(forged.binding).toBeUndefined();
  });

  // The pins of the retired rule "ids without the Jira they belong to, or the other way round, are
  // refused": such a half-written binding is no binding, whichever half is missing.
  it("can never be taken as a binding when it is half-written", () => {
    const body = (extra: string): string => PLAIN.replace("activateOn:", `${extra}\nactivateOn:`);
    for (const half of [
      'issueTypeId: "10002"',
      `jiraBinding: "${INSTANCE}"`,
      `jiraBinding: "${INSTANCE}"\nparentIssueTypeIds: ["10000"]`,
    ]) {
      const parsed = parseJiraIssueTemplate(body(half));
      expect(parsed.ok && parsed.template.binding, half).toBeFalsy();
    }
  });

  it("is no binding when its ids do not line up one for one with the typed names", () => {
    const lines = (change: (line: string) => string): JiraIssueTemplate =>
      template(BOUND.split("\n").map(change).join("\n"));
    const shorter = (line: string): string =>
      line.startsWith("parentIssueTypeIds:") ? 'parentIssueTypeIds: ["10000","10001"]' : line;
    expect(lines(shorter).binding).toBeUndefined();
    const fewerFields = (line: string): string =>
      line.startsWith("requiredFieldIds:") ? 'requiredFieldIds: ["duedate"]' : line;
    expect(lines(fewerFields).binding).toBeUndefined();
    const moreStatuses = (line: string): string =>
      line.startsWith("transitionStatusIds:") ? 'transitionStatusIds: ["3","none","5"]' : line;
    expect(lines(moreStatuses).binding).toBeUndefined();
  });

  it("refuses ids and digests that are no ids or digests", () => {
    const body = (extra: string): string => PLAIN.replace("activateOn:", `${extra}\nactivateOn:`);
    expect(parseJiraIssueTemplate(body('issueTypeId: "Task"')).ok).toBe(false);
    expect(parseJiraIssueTemplate(body('jiraBinding: "x"')).ok).toBe(false);
    expect(parseJiraIssueTemplate(body('requiredFieldIds: ["not an id"]')).ok).toBe(false);
    expect(parseJiraIssueTemplate(body('transitionStatusIds: ["abc"]')).ok).toBe(false);
  });
});

describe("what the writer does to the document (S4)", () => {
  it("keeps every other byte and the CRLF line endings of the document", () => {
    const crlf = PLAIN.replaceAll("\n", "\r\n") + "\r\n";
    const written = bindJiraIssueTemplateText(crlf, BINDING) ?? "";
    expect(written).not.toBe("");
    expect(written).not.toMatch(/(?<!\r)\n/u);
    const others = written.split("\r\n").filter((line) => !BINDING_LINE.test(line));
    expect(others).toEqual(crlf.split("\r\n"));
    expect(template(written).binding).toEqual(BINDING);
  });

  it("touches only binding lines that start in the first column", () => {
    const withLookAlike = BOUND.replace("version: 1", "version: 1\n# note\n");
    const written = bindJiraIssueTemplateText(withLookAlike, BINDING) ?? "";
    expect(written).toContain("# note");
    // An indented look-alike is the parser's key too: the result would carry two, so nothing is written.
    const indented = PLAIN.replace("activateOn:", '  issueTypeId: "5"\nactivateOn:');
    expect(bindJiraIssueTemplateText(indented, BINDING)).toBeUndefined();
  });

  it("returns only text that parses back to a template carrying exactly this binding", () => {
    const wrongIds = { ...BINDING, issueTypeId: "not-an-id" };
    expect(bindJiraIssueTemplateText(PLAIN, wrongIds)).toBeUndefined();
    const broken = PLAIN.replace("activateOn: [create, edit", "activateOn: [nonsense");
    expect(bindJiraIssueTemplateText(broken, BINDING)).toBeUndefined();
  });
});

describe("the one matchers", () => {
  const bound = jiraTemplateForInstance(template(BOUND), INSTANCE);

  it("govern a bound template by id, whatever the type is called", () => {
    expect(jiraTemplateIssueTypeMatches(bound, { id: "10002", name: "Task" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(bound, { id: "10099", name: "Aufgabe" })).toBe(false);
    expect(jiraTemplateParentTypeMatches(bound, { id: "10000", name: "Epic" })).toBe(true);
    expect(jiraTemplateParentTypeMatches(bound, { id: "10099", name: "Epos" })).toBe(false);
    expect(jiraTemplateParentEntryMatches(bound, 0, { id: "10000", name: "Epic" })).toBe(true);
    expect(jiraTemplateParentEntryMatches(bound, 1, { id: "10000", name: "Epic" })).toBe(false);
  });

  it("match a template without a binding by its typed name", () => {
    const legacy = template(PLAIN);
    expect(jiraTemplateIssueTypeMatches(legacy, { id: "10002", name: "aufgabe" })).toBe(true);
    expect(jiraTemplateIssueTypeMatches(legacy, { id: "10002", name: "Task" })).toBe(false);
    expect(jiraTemplateParentEntryMatches(legacy, 0, { id: "10000", name: "EPOS" })).toBe(true);
  });

  it("name the field id a bound template carries, and nothing for a name that did not resolve", () => {
    expect(jiraTemplateBoundFieldId(bound, "Fälligkeitsdatum", "required")).toBe("duedate");
    expect(jiraTemplateBoundFieldId(bound, "priorität", "required")).toBe("priority");
    expect(jiraTemplateBoundFieldId(bound, "Epic Link", "parent")).toBe("customfield_10109");
    expect(jiraTemplateBoundFieldId(bound, "Unknown", "required")).toBeUndefined();
    expect(
      jiraTemplateBoundFieldId(template(PLAIN), "Fälligkeitsdatum", "required"),
    ).toBeUndefined();
    const half = bindingFor(PLAIN, INSTANCE, { ...IDS, requiredFieldIds: ["none", "priority"] });
    const partly = template(bindJiraIssueTemplateText(PLAIN, half) ?? "");
    expect(jiraTemplateBoundFieldId(partly, "Fälligkeitsdatum", "required")).toBeUndefined();
    expect(jiraTemplateBoundFieldId(partly, "Priorität", "required")).toBe("priority");
  });

  it("resolve a parent clause and a required clause of one shared name by their own slots (G1)", () => {
    const shared = PLAIN.replace(
      "requiredFields: [Fälligkeitsdatum, Priorität]",
      "requiredFields: [Parent]",
    ).replace("parentField: Epic Link", "parentField: Parent");
    const ids = { ...IDS, requiredFieldIds: ["customfield_10200"], parentFieldId: "parent" };
    const saved = template(
      bindJiraIssueTemplateText(shared, bindingFor(shared, INSTANCE, ids)) ?? "",
    );
    const roundTripped = jiraTemplateForInstance(
      template(
        bindJiraIssueTemplateText(shared, saved.binding ?? bindingFor(shared, INSTANCE, ids)) ?? "",
      ),
      INSTANCE,
    );
    expect(roundTripped.binding).toBeDefined();
    expect(jiraTemplateBoundFieldId(roundTripped, "Parent", "parent")).toBe("parent");
    expect(jiraTemplateBoundFieldId(roundTripped, "Parent", "required")).toBe("customfield_10200");
    const catalog = [
      { id: "parent", name: "Übergeordnet" },
      { id: "customfield_10200", name: "Parent" },
    ];
    expect(resolveJiraTemplateFieldIds("Parent", catalog, roundTripped, "parent")).toEqual([
      "parent",
    ]);
    expect(resolveJiraTemplateFieldIds("Parent", catalog, roundTripped, "required")).toEqual([
      "customfield_10200",
    ]);
    // A role names only its own slot: the parent field is never a required clause's id.
    expect(jiraTemplateBoundFieldId(bound, "Epic Link", "required")).toBeUndefined();
    expect(jiraTemplateBoundFieldId(bound, "Priorität", "parent")).toBeUndefined();
  });

  it("resolve a field reference by its bound id, else an exact id, else every same-named field", () => {
    const catalog = [
      { id: "duedate", name: "Termin" },
      { id: "priority", name: "Priorität" },
      { id: "customfield_1", name: "Team" },
      { id: "customfield_2", name: "team" },
    ];
    expect(resolveJiraTemplateFieldIds("Fälligkeitsdatum", catalog, bound, "required")).toEqual([
      "duedate",
    ]);
    expect(
      resolveJiraTemplateFieldIds("Fälligkeitsdatum", catalog.slice(1), bound, "required"),
    ).toEqual([]);
    // A field now carrying the old name never takes over the bound field's place (u5K).
    const renamed = [...catalog.slice(1), { id: "customfield_9", name: "Fälligkeitsdatum" }];
    expect(resolveJiraTemplateFieldIds("Fälligkeitsdatum", renamed, bound, "required")).toEqual([]);
    expect(resolveJiraTemplateFieldIds("Fälligkeitsdatum", renamed)).toEqual(["customfield_9"]);
    expect(resolveJiraTemplateFieldIds("Fälligkeitsdatum", catalog)).toEqual([]);
    expect(resolveJiraTemplateFieldIds("customfield_1", catalog)).toEqual(["customfield_1"]);
    expect(resolveJiraTemplateFieldIds(" TEAM ", catalog)).toEqual([
      "customfield_1",
      "customfield_2",
    ]);
  });

  it("name the status id a bound template carries for a transition target, and nothing for a typed id", () => {
    const [byName, byId] = bound.activations.filter((item) => item.kind === "transition");
    if (byName === undefined || byId === undefined) throw new TypeError("Two transition rules");
    expect(jiraTemplateBoundStatusId(bound, byName)).toBe("3");
    expect(jiraTemplateBoundStatusId(bound, byId)).toBeUndefined();
    expect(jiraTemplateBoundStatusId(template(PLAIN), byName)).toBeUndefined();
  });
});

describe("the native id contract (UyI)", () => {
  it("is one lossless int64 rule for offering, saving and binding", () => {
    expect(isJiraNativeId("9007199254740993")).toBe(true);
    expect(isJiraNativeId("12345678901234567")).toBe(true);
    expect(isJiraNativeId("9223372036854775807")).toBe(true);
    for (const wrong of ["9223372036854775808", "0", "01", "", "1e3", "-1", 12, undefined])
      expect(isJiraNativeId(wrong), String(wrong)).toBe(false);
  });

  it("binds and parses an issue type id above the safe integer range", () => {
    const wide = {
      ...IDS,
      issueTypeId: "9223372036854775807",
      parentIssueTypeIds: ["12345678901234567"],
    };
    const written = bindJiraIssueTemplateText(PLAIN, bindingFor(PLAIN, INSTANCE, wide));
    expect(written).toBeDefined();
    expect(template(written ?? "").binding?.issueTypeId).toBe("9223372036854775807");
    expect(
      bindJiraIssueTemplateText(
        PLAIN,
        bindingFor(PLAIN, INSTANCE, { ...IDS, issueTypeId: "9223372036854775808" }),
      ),
    ).toBeUndefined();
  });
});

const PLAIN_FRONT = PLAIN.split("\n").slice(1, PLAIN.split("\n").indexOf("---", 1)).join("\n");

// Ux7, u5a: a guided edit of the rules keeps every untouched reference on the id it was bound to.
describe("a guided edit of a bound template's rules", () => {
  const FIELDS = ["Fälligkeitsdatum", "Priorität"] as const;
  const ACTIVATE = ["create", "edit", "transition:In Arbeit", "transition:21"];
  const governing = (): JiraIssueTemplate => jiraTemplateForInstance(template(BOUND), INSTANCE);
  const rebound = (
    edit: { requiredFields: readonly string[]; activateOn: readonly string[] },
    resolved?: Parameters<typeof rebindJiraTemplateAfterEdit>[3],
  ): JiraTemplateBinding => {
    const binding = rebindJiraTemplateAfterEdit(governing(), INSTANCE, edit, resolved);
    if (binding === undefined) throw new TypeError("Expected a binding");
    return binding;
  };
  const written = (requiredFields: readonly string[], binding: JiraTemplateBinding): string => {
    const front = editJiraTemplateForm(PLAIN_FRONT, { requiredFields }, binding);
    return ["---", front, "---", "# Aufgabe"].join("\n");
  };

  it("keeps the ids of untouched rules and leaves a new one unresolved, confirmed for the same Jira", () => {
    const binding = rebound({ requiredFields: [...FIELDS, "Team"], activateOn: ACTIVATE });
    expect(binding.requiredFieldIds).toEqual(["duedate", "priority", "none"]);
    expect(binding.issueTypeId).toBe("10002");
    expect(binding.parentIssueTypeIds).toEqual(["10000"]);
    expect(binding.parentFieldId).toBe("customfield_10109");
    expect(binding.transitionStatusIds).toEqual(["3", "none"]);
    const edited = jiraTemplateForInstance(
      template(written([...FIELDS, "Team"], binding)),
      INSTANCE,
    );
    expect(edited.binding).toEqual(binding);
    expect(jiraTemplateIssueTypeMatches(edited, { id: "10002", name: "Task" })).toBe(true);
  });

  it("gives a new reference the id this Jira's metadata names, and moves ids with their rules", () => {
    const resolved = { fieldIds: new Map([["team", "customfield_7"]]) };
    const binding = rebound(
      { requiredFields: ["Team", "Priorität"], activateOn: ACTIVATE },
      resolved,
    );
    expect(binding.requiredFieldIds).toEqual(["customfield_7", "priority"]);
    const status = rebound(
      {
        requiredFields: [...FIELDS],
        activateOn: ["create", "transition:21", "transition:In Arbeit", "transition:Neu"],
      },
      { statusIds: new Map([["neu", "7"]]) },
    );
    expect(status.transitionStatusIds).toEqual(["none", "3", "7"]);
  });

  it("never lets an untouched rule follow its old name to another field", () => {
    const binding = rebound({ requiredFields: [...FIELDS, "Team"], activateOn: ACTIVATE });
    const edited = jiraTemplateForInstance(
      template(written([...FIELDS, "Team"], binding)),
      INSTANCE,
    );
    // Jira renamed the bound field; another field now carries the old name.
    const catalog = [
      { id: "duedate", name: "Termin" },
      { id: "customfield_5", name: "Fälligkeitsdatum" },
      { id: "priority", name: "Priorität" },
    ];
    expect(resolveJiraTemplateFieldIds("Fälligkeitsdatum", catalog, edited, "required")).toEqual([
      "duedate",
    ]);
  });

  it("offers no binding where none is in force for this Jira or the edit does not read", () => {
    const none = { requiredFields: [], activateOn: ACTIVATE };
    expect(rebindJiraTemplateAfterEdit(template(BOUND), OTHER, none)).toBeUndefined();
    expect(rebindJiraTemplateAfterEdit(template(PLAIN), INSTANCE, none)).toBeUndefined();
    expect(
      rebindJiraTemplateAfterEdit(governing(), INSTANCE, {
        requiredFields: [],
        activateOn: ["create", "nonsense"],
      }),
    ).toBeUndefined();
  });
});

// PR #4464 review: the rebind and the strict reader must sign the same slots, and positional id
// lists keep equal ids in place instead of dropping the whole binding.
describe("a guided edit with repeated or equivalent entries", () => {
  const governing = (): JiraIssueTemplate => jiraTemplateForInstance(template(BOUND), INSTANCE);

  it("signs one slot for a repeated activation token, as the strict reader does", () => {
    const activateOn = [
      "create",
      "edit",
      "transition:In Arbeit",
      "transition:In Arbeit",
      "transition:21",
    ];
    const binding = rebindJiraTemplateAfterEdit(governing(), INSTANCE, {
      requiredFields: ["Fälligkeitsdatum", "Priorität"],
      activateOn,
    });
    expect(binding?.transitionStatusIds).toEqual(["3", "none"]);
    const front = editJiraTemplateForm(PLAIN_FRONT, { activateOn }, binding);
    const edited = jiraTemplateForInstance(
      template(["---", front, "---", "# Aufgabe"].join("\n")),
      INSTANCE,
    );
    expect(edited.binding).toEqual(binding);
  });

  it("keeps positional ids when distinct labels resolve to the same native id", () => {
    const markdown = PLAIN.replace(
      "activateOn: [create, edit, transition:In Arbeit, transition:21]",
      "activateOn: [create, transition:ready, transition:Ready]",
    );
    const ids: JiraTemplateBindingIds = { ...IDS, transitionStatusIds: ["5", "5"] };
    const written = bindJiraIssueTemplateText(markdown, bindingFor(markdown, INSTANCE, ids));
    expect(template(written ?? "").binding?.transitionStatusIds).toEqual(["5", "5"]);
    expect(jiraTemplateForInstance(template(written ?? ""), INSTANCE).binding).toBeDefined();
    const unresolved = { ...IDS, requiredFieldIds: ["none", "none"] };
    const second = bindJiraIssueTemplateText(PLAIN, bindingFor(PLAIN, INSTANCE, unresolved));
    expect(template(second ?? "").binding?.requiredFieldIds).toEqual(["none", "none"]);
  });
});
