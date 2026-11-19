import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JiraTemplateFieldOption,
  JiraTemplateNamedOption,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import * as contracts from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  JiraIssueTemplate,
  JiraTemplateForm,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JiraTemplateRuleFields } from "./JiraTemplateRuleFields";
import type { JiraOptionsRead } from "./useJiraTemplateOptions";

// Counts how often the shared field resolver scans the catalog (PRRT_kwDOSqilAM65BHd9).
const resolveSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@oscharko-dev/keiko-contracts/runtime/atlassian-connectors", async (importActual) => {
  const actual = await importActual<typeof contracts>();
  return {
    ...actual,
    resolveJiraTemplateFieldIds: (
      ...args: Parameters<typeof actual.resolveJiraTemplateFieldIds>
    ): readonly string[] => {
      resolveSpy.calls += 1;
      return actual.resolveJiraTemplateFieldIds(...args);
    },
  };
});

afterEach(cleanup);

const INSTANCE = "0123456789abcdef0123456789abcdef";

function details(
  options: {
    readonly fields?: readonly JiraTemplateFieldOption[];
    readonly statuses?: readonly JiraTemplateNamedOption[];
    readonly ambiguousFieldNames?: readonly string[];
  },
  retry: () => void = vi.fn(),
): JiraOptionsRead {
  return { state: "ready", options: { kind: "details", ...options }, retry };
}

function formOf(over: Partial<JiraTemplateForm> = {}): JiraTemplateForm {
  return {
    project: "SYN",
    issueType: "Aufgabe",
    activateOn: ["create"],
    requiredFields: [],
    ...over,
  };
}

function plain(form: JiraTemplateForm): string {
  const list = (items: readonly string[]): string => `[${items.join(", ")}]`;
  return [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    `project: ${form.project}`,
    `issueType: ${form.issueType}`,
    `activateOn: ${list(form.activateOn)}`,
    ...(form.requiredFields.length === 0 ? [] : [`requiredFields: ${list(form.requiredFields)}`]),
    "---",
    "# Aufgabe",
    "",
    "## Kontext",
  ].join("\n");
}

function parsed(markdown: string): JiraIssueTemplate {
  const result = contracts.parseJiraIssueTemplate(markdown);
  if (!result.ok) throw new TypeError("Expected a parseable template");
  return result.template;
}

/** A template bound to INSTANCE with the digest its producer computes. */
function bound(form: JiraTemplateForm, ids: contracts.JiraTemplateBindingIds): JiraIssueTemplate {
  const base = parsed(plain(form));
  const binding = {
    digest: contracts.jiraTemplateBindingDigest(INSTANCE, base, ids),
    ...ids,
  };
  const text = contracts.bindJiraIssueTemplateText(plain(form), binding) ?? "";
  return contracts.jiraTemplateForInstance(parsed(text), INSTANCE);
}

function optionValues(select: HTMLElement): readonly string[] {
  return Array.from(select.querySelectorAll("option"), (option) => option.value);
}

function renderRules(props: {
  readonly form: JiraTemplateForm;
  readonly template: JiraIssueTemplate | undefined;
  readonly details: JiraOptionsRead;
}): ReturnType<typeof render> {
  return render(<JiraTemplateRuleFields {...props} onChange={vi.fn()} />);
}

describe("status choices", () => {
  it("does not offer a status the bound id of a saved activation already names (PRRT_kwDOSqilAM65BHds)", () => {
    const form = formOf({ activateOn: ["create", "transition:Erledigt"] });
    const template = bound(form, { issueTypeId: "10002", transitionStatusIds: ["3"] });
    expect(template.binding).toBeDefined();
    renderRules({
      form,
      template,
      details: details({
        fields: [],
        statuses: [
          { id: "3", name: "Done" },
          { id: "4", name: "Open" },
        ],
      }),
    });
    const select = screen.getByRole("combobox", { name: /status/i });
    expect(optionValues(select)).toContain("transition:Open");
    expect(optionValues(select)).not.toContain("transition:Done");
  });

  it("finds the bound id of a saved activation whose quoted target has surrounding blanks (PR #4464)", () => {
    const form = formOf({ activateOn: ["create", "transition: Erledigt "] });
    const template = bound(form, { issueTypeId: "10002", transitionStatusIds: ["3"] });
    expect(template.binding).toBeDefined();
    renderRules({
      form,
      template,
      details: details({
        fields: [],
        statuses: [
          { id: "3", name: "Done" },
          { id: "4", name: "Open" },
        ],
      }),
    });
    const select = screen.getByRole("combobox", { name: /status/i });
    expect(optionValues(select)).toContain("transition:Open");
    expect(optionValues(select)).not.toContain("transition:Done");
  });

  it("still offers a differently named status when nothing binds the saved one", () => {
    const form = formOf({ activateOn: ["create", "transition:Erledigt"] });
    renderRules({
      form,
      template: parsed(plain(form)),
      details: details({ fields: [], statuses: [{ id: "3", name: "Done" }] }),
    });
    const select = screen.getByRole("combobox", { name: /status/i });
    expect(optionValues(select)).toContain("transition:Done");
  });

  it("does not offer a status whose name is blank once trimmed (PRRT_kwDOSqilAM65BHeJ)", () => {
    renderRules({
      form: formOf(),
      template: undefined,
      details: details({
        fields: [],
        statuses: [
          { id: "5", name: "   " },
          { id: "6", name: "Done" },
        ],
      }),
    });
    const select = screen.getByRole("combobox", { name: /status/i });
    expect(optionValues(select)).toContain("transition:Done");
    expect(optionValues(select).filter((value) => value.startsWith("transition:"))).toEqual([
      "transition:Done",
    ]);
  });
});

describe("partial details", () => {
  const fields: readonly JiraTemplateFieldOption[] = [
    { id: "customfield_1", name: "Team", required: false },
  ];

  it("offers Retry when only the global field catalog failed on an unbound template (PRRT_kwDOSqilAM65BHdx)", async () => {
    const retry = vi.fn();
    renderRules({
      form: formOf(),
      template: undefined,
      details: details({ fields, statuses: [] }, retry),
    });
    await userEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry when the catalog was read, or when a bound template does not need it", () => {
    renderRules({
      form: formOf(),
      template: undefined,
      details: details({ fields, statuses: [], ambiguousFieldNames: [] }),
    });
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
    cleanup();
    const form = formOf();
    renderRules({
      form,
      template: bound(form, { issueTypeId: "10002" }),
      details: details({ fields, statuses: [] }),
    });
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
  });
});

describe("a written field reference that Jira renamed (PR #4464)", () => {
  it("does not offer another field whose name equals the written reference after case folding", () => {
    const form = formOf({ requiredFields: ["Team"] });
    const template = bound(form, { issueTypeId: "10002", requiredFieldIds: ["customfield_1"] });
    expect(template.binding).toBeDefined();
    renderRules({
      form,
      template,
      details: details({
        fields: [
          { id: "customfield_2", name: "team", required: false },
          { id: "customfield_3", name: "Sprint", required: false },
        ],
        statuses: [],
        ambiguousFieldNames: [],
      }),
    });
    const select = screen.getByRole("combobox", { name: /required field/i });
    const labels = Array.from(
      select.querySelectorAll("option"),
      (option) => option.textContent ?? "",
    );
    expect(labels.some((label) => /^team$/iu.test(label.trim()))).toBe(false);
    expect(labels.some((label) => label.includes("Sprint"))).toBe(true);
  });
});

describe("one name used by the parent clause and a required clause (G1)", () => {
  const catalog = details({
    fields: [
      { id: "parent", name: "Übergeordnet", required: false },
      { id: "customfield_10200", name: "Parent", required: false },
    ],
    statuses: [],
    ambiguousFieldNames: [],
  });
  const front = (requiredFields: readonly string[]): string =>
    plain(formOf({ requiredFields })).replace(
      "---\n# Aufgabe",
      "parentField: Parent\nparentIssueTypes: [Epos]\n---\n# Aufgabe",
    );
  const savedWith = (
    requiredFields: readonly string[],
    ids: contracts.JiraTemplateBindingIds,
  ): JiraIssueTemplate => {
    const text = front(requiredFields);
    const binding = {
      digest: contracts.jiraTemplateBindingDigest(INSTANCE, parsed(text), ids),
      ...ids,
    };
    const bound = contracts.bindJiraIssueTemplateText(text, binding) ?? "";
    return contracts.jiraTemplateForInstance(parsed(bound), INSTANCE);
  };
  const parentOnly = {
    issueTypeId: "10002",
    parentIssueTypeIds: ["10000"],
    parentFieldId: "parent",
  };

  it("shows the custom field a pick names, not the system parent the parent clause is bound to", () => {
    const template = savedWith([], parentOnly);
    expect(template.binding).toBeDefined();
    renderRules({ form: formOf({ requiredFields: ["Parent"] }), template, details: catalog });
    const chips = screen.queryAllByText(/Übergeordnet/u).filter((el) => el.tagName !== "OPTION");
    expect(chips).toEqual([]);
    expect(screen.queryAllByText("Parent").filter((el) => el.tagName !== "OPTION")).not.toEqual([]);
  });

  it("saves only a combination that reads back by role: the pick, the rebind and the lookup agree", async () => {
    const template = savedWith([], parentOnly);
    const onChange = vi.fn();
    render(
      <JiraTemplateRuleFields
        form={formOf()}
        template={template}
        details={catalog}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /required field/i }),
      "Parent",
    );
    const [patch, resolved] = onChange.mock.calls[0] as [
      Partial<JiraTemplateForm>,
      contracts.JiraTemplateEditedIds,
    ];
    expect(patch.requiredFields).toEqual(["Parent"]);
    const binding = contracts.rebindJiraTemplateAfterEdit(
      template,
      INSTANCE,
      { requiredFields: ["Parent"], activateOn: ["create"] },
      resolved,
    );
    expect(binding?.requiredFieldIds).toEqual(["customfield_10200"]);
    expect(binding?.parentFieldId).toBe("parent");
    const saved = savedWith(["Parent"], {
      ...parentOnly,
      requiredFieldIds: ["customfield_10200"],
    });
    expect(contracts.jiraTemplateBoundFieldId(saved, "Parent", "parent")).toBe("parent");
    expect(contracts.jiraTemplateBoundFieldId(saved, "Parent", "required")).toBe(
      "customfield_10200",
    );
  });
});

describe("a large field catalog", () => {
  const catalog: readonly JiraTemplateFieldOption[] = Array.from({ length: 500 }, (_, index) => ({
    id: `customfield_${String(index + 1)}`,
    name: `Field ${String(index + 1)}`,
    required: false,
  }));
  const written = catalog.slice(0, 49).map((field) => field.name);

  function pass(
    form: JiraTemplateForm,
    read: JiraOptionsRead,
  ): { readonly calls: number; readonly offered: number } {
    resolveSpy.calls = 0;
    cleanup();
    renderRules({ form, template: parsed(plain(form)), details: read });
    const select = screen.getByRole("combobox", { name: /required field/i });
    return { calls: resolveSpy.calls, offered: select.querySelectorAll("option").length - 1 };
  }

  it("resolves the catalog once per written field, not once per offered/written pair (PRRT_kwDOSqilAM65BHd9)", () => {
    const form = formOf({ requiredFields: written });
    const read = details({ fields: catalog, statuses: [], ambiguousFieldNames: [] });
    const first = pass(form, read);
    expect(first.offered).toBe(451);
    // A body edit re-renders with the same metadata and field list: the unwritten fields are reused.
    const again = pass(form, read);
    expect(again.offered).toBe(451);
    // Per written value the list shows a label, so the bound is a small multiple of the written
    // count; the pairwise filter resolved both sides of 451 x 49 pairs.
    expect(again.calls).toBeLessThanOrEqual(written.length * 8);
    expect(first.calls).toBeLessThan(451 * written.length);
  });
});
