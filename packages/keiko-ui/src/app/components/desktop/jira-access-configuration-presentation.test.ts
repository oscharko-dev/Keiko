import { describe, expect, it } from "vitest";
import {
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  JIRA_ROLE_MUTATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraAccessConfigurationIdentityComplete,
  jiraAccessConfigurationDetails,
} from "./jira-access-configuration-presentation";
import { jiraToolState } from "./jira-tool-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { configurationExchange as exchange } from "./jira-configuration-mutation.test-fixture";
import {
  ACCESS_CONFIGURATION_CASES,
  accessConfigurationCase,
} from "./jira-access-configuration.test-fixture";

describe("permission scheme and role receipt presentation", () => {
  it("covers each canonical operation with an independent receipt and argument fixture", () => {
    expect(ACCESS_CONFIGURATION_CASES.map(({ operation }) => operation).sort()).toEqual(
      [...JIRA_PERMISSION_SCHEME_MUTATIONS, ...JIRA_ROLE_MUTATIONS].sort(),
    );
  });
  it.each(ACCESS_CONFIGURATION_CASES)(
    "requires bound identity before reporting $operation",
    ({ operation, receipt, unconfirmable }) => {
      const tool = operation.replace(/[.-]/gu, "_");
      expect(jiraAccessConfigurationIdentityComplete(tool, receipt)).toBe(true);
      const missing = Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== "userKey"),
      );
      expect(jiraToolState(exchange(tool, { ...missing, outcome: "succeeded" }), "completed")).toBe(
        "chat.jira.write.unknown",
      );
      expect(jiraToolState(exchange(tool, { ...receipt, outcome: "succeeded" }), "completed")).toBe(
        unconfirmable ? "chat.jira.write.unconfirmed" : "chat.jira.write.succeeded",
      );
      const view = jiraToolOutcomeView(exchange(tool, receipt));
      expect(view.items.flatMap((item) => item.labels)).toContain(
        "chat.jira.access.configurationOnly",
      );
    },
  );
  it.each([
    ["jira.create-role", "roleId"],
    ["jira.create-permission-scheme", "schemeId"],
    ["jira.add-permission-grant", "permissionId"],
  ] as const)("keeps a missing acknowledged ID missing for %s", (operation, key) => {
    const fixture = accessConfigurationCase(operation);
    const receipt = Object.fromEntries(
      Object.entries(fixture.receipt).filter(([name]) => name !== key),
    );
    const tool = operation.replace(/[.-]/gu, "_");
    const value = exchange(tool, {
      ...receipt,
      outcome: "succeeded",
      name: "Must not become an ID",
    });
    expect(jiraToolState(value, "completed")).toBe("chat.jira.write.unknown");
    expect(jiraToolOutcomeView(value).items.flatMap((item) => item.labels)).toContain(
      "chat.jira.savedConfiguration.identityUnknown",
    );
  });
  it.each([
    { roleActorsScope: "role-defaults" },
    { actorChange: "add" },
    { actorUserKeys: undefined },
    { actorGroupNames: undefined },
    { actorUserKeys: ["same", "same"] },
    { actorGroupNames: ["group\u0000"] },
    { roleId: "9007199254740993" },
    { projectId: undefined },
    { projectKey: "invalid key" },
  ])("refuses incomplete or contradictory project replacement context %j", (change) => {
    const { receipt } = accessConfigurationCase("jira.set-project-role-actors");
    expect(
      jiraAccessConfigurationIdentityComplete("jira_set_project_role_actors", {
        ...receipt,
        ...change,
      }),
    ).toBe(false);
  });
  it("preserves known empty replacement targets and never invents missing target counts", () => {
    const { receipt } = accessConfigurationCase("jira.set-project-role-actors");
    const [known] = jiraAccessConfigurationDetails("jira_set_project_role_actors", receipt);
    expect(known?.facts).toContainEqual({ label: "chat.jira.accessWrite.userCount", value: "0" });
    expect(known?.facts).toContainEqual({ label: "chat.jira.accessWrite.groupCount", value: "0" });
    const [unknown] = jiraAccessConfigurationDetails("jira_set_project_role_actors", {
      ...receipt,
      actorUserKeys: undefined,
      actorGroupNames: undefined,
    });
    expect(
      unknown?.facts.some(
        ({ label }) =>
          label === "chat.jira.accessWrite.userCount" ||
          label === "chat.jira.accessWrite.groupCount",
      ),
    ).toBe(false);
    expect(unknown?.labels).toContain("chat.jira.savedConfiguration.identityUnknown");
  });
  it("accepts equal user and group spellings in separate replacement namespaces", () => {
    const { receipt } = accessConfigurationCase("jira.set-project-role-actors");
    expect(
      jiraAccessConfigurationIdentityComplete("jira_set_project_role_actors", {
        ...receipt,
        actorUserKeys: ["same"],
        actorGroupNames: ["same"],
      }),
    ).toBe(true);
  });
  it.each([
    { actorUserKeys: [], actorGroupNames: [] },
    { actorUserKeys: ["user"], actorGroupNames: ["group"] },
  ])("refuses invalid actor addition cardinality %j", (change) => {
    const { receipt } = accessConfigurationCase("jira.add-role-default-actors");
    expect(
      jiraAccessConfigurationIdentityComplete("jira_add_role_default_actors", {
        ...receipt,
        ...change,
      }),
    ).toBe(false);
  });
  it("refuses removal of multiple principals and a role swap to itself", () => {
    const actor = accessConfigurationCase("jira.delete-project-role-actor").receipt;
    expect(
      jiraAccessConfigurationIdentityComplete("jira_delete_project_role_actor", {
        ...actor,
        actorUserKeys: ["one", "two"],
      }),
    ).toBe(false);
    const role = accessConfigurationCase("jira.delete-role").receipt;
    expect(
      jiraAccessConfigurationIdentityComplete("jira_delete_role", {
        ...role,
        swapRoleId: role.roleId,
      }),
    ).toBe(false);
  });
  it("refuses receipt context borrowed from another family or actor scope", () => {
    const role = accessConfigurationCase("jira.update-role").receipt;
    expect(
      jiraAccessConfigurationIdentityComplete("jira_update_role", { ...role, actorUserKeys: [] }),
    ).toBe(false);
    const defaults = accessConfigurationCase("jira.add-role-default-actors").receipt;
    expect(
      jiraAccessConfigurationIdentityComplete("jira_add_role_default_actors", {
        ...defaults,
        projectId: "10000",
      }),
    ).toBe(false);
    const scheme = accessConfigurationCase("jira.update-permission-scheme").receipt;
    expect(
      jiraAccessConfigurationIdentityComplete("jira_update_permission_scheme", {
        ...scheme,
        permissionId: "23",
      }),
    ).toBe(false);
  });
  it.each(["../../other", "x%2Fy", "é".repeat(128)])(
    "refuses an unaddressable or oversized attribute key %s",
    (attributeKey) => {
      const { receipt } = accessConfigurationCase("jira.set-permission-scheme-attribute");
      expect(
        jiraAccessConfigurationIdentityComplete("jira_set_permission_scheme_attribute", {
          ...receipt,
          attributeKey,
        }),
      ).toBe(false);
    },
  );
  it("preserves false while using the durable journal before the observed-attribute label", () => {
    const { receipt } = accessConfigurationCase("jira.set-permission-scheme-attribute");
    const result = exchange("jira_set_permission_scheme_attribute", receipt, 0, "unknown");
    expect(jiraToolState(result, "completed")).toBe("chat.jira.write.unknown");
    const facts = jiraToolOutcomeView(result).items.flatMap((item) => item.facts);
    expect(facts).toContainEqual({
      label: "chat.jira.accessWrite.requestedAttribute",
      value: "false",
    });
    expect(facts.some(({ label }) => label === "chat.jira.accessWrite.observedAttribute")).toBe(
      false,
    );
  });
  it("shows an explicit pre-dispatch actor no-op only with complete context and settled rejection", () => {
    const { receipt } = accessConfigurationCase("jira.set-project-role-actors");
    const unchanged = { ...receipt, outcome: "rejected", reason: "conflict", unchanged: true };
    expect(jiraToolState(exchange("jira_set_project_role_actors", unchanged), "completed")).toBe(
      "chat.jira.write.unchanged",
    );
    const unknown = exchange("jira_set_project_role_actors", unchanged, 0, "unknown");
    expect(jiraToolState(unknown, "completed")).toBe("chat.jira.write.unknown");
    expect(jiraToolOutcomeView(unknown).items.flatMap((item) => item.labels)).not.toContain(
      "chat.jira.savedConfiguration.unchanged",
    );
    const incomplete = Object.fromEntries(
      Object.entries(unchanged).filter(([key]) => key !== "projectId"),
    );
    expect(
      jiraToolState(exchange("jira_set_project_role_actors", incomplete), "completed"),
    ).not.toBe("chat.jira.write.unchanged");
  });
});
