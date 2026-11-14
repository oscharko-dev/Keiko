import { describe, expect, it } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_EXISTING_GUIDANCE,
  JIRA_REJECTED_GUIDANCE,
  JIRA_UNCERTAIN_GUIDANCE,
  jiraAttemptToolResult,
  jiraLinkCounts,
  jiraLinkCountsOfResult,
  jiraMutationToolResult,
  validJiraMutationAttempt,
} from "./jiraMutationResult.js";

const MISSING = { type: "Relates", direction: "outward", issueKey: "SYN-9" } as const;
const LINKS = { requested: 3, created: 2, missing: [MISSING], unconfirmed: false };
const PARTIAL: JiraMutationAttempt = {
  ok: false,
  reason: "not-found",
  receipt: { issueKey: "SYN-1", issueId: "10001" },
  links: LINKS,
};

describe("typed entity property mutation receipts", () => {
  it.each([
    {
      set: "jira.set-board-property",
      remove: "jira.delete-board-property",
      context: { boardId: "7" },
    },
    {
      set: "jira.set-sprint-property",
      remove: "jira.delete-sprint-property",
      context: { sprintId: "9" },
    },
    {
      set: "jira.set-comment-property",
      remove: "jira.delete-comment-property",
      context: { issueId: "10001", issueKey: "SYN-1", commentId: "10002" },
    },
    {
      set: "jira.set-dashboard-item-property",
      remove: "jira.delete-dashboard-item-property",
      context: { dashboardId: "71", selectedItemId: "81" },
    },
    {
      set: "jira.set-issue-property",
      remove: "jira.delete-issue-property",
      context: { issueId: "10001", issueKey: "SYN-1" },
    },
    {
      set: "jira.set-issue-type-property",
      remove: "jira.delete-issue-type-property",
      context: { issueTypeId: "10001" },
    },
    {
      set: "jira.set-project-property",
      remove: "jira.delete-project-property",
      context: { projectId: "10000", projectKey: "SYN" },
    },
    {
      set: "jira.set-user-property",
      remove: "jira.delete-user-property",
      context: { userKey: "JIRAUSER10100", username: "Synthetic-User" },
    },
  ] as const)(
    "requires the selected canonical context and property target for $set",
    ({ set, remove, context }) => {
      for (const operation of [set, remove]) {
        const propertyPresent = operation === set;
        const receipt = { ...context, propertyKey: "view ~settings", propertyPresent };
        expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
          ok: true,
          receipt,
        });
        const pending = validJiraMutationAttempt(
          { ok: false, reason: "timeout", receipt },
          operation,
        );
        for (const outcome of ["unknown", "succeeded-unconfirmed"] as const)
          expect(jiraAttemptToolResult(outcome, pending).data).toMatchObject({
            outcome,
            ...receipt,
          });
        for (const field of [...Object.keys(context), "propertyKey", "propertyPresent"]) {
          const partial = Object.fromEntries(
            Object.entries(receipt).filter(([key]) => key !== field),
          );
          expect(validJiraMutationAttempt({ ok: true, receipt: partial }, operation)).toEqual({
            ok: false,
            reason: "malformed-payload",
          });
          expect(
            validJiraMutationAttempt({ ok: false, reason: "timeout", receipt: partial }, operation),
          ).not.toHaveProperty("receipt");
        }
        for (const extra of [
          { propertyPresent: !propertyPresent },
          { propertyKey: "" },
          { browseUrl: "https://untrusted.invalid/property" },
          { entityType: "issue" },
          { valueNodes: [{ path: "", kind: "null" }] },
        ]) {
          const invalid = { ...receipt, ...extra };
          expect(validJiraMutationAttempt({ ok: true, receipt: invalid }, operation)).toEqual({
            ok: false,
            reason: "malformed-payload",
          });
          expect(
            validJiraMutationAttempt({ ok: false, reason: "timeout", receipt: invalid }, operation),
          ).not.toHaveProperty("receipt");
        }
      }
    },
  );
  it("does not reinterpret an observed unchanged value as a write", () => {
    const attempt = validJiraMutationAttempt(
      {
        ok: false,
        reason: "conflict",
        receipt: {
          issueId: "10001",
          issueKey: "SYN-1",
          propertyKey: "view.settings",
          propertyPresent: true,
        },
        detail: { unchanged: true },
      },
      "jira.set-issue-property",
    );
    expect(jiraAttemptToolResult("rejected", attempt).data).toMatchObject({
      outcome: "rejected",
      unchanged: true,
      propertyPresent: true,
    });
  });
  it("refuses an inherited required property receipt field instead of treating it as observed", () => {
    const receipt: Record<string, unknown> = {
      issueKey: "SYN-1",
      propertyKey: "view.settings",
      propertyPresent: true,
    };
    Object.setPrototypeOf(receipt, { issueId: "10001" });
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.set-issue-property")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(
      validJiraMutationAttempt(
        { ok: false, reason: "timeout", receipt },
        "jira.set-issue-property",
      ),
    ).not.toHaveProperty("receipt");
  });
  it("refuses a user receipt with an unpaired surrogate rather than inventing a canonical username", () => {
    const receipt = {
      userKey: "JIRAUSER10100",
      username: "synthetic\ud800",
      propertyKey: "view.settings",
      propertyPresent: true,
    };
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.set-user-property")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(
      validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, "jira.set-user-property"),
    ).not.toHaveProperty("receipt");
  });
});

describe("monitoring setting receipts", () => {
  it.each([
    ["jira.set-app-monitoring", "monitoringEnabled", false],
    ["jira.set-ipd-monitoring", "monitoringEnabled", true],
    ["jira.start-jmx-metrics", "jmxMetricsExposed", true],
    ["jira.stop-jmx-metrics", "jmxMetricsExposed", false],
  ] as const)(
    "preserves the exact confirmed or requested boolean for %s",
    (operation, field, value) => {
      const receipt = { [field]: value };
      const confirmed = validJiraMutationAttempt({ ok: true, receipt }, operation);
      expect(confirmed).toEqual({ ok: true, receipt });
      expect(jiraAttemptToolResult("succeeded", confirmed).data).toMatchObject({
        outcome: "succeeded",
        ...receipt,
      });
      const uncertain = validJiraMutationAttempt(
        { ok: false, reason: "timeout", receipt },
        operation,
      );
      expect(uncertain).toEqual({ ok: false, reason: "timeout", receipt });
      for (const outcome of ["unknown", "succeeded-unconfirmed"] as const)
        expect(jiraAttemptToolResult(outcome, uncertain).data).toMatchObject({
          outcome,
          ...receipt,
        });
      expect(validJiraMutationAttempt({ ok: true, receipt: {} }, operation)).toEqual({
        ok: false,
        reason: "malformed-payload",
      });
      for (const extra of [
        { issueKey: "SYN-1" },
        { screenId: "71" },
        { browseUrl: "https://untrusted.invalid/monitoring" },
        { monitoringEnabled: true, jmxMetricsExposed: true },
      ]) {
        const contaminated = { ...receipt, ...extra };
        expect(validJiraMutationAttempt({ ok: true, receipt: contaminated }, operation)).toEqual({
          ok: false,
          reason: "malformed-payload",
        });
        expect(
          validJiraMutationAttempt(
            { ok: false, reason: "timeout", receipt: contaminated },
            operation,
          ),
        ).not.toHaveProperty("receipt");
      }
      expect(
        validJiraMutationAttempt({ ok: true, receipt: { [field]: "false" } }, operation),
      ).toEqual({ ok: false, reason: "malformed-payload" });
    },
  );
  it.each([
    ["jira.start-jmx-metrics", false],
    ["jira.stop-jmx-metrics", true],
  ] as const)(
    "refuses a receipt that contradicts the fixed target of %s",
    (operation, jmxMetricsExposed) => {
      expect(
        validJiraMutationAttempt({ ok: true, receipt: { jmxMetricsExposed } }, operation),
      ).toEqual({ ok: false, reason: "malformed-payload" });
      expect(
        validJiraMutationAttempt(
          { ok: false, reason: "timeout", receipt: { jmxMetricsExposed } },
          operation,
        ),
      ).not.toHaveProperty("receipt");
    },
  );
  it("retains observed disabled no-op without reporting an applied write", () => {
    const attempt = validJiraMutationAttempt(
      {
        ok: false,
        reason: "conflict",
        receipt: { monitoringEnabled: false },
        detail: { unchanged: true },
      },
      "jira.set-app-monitoring",
    );
    expect(jiraAttemptToolResult("rejected", attempt).data).toMatchObject({
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      monitoringEnabled: false,
    });
  });
});

describe("screen tab receipts", () => {
  it.each(["jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab"] as const)(
    "requires both exact screen and tab identities for confirmed %s",
    (operation) => {
      const receipt = { screenId: "9223372036854775807", tabId: "9007199254740993" };
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: true,
        receipt,
      });
      expect(
        validJiraMutationAttempt({ ok: true, receipt: { screenId: "71" } }, operation),
      ).toEqual({ ok: false, reason: "malformed-payload" });
      expect(jiraAttemptToolResult("succeeded", { ok: true, receipt }).data).toMatchObject({
        outcome: "succeeded",
        ...receipt,
      });
      const uncertain = validJiraMutationAttempt(
        { ok: false, reason: "timeout", receipt },
        operation,
      );
      expect(jiraAttemptToolResult("succeeded-unconfirmed", uncertain).data).toMatchObject({
        outcome: "succeeded-unconfirmed",
        ...receipt,
      });
    },
  );
  it("retains only known screen context when create acknowledgement was lost", () => {
    const attempt = validJiraMutationAttempt(
      { ok: false, reason: "timeout", receipt: { screenId: "71" } },
      "jira.create-screen-tab",
    );
    expect(attempt).toEqual({ ok: false, reason: "timeout", receipt: { screenId: "71" } });
    const result = jiraAttemptToolResult("unknown", attempt);
    expect(result.data).toMatchObject({ outcome: "unknown", screenId: "71" });
    expect(result.data).not.toHaveProperty("tabId");
    expect(result.data).not.toHaveProperty("name");
  });
  it.each([
    { tabId: "81" },
    { screenId: "0", tabId: "81" },
    { screenId: "71", tabId: "9223372036854775808" },
    { screenId: "71", tabId: "81", issueKey: "SYN-1" },
    { screenId: "71", tabId: "81", projectId: "10000" },
    { screenId: "71", tabId: "81", browseUrl: "https://untrusted.invalid/screen" },
    { screenId: "71", tabId: "81", name: "Unobserved tab" },
  ])("refuses malformed or cross-entity tab receipt fields %j", (receipt) => {
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.create-screen-tab")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(
      validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, "jira.create-screen-tab"),
    ).not.toHaveProperty("receipt");
  });
  it("retains the exact already-current target without promoting it to a successful write", () => {
    const attempt = validJiraMutationAttempt(
      {
        ok: false,
        reason: "conflict",
        receipt: { screenId: "71", tabId: "81" },
        detail: { unchanged: true },
      },
      "jira.rename-screen-tab",
    );
    expect(jiraAttemptToolResult("rejected", attempt).data).toMatchObject({
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      screenId: "71",
      tabId: "81",
    });
  });
});

describe("updated comment receipts", () => {
  it("requires both the issue and the independently confirmed comment identity", () => {
    const receipt = { issueKey: "SYN-1", commentId: "10002" };
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.update-comment")).toEqual({
      ok: true,
      receipt,
    });
    expect(
      validJiraMutationAttempt({ ok: true, receipt: { issueKey: "SYN-1" } }, "jira.update-comment"),
    ).toEqual({ ok: false, reason: "malformed-payload" });
    expect(
      jiraAttemptToolResult(
        "succeeded-unconfirmed",
        validJiraMutationAttempt(
          { ok: false, reason: "unavailable", receipt },
          "jira.update-comment",
        ),
      ).data,
    ).toMatchObject({ ...receipt, outcome: "succeeded-unconfirmed" });
  });
});

describe("Agile entity and membership receipts", () => {
  it.each([
    {
      operation: "jira.board-create",
      receipt: {
        boardId: "37",
        browseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=37",
      },
    },
    {
      operation: "jira.epic-update",
      receipt: { epicKey: "SYN-1", browseUrl: "https://jira.example.invalid/context/browse/SYN-1" },
    },
    {
      operation: "jira.sprint-update",
      receipt: {
        sprintId: "37",
        originBoardId: "7",
        boardBrowseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
      },
    },
  ] as const)(
    "preserves validated direct or board-context links for $operation",
    ({ operation, receipt }) => {
      const attempt = validJiraMutationAttempt({ ok: true, receipt }, operation);
      expect(attempt).toEqual({ ok: true, receipt });
      expect(jiraAttemptToolResult("succeeded", attempt).data).toMatchObject(receipt);
      const partial = validJiraMutationAttempt(
        { ok: false, reason: "unavailable", receipt },
        operation,
      );
      expect(jiraAttemptToolResult("succeeded-unconfirmed", partial).data).toMatchObject(receipt);
    },
  );
  it.each([
    { operation: "jira.board-create", receipt: { boardId: "37" } },
    { operation: "jira.sprint-create", receipt: { sprintId: "37" } },
    { operation: "jira.sprint-update", receipt: { sprintId: "37" } },
    { operation: "jira.sprint-move-issues", receipt: { sprintId: "37", issueKeys: ["SYN-1"] } },
    { operation: "jira.backlog-move-issues", receipt: { issueKeys: ["SYN-1"] } },
    { operation: "jira.epic-update", receipt: { epicKey: "SYN-1" } },
    { operation: "jira.epic-move-issues", receipt: { epicKey: "SYN-1", issueKeys: ["SYN-2"] } },
  ] as const)(
    "preserves the exact $operation receipt on success and uncertainty",
    ({ operation, receipt }) => {
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: true,
        receipt,
      });
      const partial = validJiraMutationAttempt(
        { ok: false, reason: "unavailable", receipt },
        operation,
      );
      expect(jiraAttemptToolResult("succeeded-unconfirmed", partial).data).toMatchObject({
        ...receipt,
        outcome: "succeeded-unconfirmed",
      });
    },
  );
  it.each([
    {
      sprintId: "37",
      boardBrowseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
    },
    {
      sprintId: "37",
      originBoardId: "7",
      boardBrowseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=8",
    },
    {
      sprintId: "37",
      originBoardId: "7",
      boardBrowseUrl:
        "https://user:password@jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
    },
    {
      sprintId: "37",
      originBoardId: "7",
      boardBrowseUrl:
        "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7&next=foreign",
    },
    {
      sprintId: "37",
      originBoardId: "7",
      boardBrowseUrl: "http://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
    },
    {
      sprintId: "37",
      originBoardId: "7",
      boardBrowseUrl:
        "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7#foreign",
    },
    { sprintId: "37", originBoardId: "9007199254740992" },
    {
      sprintId: "37",
      browseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?sprint=37",
    },
  ])("refuses invalid, mismatched or invented sprint destinations %#", (receipt) => {
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.sprint-update")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(
      validJiraMutationAttempt({ ok: false, reason: "unavailable", receipt }, "jira.sprint-update"),
    ).not.toHaveProperty("receipt");
  });
  it.each([
    {
      operation: "jira.board-create",
      receipt: { boardId: "37", browseUrl: "https://jira.example.invalid/context/browse/SYN-1" },
    },
    {
      operation: "jira.board-create",
      receipt: {
        boardId: "37",
        browseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
      },
    },
    {
      operation: "jira.epic-update",
      receipt: { epicKey: "SYN-1", browseUrl: "https://jira.example.invalid/context/browse/SYN-2" },
    },
    {
      operation: "jira.epic-update",
      receipt: {
        epicKey: "SYN-1",
        browseUrl: "https://jira.example.invalid/context/browse/SYN-1?next=foreign",
      },
    },
  ] as const)(
    "refuses mismatched direct entity destinations for $operation",
    ({ operation, receipt }) => {
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: false,
        reason: "malformed-payload",
      });
    },
  );
  it("copies membership evidence before a producer can mutate its array", () => {
    const issueKeys = ["SYN-1"];
    const result = validJiraMutationAttempt(
      { ok: true, receipt: { sprintId: "37", issueKeys } },
      "jira.sprint-move-issues",
    );
    issueKeys.push("SYN-2");
    expect(result).toMatchObject({ receipt: { sprintId: "37", issueKeys: ["SYN-1"] } });
    expect(Object.isFrozen(result.receipt?.issueKeys)).toBe(true);
  });
  it.each([
    { sprintId: "37", issueKeys: ["SYN-1", "SYN-1"] },
    { sprintId: "37", issueKeys: [] },
    { sprintId: "37", issueKeys: ["not-an-issue"] },
    { sprintId: "9007199254740992", issueKeys: ["SYN-1"] },
    { sprintId: "37", issueKeys: ["SYN-1"], issueKey: "SYN-1" },
    { sprintId: "37", issueKeys: ["SYN-1"], boardId: "37" },
  ])("refuses mixed, ambiguous or imprecise membership evidence %#", (receipt) => {
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.sprint-move-issues")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
  });
});

describe("project mutation receipts", () => {
  const receipt = {
    projectId: "9223372036854775807",
    projectKey: "SYN",
    projectName: "Synthetic project",
    browseUrl: "https://jira.example.invalid/context/projects/SYN/summary",
  };
  it.each(["jira.create-project", "jira.update-project"] as const)(
    "preserves the independently confirmed project identity for %s",
    (operation) => {
      const attempt = validJiraMutationAttempt({ ok: true, receipt }, operation);
      expect(attempt).toEqual({ ok: true, receipt });
      expect(jiraAttemptToolResult("succeeded", attempt).data).toMatchObject(receipt);
    },
  );
  it("keeps partial project identity with an uncertain effect and no invented issue key", () => {
    const attempt = validJiraMutationAttempt(
      { ok: false, reason: "conflict", receipt },
      "jira.create-project",
    );
    const result = jiraAttemptToolResult("unknown", attempt);
    expect(result.data).toMatchObject({
      ...receipt,
      outcome: "unknown",
      reason: "conflict",
      guidance: JIRA_UNCERTAIN_GUIDANCE,
    });
    expect(result.data).not.toHaveProperty("issueKey");
  });
  it.each([
    { ...receipt, issueKey: "SYN-1" },
    { ...receipt, projectId: "not-numeric" },
    { ...receipt, projectName: "Synthetic\nproject" },
    {
      ...receipt,
      browseUrl: "https://user:password@jira.example.invalid/context/projects/SYN/summary",
    },
    { ...receipt, browseUrl: "https://jira.example.invalid/context/projects/OTHER/summary" },
    {
      ...receipt,
      browseUrl: "https://jira.example.invalid/context/projects/SYN/summary?next=foreign",
    },
    { ...receipt, browseUrl: "https://jira.example.invalid/context/browse/SYN-1" },
  ])("refuses mixed or unvalidated project receipts %#", (invalid) => {
    expect(validJiraMutationAttempt({ ok: true, receipt: invalid }, "jira.create-project")).toEqual(
      { ok: false, reason: "malformed-payload" },
    );
    expect(
      validJiraMutationAttempt(
        { ok: false, reason: "conflict", receipt: invalid },
        "jira.create-project",
      ),
    ).not.toHaveProperty("receipt");
  });
});

describe("version and component identities", () => {
  it.each([
    {
      operation: "jira.create-component",
      receipt: { componentId: "9223372036854775807", projectId: "10000", projectKey: "SYN" },
    },
    {
      operation: "jira.update-component",
      receipt: { componentId: "37", projectId: "10000", projectKey: "SYN" },
    },
    {
      operation: "jira.create-version",
      receipt: { versionId: "9223372036854775807", projectId: "10000" },
    },
    { operation: "jira.update-version", receipt: { versionId: "37" } },
  ] as const)(
    "preserves precise $operation identity on success and uncertain effects",
    ({ operation, receipt }) => {
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: true,
        receipt,
      });
      const partial = validJiraMutationAttempt(
        { ok: false, reason: "unavailable", receipt },
        operation,
      );
      expect(jiraAttemptToolResult("unknown", partial).data).toMatchObject({
        ...receipt,
        outcome: "unknown",
      });
    },
  );
  it.each(["jira.create-component", "jira.create-version"] as const)(
    "does not confuse known project context with a created resource for %s",
    (operation) => {
      const receipt = { projectId: "10000", projectKey: "SYN" };
      const partial = validJiraMutationAttempt(
        { ok: false, reason: "unavailable", receipt },
        operation,
      );
      expect(jiraAttemptToolResult("unknown", partial).data).toMatchObject({
        ...receipt,
        outcome: "unknown",
      });
      expect(partial.receipt).not.toHaveProperty("componentId");
      expect(partial.receipt).not.toHaveProperty("versionId");
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: false,
        reason: "malformed-payload",
      });
    },
  );
  it.each([
    { componentId: "37", versionId: "37" },
    { componentId: "37", issueKey: "SYN-1" },
    { componentId: "9223372036854775808" },
    { componentId: "3.7" },
    { componentId: "37", projectId: "not-an-id" },
    { componentId: "37", browseUrl: "https://foreign.example.invalid/component/37" },
  ])("refuses mixed or untrusted component identity %#", (receipt) => {
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.create-component")).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
  });
});

describe("collaboration mutation receipts", () => {
  const context = { issueKey: "SYN-1", issueId: "10001" };
  it.each([
    { operation: "jira.create-worklog", receipt: { ...context, worklogId: "9223372036854775807" } },
    { operation: "jira.update-worklog", receipt: { ...context, worklogId: "10002" } },
    { operation: "jira.delete-worklog", receipt: { ...context, worklogId: "10002" } },
    { operation: "jira.delete-comment", receipt: { ...context, commentId: "10002" } },
    { operation: "jira.delete-attachment", receipt: { ...context, attachmentId: "10300" } },
    { operation: "jira.watch", receipt: { ...context, isWatching: true } },
    { operation: "jira.unwatch", receipt: { ...context, isWatching: false } },
    { operation: "jira.vote", receipt: { ...context, hasVoted: true } },
    { operation: "jira.unvote", receipt: { ...context, hasVoted: false } },
  ] as const)("requires independent $operation evidence for success", ({ operation, receipt }) => {
    expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
      ok: true,
      receipt,
    });
    const { issueId: _issueId, ...unbound } = receipt;
    expect(validJiraMutationAttempt({ ok: true, receipt: unbound }, operation)).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(validJiraMutationAttempt({ ok: true, receipt: context }, operation)).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    const partial = validJiraMutationAttempt(
      { ok: false, reason: "unavailable", receipt: context },
      operation,
    );
    expect(jiraAttemptToolResult("succeeded-unconfirmed", partial).data).toMatchObject({
      ...context,
      outcome: "succeeded-unconfirmed",
    });
    expect(partial.receipt).not.toHaveProperty("worklogId");
    expect(partial.receipt).not.toHaveProperty("isWatching");
    expect(partial.receipt).not.toHaveProperty("hasVoted");
  });
  it.each([
    { operation: "jira.watch", receipt: { ...context, isWatching: false } },
    { operation: "jira.unwatch", receipt: { ...context, isWatching: true } },
    { operation: "jira.vote", receipt: { ...context, hasVoted: false } },
    { operation: "jira.unvote", receipt: { ...context, hasVoted: true } },
    { operation: "jira.vote", receipt: { ...context, hasVoted: true, worklogId: "10002" } },
    { operation: "jira.create-worklog", receipt: { ...context, worklogId: "9223372036854775808" } },
    { operation: "jira.update-worklog", receipt: { ...context, worklogId: "1.5" } },
    { operation: "jira.delete-worklog", receipt: { ...context, worklogId: "00" } },
    { operation: "jira.delete-comment", receipt: { ...context, commentId: "-1" } },
    { operation: "jira.delete-attachment", receipt: { ...context, commentId: "10300" } },
    { operation: "jira.watch", receipt: { ...context, isWatching: true, issueId: "not-an-id" } },
    { operation: "jira.vote", receipt: { ...context, hasVoted: true, issueKey: "../foreign" } },
  ] as const)(
    "refuses mixed, opposite or unvalidated $operation evidence %#",
    ({ operation, receipt }) => {
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: false,
        reason: "malformed-payload",
      });
      expect(
        validJiraMutationAttempt({ ok: false, reason: "conflict", receipt }, operation),
      ).not.toHaveProperty("receipt");
    },
  );
});

describe("internal description formatting evidence", () => {
  it("keeps body-only Markdown projection evidence private and drops foreign values", () => {
    const attempt: JiraMutationAttempt = {
      ok: true,
      receipt: { issueKey: "SYN-1" },
      descriptionProjection: "supported-markdown",
    };
    const valid = validJiraMutationAttempt(attempt, "jira.edit");
    expect(valid.descriptionProjection).toBe("supported-markdown");
    expect(valid).not.toHaveProperty("descriptionConvertedHeadingCount");
    expect(jiraAttemptToolResult("succeeded", valid).data).not.toHaveProperty(
      "descriptionProjection",
    );
    const foreign = {
      ...attempt,
      descriptionProjection: "private body",
    } as unknown as JiraMutationAttempt;
    expect(validJiraMutationAttempt(foreign, "jira.edit")).not.toHaveProperty(
      "descriptionProjection",
    );
  });
  it.each([true, false])(
    "keeps bounded counts internally and omits them from the model result (ok=%s)",
    (ok) => {
      const attempt: JiraMutationAttempt = ok
        ? {
            ok: true,
            receipt: { issueKey: "SYN-1", issueId: "10001" },
            descriptionConvertedHeadingCount: 3,
          }
        : { ok: false, reason: "not-found", descriptionConvertedHeadingCount: 3 };
      const valid = validJiraMutationAttempt(attempt, "jira.create");
      expect(valid.descriptionConvertedHeadingCount).toBe(3);
      expect(jiraAttemptToolResult(ok ? "succeeded" : "rejected", valid).data).not.toHaveProperty(
        "descriptionConvertedHeadingCount",
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 32769])(
    "drops inadmissible count %s",
    (count) => {
      const valid = validJiraMutationAttempt(
        { ok: false, reason: "not-found", descriptionConvertedHeadingCount: count },
        "jira.create",
      );
      expect(valid).not.toHaveProperty("descriptionConvertedHeadingCount");
    },
  );
});

describe("a partial link effect (#4176)", () => {
  it("is kept by validation: the issue that exists and the links that are missing", () => {
    expect(validJiraMutationAttempt(PARTIAL, "jira.create")).toEqual(PARTIAL);
  });

  it("drops an issue identity that does not validate, never forwarding it", () => {
    const attempt = { ...PARTIAL, receipt: { issueKey: "not a key\n", issueId: "10001" } };
    expect(validJiraMutationAttempt(attempt, "jira.create")).toEqual({
      ok: false,
      reason: "not-found",
      links: LINKS,
    });
  });

  it("drops a receipt that names no issue and a link account outside its bounds", () => {
    const attempt = {
      ok: false,
      reason: "conflict",
      receipt: { commentId: "5" },
      links: { requested: 99, created: 0, missing: [], unconfirmed: false },
    } as const;
    expect(validJiraMutationAttempt(attempt, "jira.create")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("keeps the link account of a success and sanitizes it", () => {
    const links = { requested: 2, created: 2, missing: [], unconfirmed: false };
    expect(
      validJiraMutationAttempt(
        { ok: true, receipt: { issueKey: "SYN-1", issueId: "10001" }, links },
        "jira.create",
      ),
    ).toEqual({ ok: true, receipt: { issueKey: "SYN-1", issueId: "10001" }, links });
    expect(
      validJiraMutationAttempt(
        {
          ok: true,
          receipt: { issueKey: "SYN-1", issueId: "10001" },
          links: { ...links, created: 5 },
        },
        "jira.create",
      ),
    ).toEqual({ ok: true, receipt: { issueKey: "SYN-1", issueId: "10001" } });
  });

  it("reaches the model as an unconfirmed outcome that names the issue and the missing links", () => {
    expect(jiraAttemptToolResult("succeeded-unconfirmed", PARTIAL)).toEqual({
      isError: true,
      data: {
        issueKey: "SYN-1",
        issueId: "10001",
        outcome: "succeeded-unconfirmed",
        reason: "not-found",
        linksRequested: 3,
        linksCreated: 2,
        linksMissing: [MISSING],
        guidance: JIRA_UNCERTAIN_GUIDANCE,
      },
    });
  });

  it("marks links it could not read back as unconfirmed", () => {
    const attempt: JiraMutationAttempt = {
      ...PARTIAL,
      links: { requested: 3, created: 1, missing: [MISSING, MISSING], unconfirmed: true },
    };
    expect(jiraAttemptToolResult("succeeded-unconfirmed", attempt).data).toMatchObject({
      linksUnconfirmed: true,
    });
  });

  it("reports counts only: requested, present afterwards and missing", () => {
    expect(jiraLinkCounts(PARTIAL)).toEqual({ requested: 3, created: 2, failed: 1 });
    expect(jiraLinkCounts({ ok: false, reason: "conflict" })).toBeUndefined();
    expect(
      jiraLinkCountsOfResult(jiraAttemptToolResult("succeeded-unconfirmed", PARTIAL).data),
    ).toEqual({ requested: 3, created: 2, failed: 1 });
    expect(jiraLinkCountsOfResult({ outcome: "failed" })).toBeUndefined();
    expect(jiraLinkCountsOfResult(undefined)).toBeUndefined();
  });

  it("does not give a failed attempt without a partial effect an identity", () => {
    expect(jiraAttemptToolResult("rejected", { ok: false, reason: "field-validation" })).toEqual({
      isError: true,
      data: { outcome: "rejected", reason: "field-validation" },
    });
  });
});

describe("Jira's own field errors (#4176)", () => {
  const FIELD_ERRORS = [
    { fieldId: "customfield_10000", message: "Option 'Rot' is not valid." },
    { fieldId: "components", message: "Component 'Nope' does not exist." },
  ] as const;

  it("reach the model with the field id and Jira's message", () => {
    const result = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "field-validation",
      detail: { fieldErrors: FIELD_ERRORS, messages: ["Issue could not be created."] },
    });

    expect(result).toEqual({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "field-validation",
        fieldErrors: [
          { fieldId: "customfield_10000", message: "Option 'Rot' is not valid." },
          { fieldId: "components", message: "Component 'Nope' does not exist." },
        ],
        messages: ["Issue could not be created."],
        guidance: JIRA_REJECTED_GUIDANCE,
      },
    });
  });

  it("are copied, so the result cannot alias the attempt's detail", () => {
    const attempt: JiraMutationAttempt = {
      ok: false,
      reason: "field-validation",
      detail: { fieldErrors: FIELD_ERRORS },
    };

    const data = jiraAttemptToolResult("rejected", attempt).data as {
      fieldErrors: { fieldId: string }[];
    };

    expect(data.fieldErrors).toEqual(FIELD_ERRORS);
    expect(data.fieldErrors[0]).not.toBe(FIELD_ERRORS[0]);
  });

  it("are absent from a refusal that carries no detail", () => {
    const data = jiraAttemptToolResult("rejected", { ok: false, reason: "field-validation" }).data;

    expect(data).not.toHaveProperty("fieldErrors");
  });
});

describe("what the model is told to do next (#4176)", () => {
  it.each(["effect-denied", "cancelled"] as const)(
    "preserves local %s guidance without overriding uncertain effects",
    (reason) => {
      for (const outcome of ["rejected", "not-dispatched"] as const) {
        const data = jiraMutationToolResult(outcome, reason).data;
        expect(data.guidance).toMatch(/Do not retry automatically/u);
        expect(data.guidance).not.toMatch(/Jira refused|nothing was changed|network/iu);
      }
      for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
        const data = jiraMutationToolResult(outcome, reason, { issueKey: "SYN-1" }).data;
        expect(data.guidance).toBe(JIRA_UNCERTAIN_GUIDANCE);
        expect(data.issueKey).toBe("SYN-1");
      }
      expect(jiraMutationToolResult("succeeded", reason).data).not.toHaveProperty("guidance");
    },
  );
  it.each([
    ["unknown", undefined],
    ["succeeded-unconfirmed", undefined],
    ["not-dispatched", "conflict"],
  ] as const)(
    "tells the model to stop and inform the user in plain language after %s (%s)",
    (outcome, reason) => {
      const data = jiraMutationToolResult(outcome, reason).data;

      expect(data.guidance).toBe(JIRA_UNCERTAIN_GUIDANCE);
      expect(JIRA_UNCERTAIN_GUIDANCE).toMatch(/Do not repeat it/u);
      expect(JIRA_UNCERTAIN_GUIDANCE).toMatch(/tell the user in plain language/iu);
    },
  );

  it("adds nothing to a success, to a refusal Jira did not explain, or to another conflict-free outcome", () => {
    expect(jiraMutationToolResult("succeeded").data).not.toHaveProperty("guidance");
    expect(jiraMutationToolResult("rejected", "field-validation").data).not.toHaveProperty(
      "guidance",
    );
    expect(jiraMutationToolResult("not-dispatched", "permission-denied").data).not.toHaveProperty(
      "guidance",
    );
  });

  it("names the field's display name beside its id when Jira's error carries one", () => {
    const data = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "field-validation",
      detail: {
        fieldErrors: [
          { fieldId: "customfield_10000", fieldName: "Risk class", message: "Invalid." },
        ],
      },
    }).data;

    expect(data.fieldErrors).toEqual([
      { fieldId: "customfield_10000", fieldName: "Risk class", message: "Invalid." },
    ]);
  });
});

// S19 of epic #4173: a create a Keiko draft already made is refused before any request. The model
// must report the existing key, not "correct the fields" into a second issue.
describe("a create refused because a draft already made the issue", () => {
  it("uses explicit unchanged evidence for a version rather than guessing from resource keys", () => {
    const result = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "conflict",
      receipt: { versionId: "81" },
      detail: {
        unchanged: true,
        messages: ["The version already holds these values. Nothing was written."],
      },
    });
    expect(result.data).toMatchObject({
      versionId: "81",
      unchanged: true,
      guidance: JIRA_EXISTING_GUIDANCE,
    });
    const conflict = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "conflict",
      receipt: { issueKey: "SYN-1" },
      detail: { messages: ["The requested change conflicts with the current state."] },
    });
    expect(conflict.data.guidance).toBe(JIRA_REJECTED_GUIDANCE);
  });
  it("reports an unchanged project as the existing result without suggesting another write", () => {
    const result = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "conflict",
      receipt: { projectId: "10000", projectKey: "SYN" },
      detail: {
        unchanged: true,
        messages: ["The project already holds these values. Nothing was written."],
      },
    });
    expect(result.data.guidance).toBe(JIRA_EXISTING_GUIDANCE);
    expect(result.data.guidance).not.toMatch(/issueKey|the issue|correct the fields/iu);
    expect(result.data.projectKey).toBe("SYN");
  });
  it("names the existing key and tells the model to report it, not to correct and resend", () => {
    const message =
      "SYN-4 already exists as this issue: a Keiko draft created it in this project with this type and summary. Nothing was created. Report SYN-4 as the result; do not create it again.";
    const result = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "conflict",
      receipt: { issueKey: "SYN-4", issueId: "10004" },
      detail: { unchanged: true, messages: [message] },
    });

    expect(result).toEqual({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "conflict",
        issueKey: "SYN-4",
        issueId: "10004",
        unchanged: true,
        messages: [message],
        guidance: JIRA_EXISTING_GUIDANCE,
      },
    });
  });

  it("keeps the ordinary refusal guidance for a conflict that names no existing issue", () => {
    const data = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "conflict",
      detail: { messages: ["Jira reported a conflict."] },
    }).data;

    expect(data.guidance).toBe(JIRA_REJECTED_GUIDANCE);
  });
});

// #4354 (AC7.2): the validated copy of a succeeded attempt is what the model's result and the log
// are built from. It dropped the notices the executor attached, so they never reached either.
describe("template notices on a validated attempt", () => {
  const notice = { ruleId: "label-missing", subject: "reviewed", template: "SYN/Task" } as const;
  const receipt = { issueKey: "SYN-1", issueId: "10001" };

  it("keeps them, so the result tells the model what is still missing", () => {
    const attempt = validJiraMutationAttempt(
      { ok: true, receipt, templateNotices: [notice] },
      "jira.edit",
    );
    expect(attempt).toMatchObject({ ok: true, templateNotices: [notice] });
    expect(jiraAttemptToolResult("succeeded", attempt).data).toMatchObject({
      outcome: "succeeded",
      templateNotices: [notice],
    });
  });

  it("adds none to an attempt that had none", () => {
    const attempt = validJiraMutationAttempt({ ok: true, receipt }, "jira.edit");
    expect(attempt).not.toHaveProperty("templateNotices");
  });
});
