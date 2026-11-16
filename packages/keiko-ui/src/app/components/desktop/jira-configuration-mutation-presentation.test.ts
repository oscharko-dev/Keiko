import { describe, expect, it } from "vitest";
import type { OptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { jiraActionFacts } from "./jiraActionFacts";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { jiraMutationUnchanged, jiraToolState } from "./jira-tool-presentation";
import {
  jiraConfigurationMutationDetails,
  jiraConfigurationMutationIdentityComplete,
  jiraConfigurationConfirmationUnavailable,
} from "./jira-configuration-mutation-presentation";
import {
  CONFIGURATION_CASES,
  CONFIGURATION_FIELDS,
  CONFIGURATION_SPRINT,
  configurationExchange,
} from "./jira-configuration-mutation.test-fixture";
import { jiraSprintLifecycleIdentityComplete } from "./jira-sprint-lifecycle-presentation";
import { jiraSprintReviewDetails } from "./jira-sprint-review-presentation";

const t: OptionalWidgetTranslate = (key) => key;
describe("bound screen and board mutation presentation", () => {
  it.each(CONFIGURATION_CASES)(
    "requires the exact receipt context for $operation",
    ({ operation, receipt }) => {
      const tool = operation.replace(/[.-]/gu, "_");
      expect(jiraConfigurationMutationIdentityComplete(tool, receipt)).toBe(true);
      const state = jiraToolState(configurationExchange(tool, receipt), "completed");
      expect(state).toBe(
        jiraConfigurationConfirmationUnavailable(tool)
          ? "chat.jira.write.unconfirmed"
          : "chat.jira.write.succeeded",
      );
      expect(jiraConfigurationMutationDetails(tool, receipt)[0]?.facts.length).toBeGreaterThan(0);
    },
  );
  it.each(CONFIGURATION_CASES)(
    "does not promote journal uncertainty for $operation",
    ({ operation, receipt }) => {
      const tool = operation.replace(/[.-]/gu, "_");
      const exchange = configurationExchange(
        tool,
        { ...receipt, outcome: "succeeded", browseUrl: "https://untrusted.invalid/" },
        0,
        "unknown",
      );
      expect(jiraToolState(exchange, "completed")).toBe("chat.jira.write.unknown");
      const view = jiraToolOutcomeView(exchange);
      expect(view.items[0]?.labels).not.toContain("chat.jira.savedConfiguration.confirmed");
      expect(view.items[0]?.labels).not.toContain("chat.jira.configuration.observedBoolean");
      expect(view.items[0]?.href).toBeUndefined();
      expect(view.items[0]?.boardHref).toBeUndefined();
    },
  );
  it("never invents the default parent, or confirms default addition or board deletion", () => {
    const source = { fieldId: "summary", fieldPresent: true, outcome: "succeeded" };
    const details = jiraConfigurationMutationDetails("jira_add_default_screen_field", {
      ...source,
      screenId: "7",
      tabId: "8",
    });
    expect(details[0]?.facts).toEqual([
      { label: "chat.jira.configuration.fieldId", value: "summary" },
    ]);
    expect(details[0]?.labels).toContain("chat.jira.savedConfiguration.identityUnknown");
    expect(
      jiraToolState(configurationExchange("jira_add_default_screen_field", source), "completed"),
    ).toBe("chat.jira.write.unconfirmed");
    const board = {
      boardId: "7",
      filterId: "42",
      userKey: "actor-key",
      boardPresent: false,
      outcome: "succeeded",
    };
    expect(jiraToolState(configurationExchange("jira_delete_board", board), "completed")).toBe(
      "chat.jira.write.unconfirmed",
    );
  });
  it("requires board, filter, actor and an observed Boolean before showing a confirmed setting", () => {
    const source = {
      boardId: "7",
      filterId: "42",
      userKey: "actor-key",
      refinedVelocityEnabled: false,
      outcome: "succeeded",
    };
    for (const key of ["boardId", "filterId", "userKey", "refinedVelocityEnabled"]) {
      const incomplete: Record<string, unknown> = { ...source };
      delete incomplete[key];
      expect(
        jiraConfigurationMutationIdentityComplete("jira_set_board_refined_velocity", incomplete),
      ).toBe(false);
    }
    expect(
      jiraConfigurationMutationIdentityComplete("jira_set_board_refined_velocity", {
        ...source,
        boardId: "9007199254740993",
      }),
    ).toBe(false);
    expect(
      jiraConfigurationMutationDetails("jira_set_board_refined_velocity", source)[0]?.labels,
    ).toContain("chat.jira.configuration.observedBoolean");
    expect(
      jiraConfigurationMutationDetails("jira_set_board_refined_velocity", {
        ...source,
        outcome: "succeeded-unconfirmed",
      })[0]?.labels,
    ).toContain("chat.jira.configuration.requestedBoolean");
  });
  it("keeps a complete explicit no-op separate from an uncertain default operation", () => {
    const receipt = {
      screenId: "7",
      tabId: "11",
      fieldId: "summary",
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
    };
    expect(
      jiraMutationUnchanged(configurationExchange("jira_move_screen_tab_field", receipt)),
    ).toBe(true);
    expect(
      jiraMutationUnchanged(
        configurationExchange("jira_add_default_screen_field", {
          fieldId: "summary",
          fieldPresent: true,
          outcome: "rejected",
          reason: "conflict",
          unchanged: true,
        }),
      ),
    ).toBe(false);
  });
});
describe("complete configuration approval values", () => {
  it("keeps every ordered field, null and false without turning null into a clearing request", () => {
    const facts = jiraActionFacts(
      { expectedFields: CONFIGURATION_FIELDS },
      true,
      t,
      undefined,
      "jira.set-screen-field-show-when-empty",
    );
    expect(JSON.stringify(facts)).toContain("chat.jira.structural.nativeNotProvided");
    expect(JSON.stringify(facts)).toContain("chat.jira.propertyMutation.false");
    expect(JSON.stringify(facts)).not.toContain('"kind":"cleared"');
    expect(facts[0]?.value).toMatchObject({
      kind: "list",
      items: [
        {
          position: 1,
          value: {
            kind: "group",
            members: expect.arrayContaining([
              { name: "chat.jira.configuration.fieldId", value: { kind: "text", text: "summary" } },
            ]),
          },
        },
        {
          position: 2,
          value: {
            kind: "group",
            members: expect.arrayContaining([
              {
                name: "chat.jira.configuration.fieldId",
                value: { kind: "text", text: "customfield_10100" },
              },
            ]),
          },
        },
      ],
    });
  });
  it("retains zero-based tab position and all four native relative field positions", () => {
    const tab = jiraActionFacts({ position: 0 }, true, t, undefined, "jira.move-screen-tab");
    expect(tab[0]).toEqual({
      id: "chat.jira.configuration.zeroBasedPosition",
      value: { kind: "text", text: "0" },
    });
    for (const position of ["First", "Last", "Earlier", "Later"])
      expect(
        jiraActionFacts({ position }, true, t, undefined, "jira.move-screen-tab-field")[0]?.value,
      ).toEqual({ kind: "text", text: `chat.jira.structural.${position.toLowerCase()}` });
  });
});

describe("sprint lifecycle scope and native snapshot facts", () => {
  it("does not turn a reviewed sample into a complete all-sprint result", () => {
    const receipt = {
      userKey: "actor-key",
      sprintIds: ["51", "52"],
      sprintSynced: false,
      allSprints: true,
      outcome: "succeeded",
    };
    expect(jiraSprintLifecycleIdentityComplete("jira_unmap_all_sprints", receipt)).toBe(true);
    const exchange = configurationExchange("jira_unmap_all_sprints", receipt);
    expect(jiraToolState(exchange, "completed")).toBe("chat.jira.write.unconfirmed");
    const view = jiraToolOutcomeView(exchange);
    expect(view.total).toBeUndefined();
    expect(view.items[0]?.facts).toContainEqual({
      label: "chat.jira.sprintLifecycle.sampleIds",
      value: "51, 52",
    });
    expect(view.items[0]?.labels).toContain("chat.jira.sprintLifecycle.instanceWide");
    expect(jiraSprintLifecycleIdentityComplete("jira_unmap_sprints", receipt)).toBe(false);
    expect(
      jiraSprintLifecycleIdentityComplete("jira_unmap_all_sprints", {
        ...receipt,
        sprintIds: ["51", "51"],
      }),
    ).toBe(false);
    expect(
      jiraSprintLifecycleIdentityComplete("jira_unmap_all_sprints", {
        ...receipt,
        sprintSynced: true,
      }),
    ).toBe(false);
  });
  it("preserves omitted versus null and false snapshot values after a native sprint read", () => {
    const items = [{ ...CONFIGURATION_SPRINT, reviewSnapshot: CONFIGURATION_SPRINT }];
    const details = jiraSprintReviewDetails("jira_sprint", { items });
    const labels = details.flatMap((item) => item.labels);
    expect(labels).toContain("chat.jira.sprintLifecycle.snapshotAvailable");
    expect(labels).toContain("chat.jira.sprintLifecycle.metadataOmitted");
    expect(labels).toContain("chat.jira.structural.nativeNotProvided");
    expect(labels).toContain("chat.jira.propertyMutation.false");
    expect(labels).toContain("chat.jira.propertyMutation.emptyText");
    expect(details.flatMap((item) => item.facts)).toContainEqual({
      label: "chat.jira.sprintLifecycle.originBoard",
      value: "7",
    });
    expect(
      jiraToolOutcomeView(configurationExchange("jira_sprint", { outcome: "succeeded", items }))
        .unreadableCount,
    ).toBe(0);
  });
  it.each([
    undefined,
    { ...CONFIGURATION_SPRINT, id: "52" },
    { ...CONFIGURATION_SPRINT, originBoardId: "8" },
    { ...CONFIGURATION_SPRINT, synced: null },
    { ...CONFIGURATION_SPRINT, self: "https://untrusted.invalid/sprint/51" },
  ])(
    "keeps ordinary sprint facts readable when a review snapshot is missing or contradictory",
    (reviewSnapshot) => {
      const details = jiraSprintReviewDetails("jira_sprint", {
        items: [{ ...CONFIGURATION_SPRINT, reviewSnapshot }],
      });
      expect(details.flatMap((item) => item.labels)).toContain(
        "chat.jira.sprintLifecycle.snapshotUnavailable",
      );
      expect(details.flatMap((item) => item.labels)).not.toContain(
        "chat.jira.sprintLifecycle.snapshotAvailable",
      );
      expect(details[0]?.name).toBe("Reviewed sprint");
      expect(JSON.stringify(details)).not.toContain("untrusted.invalid");
    },
  );
});
