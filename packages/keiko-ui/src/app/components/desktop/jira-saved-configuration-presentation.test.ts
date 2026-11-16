import { describe, expect, it } from "vitest";
import type { OptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraActionFacts } from "./jiraActionFacts";
import {
  jiraSavedConfigurationDetails as details,
  jiraSavedConfigurationIdentityComplete as complete,
} from "./jira-saved-configuration-presentation";
import {
  jiraSavedConfigurationContextFacts,
  jiraSavedConfigurationFacts,
} from "./jira-saved-configuration-approval";
import { jiraAgileDetails } from "./jira-agile-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";

const t: OptionalWidgetTranslate = (key, values) =>
  `${key}${values?.value === undefined ? "" : `:${String(values.value)}`}`;
function filterLink(name: string, data: CatalogJsonObject): string | undefined {
  return jiraToolOutcomeView({
    call: { id: "filter-link", name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "filter-link",
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  }).items[0]?.filterHref;
}
describe("saved server-minted filter destinations", () => {
  it("preserves a bound context path and an exact int64 filter ID even when confirmation is pending", () => {
    const browseUrl = "https://jira.example.invalid/context/issues/?filter=9223372036854775807";
    expect(
      filterLink("jira_create_filter", {
        outcome: "unknown",
        filterId: "9223372036854775807",
        userKey: "owner",
        browseUrl,
      }),
    ).toBe(browseUrl);
  });
  it.each([
    "https://jira.example.invalid/context/issues/?filter=10",
    "https://jira.example.invalid/context/issues/?filter=9&filter=9",
    "https://jira.example.invalid/context/issues/?filter=9&jql=other",
    "https://jira.example.invalid/context/issues/?filter=%39",
    "https://jira.example.invalid/context/issues/?%66ilter=9",
    "https://jira.example.invalid/context%2fother/issues/?filter=9",
    "https://jira.example.invalid/context%5cother/issues/?filter=9",
    "https://jira.example.invalid/context%252fother/issues/?filter=9",
    "https://jira.example.invalid/context\\other/issues/?filter=9",
    "https://jira.example.invalid/context/\tissues/?filter=9",
    "https://jira.example.invalid/context/issue/?filter=9",
    "https://jira.example.invalid/context/issues?filter=9",
    "https://jira.example.invalid/context/browse/SYN-9?filter=9",
    "https://user:password@jira.example.invalid/context/issues/?filter=9",
    "https://jira.example.invalid/context/issues/?filter=9#other",
    "http://jira.example.invalid/context/issues/?filter=9",
    "javascript:alert(1)",
  ])("refuses a mismatched or unsafe saved destination %s", (browseUrl) => {
    expect(
      filterLink("jira_update_filter", {
        outcome: "succeeded",
        filterId: "9",
        userKey: "owner",
        browseUrl,
      }),
    ).toBeUndefined();
  });
  it("requires its own known filter identity and never links preferences or default sharing", () => {
    const browseUrl = "https://jira.example.invalid/context/issues/?filter=9";
    const contexts: readonly CatalogJsonObject[] = [
      { userKey: "owner" },
      { filterId: "9" },
      { filterId: 9, userKey: "owner" },
    ];
    for (const data of contexts)
      expect(filterLink("jira_update_filter", { ...data, browseUrl })).toBeUndefined();
    for (const name of [
      "jira_set_my_preference",
      "jira_delete_my_preference",
      "jira_set_filter_share_scope",
    ])
      expect(
        filterLink(name, { filterId: "9", userKey: "owner", username: "person", browseUrl }),
      ).toBeUndefined();
  });
});
describe("saved Jira configuration mutation presentation", () => {
  it("requires a native new filter identity and observed sharing before confirming creation", () => {
    const result = {
      outcome: "succeeded",
      userKey: "owner",
      defaultSharingAtomic: false,
      observedShareScope: "PRIVATE",
    };
    expect(complete("jira_create_filter", result)).toBe(false);
    expect(details("jira_create_filter", result)[0]?.labels).toContain(
      "chat.jira.savedConfiguration.identityUnknown",
    );
    expect(
      details("jira_create_filter", { ...result, filterId: "9223372036854775807" })[0]?.labels,
    ).toEqual(
      expect.arrayContaining([
        "chat.jira.savedConfiguration.confirmed",
        "chat.jira.savedConfiguration.nonAtomicCreate",
        "chat.jira.savedConfiguration.private",
      ]),
    );
    expect(
      complete("jira_create_filter", { ...result, filterId: "9", defaultSharingAtomic: true }),
    ).toBe(false);
    expect(
      complete("jira_create_filter", {
        filterId: "9",
        userKey: "owner",
        defaultSharingAtomic: false,
      }),
    ).toBe(false);
  });
  it("keeps known targets through uncertainty and never confirms unsupported deletion absence", () => {
    expect(
      details("jira_delete_filter", { outcome: "succeeded", filterId: "9", userKey: "owner" })[0]
        ?.labels,
    ).toContain("chat.jira.savedConfiguration.deletionUnconfirmed");
    const preference = details("jira_delete_my_preference", {
      outcome: "unknown",
      userKey: "owner",
      username: "person",
      preferenceKey: "jira.user.locale",
      preferencePresent: false,
    })[0];
    expect(preference?.labels).toEqual(
      expect.arrayContaining([
        "chat.jira.savedConfiguration.deletionUnconfirmed",
        "chat.jira.savedConfiguration.targetAbsent",
      ]),
    );
    expect(preference?.facts).toContainEqual({
      label: "chat.jira.settings.key",
      value: "jira.user.locale",
    });
    expect(
      details("jira_add_filter_permission", {
        outcome: "unknown",
        filterId: "9",
        permissionId: "12",
        userKey: "owner",
      })[0]?.labels,
    ).toContain("chat.jira.savedConfiguration.unconfirmed");
    expect(complete("jira_add_filter_permission", { filterId: "9", userKey: "owner" })).toBe(false);
  });
  it("preserves confirmed no-op and independently observed default sharing without inferring rights", () => {
    const noop = details("jira_set_filter_share_scope", {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      userKey: "owner",
      username: "person",
      observedShareScope: "AUTHENTICATED",
    })[0];
    expect(noop?.labels).toEqual(
      expect.arrayContaining([
        "chat.jira.savedConfiguration.unchanged",
        "chat.jira.savedConfiguration.authenticated",
        "chat.jira.savedConfiguration.futureDefaults",
      ]),
    );
    expect(details("jira_issue", { outcome: "succeeded" })).toEqual([]);
  });
  it("does not accept inherited or missing mandatory identity context", () => {
    const inherited = Object.assign(Object.create({ filterId: "9" }) as Record<string, unknown>, {
      userKey: "owner",
    });
    expect(complete("jira_update_filter", inherited)).toBe(false);
    expect(
      complete("jira_set_my_preference", {
        userKey: "owner",
        preferenceKey: "jira.user.locale",
        preferencePresent: true,
      }),
    ).toBe(false);
  });
  it("keeps absent and explicitly empty native filter descriptions distinct", () => {
    const source = {
      id: "9",
      name: "Reviewed filter",
      jql: "project = SYN",
      owner: { key: "owner", name: "person", displayName: "Shown owner" },
    };
    expect(jiraAgileDetails("jira_filter", { ...source, description: null }).labels).toContain(
      "chat.jira.savedConfiguration.descriptionNotProvided",
    );
    expect(jiraAgileDetails("jira_filter", { ...source, description: "" }).labels).toContain(
      "chat.jira.savedConfiguration.descriptionEmpty",
    );
    expect(jiraAgileDetails("jira_filter", source).facts).toContainEqual({
      label: "chat.jira.savedConfiguration.ownerKey",
      value: "owner",
    });
  });
});
describe("complete readable saved configuration approvals", () => {
  it("preserves typed false, zero and empty text rather than turning them into absence", () => {
    for (const [value, expected] of [
      [false, "chat.jira.propertyMutation.false"],
      [0, "chat.jira.savedConfiguration.integerValue:0"],
      ["", "chat.jira.propertyMutation.emptyText"],
    ] as const) {
      expect(
        jiraSavedConfigurationFacts("jira.set-my-preference", "value", value, t)?.[0]?.value,
      ).toEqual({ kind: "text", text: expected });
    }
    expect(
      jiraSavedConfigurationFacts("jira.set-my-preference", "value", "0", t)?.[0]?.value,
    ).toEqual({ kind: "text", text: "0" });
  });
  it("keeps ordered duplicate columns and unknown native provenance visible", () => {
    const rows = jiraActionFacts(
      {
        filterId: "9",
        expectedOwnerKey: "owner",
        expectedColumns: ["summary", "status", "summary"],
        expectedColumnConfig: null,
        columns: ["status", "summary"],
      },
      true,
      t,
      undefined,
      "jira.set-filter-columns",
    );
    expect(
      rows.find((row) => row.id === "chat.jira.savedConfiguration.reviewedColumns")?.value,
    ).toEqual({
      kind: "list",
      items: [
        { position: 1, value: { kind: "text", text: "summary" } },
        { position: 2, value: { kind: "text", text: "status" } },
        { position: 3, value: { kind: "text", text: "summary" } },
      ],
    });
    expect(
      rows.find((row) => row.id === "chat.jira.savedConfiguration.reviewedColumnConfig")?.value,
    ).toEqual({ kind: "text", text: "chat.jira.savedConfiguration.provenanceNotProvided" });
  });
  it("shows every reviewed permission and separates unknown rights from explicit denial", () => {
    const rows = jiraSavedConfigurationFacts(
      "jira.add-filter-permission",
      "expectedPermissions",
      [
        { id: "12", type: "group", groupName: "reviewed-group", view: true, edit: false },
        { id: "13", type: "user", userName: "reviewed-user" },
      ],
      t,
    )?.[0]?.value;
    expect(rows?.kind).toBe("list");
    if (rows?.kind !== "list") throw new TypeError("Expected complete permission list");
    expect(rows.items).toHaveLength(2);
    const [first, second] = rows.items.map(
      (item): Extract<typeof item.value, { kind: "group" }> => {
        if (item.value.kind !== "group") throw new TypeError("Expected named permission facts");
        return item.value;
      },
    );
    if (first === undefined || second === undefined)
      throw new TypeError("Expected both permission facts");
    expect(first.members).toContainEqual({
      name: "chat.jira.fact.groupName",
      value: { kind: "text", text: "reviewed-group" },
    });
    expect(
      first.members.find((member) => member.name === "chat.jira.savedConfiguration.sharingRights")
        ?.value,
    ).toEqual({
      kind: "text",
      text: "chat.jira.savedView.permissionHelp · chat.jira.savedView.viewGranted · chat.jira.savedView.editNotGranted",
    });
    expect(
      second.members.find((member) => member.name === "chat.jira.savedConfiguration.sharingRights")
        ?.value,
    ).toEqual({
      kind: "text",
      text: "chat.jira.savedView.permissionHelp · chat.jira.savedConfiguration.viewUnknown · chat.jira.savedConfiguration.editUnknown",
    });
  });
  it("discloses non-atomic creation and replacement of existing global shares in the approval itself", () => {
    expect(jiraSavedConfigurationContextFacts("jira.create-filter", {}, t)[0]?.value).toEqual({
      kind: "text",
      text: "chat.jira.savedConfiguration.nonAtomicCreate",
    });
    expect(
      jiraSavedConfigurationContextFacts(
        "jira.add-filter-permission",
        { permission: { type: "global" } },
        t,
      )[0]?.value,
    ).toEqual({ kind: "text", text: "chat.jira.savedConfiguration.globalReplacement" });
    expect(jiraSavedConfigurationFacts("mcp_other", "expectedValue", false, t)).toBeUndefined();
  });
});
