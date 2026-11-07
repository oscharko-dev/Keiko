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

describe("Agile entity and membership receipts", () => {
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
  it("names the existing key and tells the model to report it, not to correct and resend", () => {
    const message =
      "SYN-4 already exists as this issue: a Keiko draft created it in this project with this type and summary. Nothing was created. Report SYN-4 as the result; do not create it again.";
    const result = jiraAttemptToolResult("rejected", {
      ok: false,
      reason: "conflict",
      receipt: { issueKey: "SYN-4", issueId: "10004" },
      detail: { messages: [message] },
    });

    expect(result).toEqual({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "conflict",
        issueKey: "SYN-4",
        issueId: "10004",
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
