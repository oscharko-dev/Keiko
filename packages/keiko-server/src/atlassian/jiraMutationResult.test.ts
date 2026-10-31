import { describe, expect, it } from "vitest";
import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraAttemptToolResult,
  jiraLinkCounts,
  jiraLinkCountsOfResult,
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
