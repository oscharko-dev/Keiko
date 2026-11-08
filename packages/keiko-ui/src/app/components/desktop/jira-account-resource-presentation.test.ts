import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_RESOURCE_CASES,
  accountResourceCase,
  accountResourceExchange,
} from "./jira-account-resource.test-fixture";
import {
  JIRA_ACCOUNT_RESOURCE_TOOLS,
  JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS,
  jiraAccountResourceDetails,
  jiraAccountResourceIdentityComplete,
} from "./jira-account-resource-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { jiraToolState, jiraMutationUnchanged } from "./jira-tool-presentation";
import { jiraAnonymizationTaskReviewDetails } from "./jira-anonymization-unlock-presentation";

describe("saved account, avatar and resource outcome boundaries", () => {
  it("covers every canonical family and the separately dispatched unlock singleton", () => {
    expect(
      new Set(ACCOUNT_RESOURCE_CASES.map(({ operation }) => operation.replace(/[.-]/gu, "_"))),
    ).toEqual(JIRA_ACCOUNT_RESOURCE_TOOLS);
    expect(ACCOUNT_RESOURCE_CASES).toHaveLength(45);
  });
  it.each(ACCOUNT_RESOURCE_CASES)(
    "retains closed $operation facts without inventing confirmation",
    (selected) => {
      const exchange = accountResourceExchange(selected);
      const source = { ...selected.receipt, outcome: "succeeded" };
      if (JIRA_ACCOUNT_RESOURCE_WRITE_TOOLS.has(exchange.call.name))
        expect(jiraAccountResourceIdentityComplete(exchange.call.name, source)).toBe(true);
      const view = jiraToolOutcomeView(exchange);
      expect(view.items).toHaveLength(1);
      expect(view.items[0]?.facts.length).toBeGreaterThan(0);
      expect(view.items[0]?.href).toBeUndefined();
      if (!Object.hasOwn(selected, "read")) {
        const stale = accountResourceExchange(selected, 0, source);
        expect(jiraToolState(stale, "completed")).toBe(
          Object.hasOwn(selected, "confirmed")
            ? "chat.jira.write.succeeded"
            : "chat.jira.write.unconfirmed",
        );
      }
    },
  );
  it("keeps journal uncertainty above a stale confirmed avatar and login result", () => {
    for (const operation of ["jira.set-project-avatar", "jira.login"]) {
      const selected = accountResourceCase(operation);
      const exchange = accountResourceExchange(
        selected,
        0,
        { ...selected.receipt, outcome: "succeeded" },
        "unknown",
      );
      expect(jiraToolState(exchange, "completed")).toBe("chat.jira.write.unknown");
      expect(jiraToolOutcomeView(exchange).items[0]?.labels).not.toContain(
        "chat.jira.savedConfiguration.confirmed",
      );
    }
  });
  it("never confirms active-state changes, even when a stale receipt omitted the target flag", () => {
    const selected = accountResourceCase("jira.update-user");
    const exchange = accountResourceExchange(selected, 0, {
      ...selected.receipt,
      outcome: "succeeded",
    });
    const changed = { ...exchange, call: { ...exchange.call, arguments: { active: false } } };
    expect(jiraToolState(changed, "completed")).toBe("chat.jira.write.unconfirmed");
    expect(jiraToolOutcomeView(changed).items[0]?.labels).toContain(
      "chat.jira.savedConfiguration.unconfirmed",
    );
  });
  it("does not turn login ACK or a false session marker into confirmed session establishment", () => {
    const receipt = {
      actorUserKey: "actor-key",
      userKey: "actor-key",
      username: "Operator",
      outcome: "succeeded",
    };
    const selected = accountResourceCase("jira.login");
    expect(jiraToolState(accountResourceExchange(selected, 0, receipt), "completed")).toBe(
      "chat.jira.write.unconfirmed",
    );
    expect(
      jiraToolState(
        accountResourceExchange(selected, 0, { ...receipt, sessionEstablished: false }),
        "completed",
      ),
    ).toBe("chat.jira.write.unknown");
  });
  it("retains partial known identities without inventing IDs after lost creation acknowledgement", () => {
    for (const [operation, receipt] of [
      ["jira.create-user", { actorUserKey: "actor-key", userPresent: true }],
      ["jira.create-issues", { userKey: "actor-key", requestedIssueCount: 2 }],
      [
        "jira.create-user-avatar",
        {
          actorUserKey: "actor-key",
          avatarType: "user",
          userKey: "target-key",
          avatarPresent: true,
          uploadSha256: "a".repeat(64),
          uploadBytes: 12,
        },
      ],
    ] as const) {
      const exchange = accountResourceExchange(
        accountResourceCase(operation),
        0,
        { ...receipt, outcome: "unknown" },
        "unknown",
      );
      expect(jiraToolOutcomeView(exchange).items[0]?.facts.length).toBeGreaterThan(0);
      expect(JSON.stringify(jiraToolOutcomeView(exchange))).not.toContain("9223372036854775807");
    }
  });
  it("refuses foreign keys, inherited fields, accessors and malformed pairs without reading getters", () => {
    const selected = accountResourceCase("jira.set-user-avatar");
    const tool = "jira_set_user_avatar";
    const getter = vi.fn(() => "target-key");
    const accessor = Object.defineProperty({ ...selected.receipt }, "userKey", {
      enumerable: true,
      get: getter,
    });
    const inherited = Object.create(selected.receipt) as Readonly<Record<string, unknown>>;
    for (const value of [
      accessor,
      inherited,
      { ...selected.receipt, password: "private-value" },
      { ...selected.receipt, [Symbol("hidden")]: true },
      { ...selected.receipt, avatarId: "9223372036854775808" },
    ])
      expect(jiraAccountResourceIdentityComplete(tool, value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(
      jiraAccountResourceIdentityComplete("jira_archive_issues", {
        userKey: "actor-key",
        issueIds: ["1"],
        issueKeys: ["SYN-1", "SYN-2"],
        issueArchivedRequested: true,
      }),
    ).toBe(false);
  });
  it("accepts no-op only for explicitly supported matching metadata and preserves journal precedence", () => {
    const selected = accountResourceCase("jira.set-project-avatar");
    const data = { ...selected.receipt, outcome: "rejected", reason: "conflict", unchanged: true };
    expect(jiraMutationUnchanged(accountResourceExchange(selected, 0, data, "rejected"))).toBe(
      true,
    );
    expect(jiraMutationUnchanged(accountResourceExchange(selected, 0, data, "unknown"))).toBe(
      false,
    );
    const unlock = accountResourceCase("jira.unlock-user-anonymization");
    expect(
      jiraMutationUnchanged(
        accountResourceExchange(
          unlock,
          0,
          { ...unlock.receipt, outcome: "rejected", reason: "conflict", unchanged: true },
          "rejected",
        ),
      ),
    ).toBe(false);
  });
  it("projects only closed policy counts and never private native error text", () => {
    const selected = accountResourceCase("jira.validate-license");
    const view = jiraToolOutcomeView(
      accountResourceExchange(selected, 0, {
        ...selected.receipt,
        outcome: "succeeded",
        messages: ["private-license-value"],
        fieldErrors: [{ fieldName: "license", message: "private-license-value" }],
        violations: [{ ruleId: "required-fields", subject: "private-license-value" }],
      }),
    );
    expect(JSON.stringify(view)).not.toContain("private-license-value");
    expect(view.items[0]?.facts).toContainEqual({
      label: "chat.jira.accountWrite.validationAccepted",
      value: "false",
    });
    expect(
      jiraAccountResourceDetails("jira_validate_license", {
        ...selected.receipt,
        outcome: "succeeded",
        accepted: true,
      })[0]?.labels,
    ).toContain("chat.jira.savedConfiguration.identityUnknown");
  });
  it("binds task review to observed user/time/status without deriving shutdown from interruption", () => {
    const progress = {
      userKey: "target-key",
      submittedTime: "native-time",
      status: "INTERRUPTED",
      operations: [],
      isRerun: false,
      currentProgress: 0,
      warnings: [],
    };
    const reviewSnapshot = {
      ...progress,
      executingNode: "node-a",
      startTime: null,
      errors: null,
      warnings: [],
    };
    expect(jiraAnonymizationTaskReviewDetails({ progress, reviewSnapshot }).labels).toContain(
      "chat.jira.accountWrite.taskOwnerNotShutdown",
    );
    expect(
      jiraAnonymizationTaskReviewDetails({
        progress,
        reviewSnapshot: { ...reviewSnapshot, userKey: "other-key" },
      }).labels,
    ).toContain("chat.jira.accountWrite.taskReviewUnavailable");
    for (const extra of [
      { status: "x".repeat(129) },
      { outcome: "succeeded" },
      { warnings: [{ operation: "handler", fields: [{ field: "name", message: 1 }] }] },
    ])
      expect(
        jiraAnonymizationTaskReviewDetails({
          progress,
          reviewSnapshot: { ...reviewSnapshot, ...extra },
        }).labels,
      ).toContain("chat.jira.accountWrite.taskReviewUnavailable");
    expect(jiraAnonymizationTaskReviewDetails({ progress, reviewSnapshot }).labels).toContain(
      "chat.jira.structural.nativeNotProvided",
    );
  });
  it("keeps saved Jira destinations bound to complete issue/project keys and rejects unsafe or mismatched URLs", () => {
    for (const [operation, path] of [
      ["jira.restore-project", "/projects/SYN/summary"],
      ["jira.restore-issue", "/browse/SYN-1"],
    ] as const) {
      const selected = accountResourceCase(operation);
      const view = (browseUrl: string): ReturnType<typeof jiraToolOutcomeView> =>
        jiraToolOutcomeView(
          accountResourceExchange(selected, 0, {
            ...selected.receipt,
            outcome: "succeeded-unconfirmed",
            browseUrl,
          }),
        );
      const native = `https://jira.example/context${path}`;
      expect(view(native).items[0]?.href).toBe(native);
      for (const url of [
        `http://jira.example${path}`,
        `javascript:${path}`,
        `https://actor:credential@jira.example${path}`,
        `${native}?redirect=other`,
        `${native}#other`,
        native.replace("SYN", "OTHER"),
        `https://jira.example/context%2fhidden${path}`,
        `https://jira.example\\context${path}`,
        `https://jira.example/\ncontext${path}`,
        "https://jira.example/other",
      ])
        expect(view(url).items[0]?.href).toBeUndefined();
      const incomplete = {
        ...selected.receipt,
        outcome: "unknown",
        browseUrl: native,
        userKey: null,
      };
      expect(
        jiraToolOutcomeView(accountResourceExchange(selected, 0, incomplete)).items[0]?.href,
      ).toBeUndefined();
    }
  });
});
