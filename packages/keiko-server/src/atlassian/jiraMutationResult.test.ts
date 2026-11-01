import { describe, expect, it } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
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
