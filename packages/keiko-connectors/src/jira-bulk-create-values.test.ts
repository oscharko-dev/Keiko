import { describe, expect, it } from "vitest";
import {
  BULK_CREATE_ARGUMENTS,
  BULK_CREATE_RECEIPT,
} from "../../../tests/support/jira-bulk-create-fixture.js";
import {
  jiraBulkCreateAcknowledgement,
  parseJiraBulkCreateInput,
} from "./jira-bulk-create-values.js";

const BASE = { userKey: "synthetic-actor", requestedIssueCount: 2 };
describe("native bulk acknowledgement identity without positional attribution", () => {
  it("retains exact int64 IDs and native success order without assigning input indices", () => {
    const result = jiraBulkCreateAcknowledgement(
      {
        issues: [
          { id: "9223372036854775807", key: "SYN-2" },
          { id: "10001", key: "SYN-1" },
        ],
        errors: [],
      },
      BASE,
    );
    expect(result.valid).toBe(true);
    expect(result.receipt).toEqual({
      ...BULK_CREATE_RECEIPT,
      issueIds: ["9223372036854775807", "10001"],
      issueKeys: ["SYN-2", "SYN-1"],
    });
    expect(result.receipt).not.toHaveProperty("itemIndices");
    expect(Object.isFrozen(result.receipt.issueIds)).toBe(true);
  });
  it("preserves literal failedElementNumber zero and native field guidance without index-base inference", () => {
    const result = jiraBulkCreateAcknowledgement(
      {
        issues: [{ id: "10001", key: "SYN-1" }],
        errors: [
          {
            failedElementNumber: 0,
            status: 400,
            elementErrors: { errors: { summary: "Summary is required" }, errorMessages: [] },
          },
        ],
      },
      BASE,
    );
    expect(result.valid).toBe(true);
    expect(result.receipt).toEqual({
      ...BASE,
      issueIds: ["10001"],
      issueKeys: ["SYN-1"],
      bulkFailedElementNumbers: [0],
      bulkFailureStatuses: [400],
    });
    expect(result.detail?.messages).toEqual([
      "Native failedElementNumber 0, status 400: summary: Summary is required",
    ]);
  });
  it("retains bounded known identities when a sibling ACK row is malformed", () => {
    const result = jiraBulkCreateAcknowledgement(
      {
        issues: [
          { id: "10001", key: "SYN-1" },
          { id: 9007199254740992, key: "SYN-2" },
        ],
        errors: [],
      },
      BASE,
    );
    expect(result.valid).toBe(false);
    expect(result.receipt).toEqual({ ...BASE, issueIds: ["10001"], issueKeys: ["SYN-1"] });
  });
  it.each([
    { issues: [], errors: [] },
    {
      issues: [
        { id: "10001", key: "SYN-1" },
        { id: "10001", key: "SYN-1" },
      ],
      errors: [],
    },
    { issues: [{ id: "10001", key: "SYN-1" }], errors: [{ failedElementNumber: 1, status: 200 }] },
    {
      issues: [],
      errors: [
        { failedElementNumber: 1, status: 400 },
        { failedElementNumber: 1, status: 400 },
      ],
    },
    { issues: [{ id: "10001", key: "SYN-1" }] },
  ])("never treats missing or contradictory bulk accounting as complete: %j", (body) => {
    expect(jiraBulkCreateAcknowledgement(body, BASE).valid).toBe(false);
  });
  it("refuses foreign self identity but accepts proxy-origin metadata without following it", () => {
    const other = { id: "9223372036854775807", key: "SYN-2" };
    const invalid = jiraBulkCreateAcknowledgement(
      {
        issues: [
          { id: "10001", key: "SYN-1", self: "https://other.invalid/rest/api/2/issue/99" },
          other,
        ],
        errors: [],
      },
      BASE,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.receipt.issueIds).toEqual([other.id]);
    const proxy = jiraBulkCreateAcknowledgement(
      {
        issues: [
          {
            id: "10001",
            key: "SYN-1",
            self: "http://proxy.invalid/context/rest/api/2/issue/10001",
          },
          other,
        ],
        errors: [],
      },
      BASE,
    );
    expect(proxy.valid).toBe(true);
    expect(proxy.receipt).not.toHaveProperty("self");
  });
  it("admits closed common trace references, not per-item or raw native controls", () => {
    expect(
      parseJiraBulkCreateInput({ ...BULK_CREATE_ARGUMENTS, requirementIds: ["REQ-1"] })
        ?.requirementIds,
    ).toEqual(["REQ-1"]);
    expect(
      parseJiraBulkCreateInput({
        ...BULK_CREATE_ARGUMENTS,
        issues: [{ ...BULK_CREATE_ARGUMENTS.issues[0], requirementIds: ["REQ-1"] }],
      }),
    ).toBeUndefined();
    expect(
      parseJiraBulkCreateInput({
        ...BULK_CREATE_ARGUMENTS,
        issues: [BULK_CREATE_ARGUMENTS.issues[0], BULK_CREATE_ARGUMENTS.issues[0]],
      }),
    ).toBeUndefined();
    expect(
      parseJiraBulkCreateInput({ ...BULK_CREATE_ARGUMENTS, issueUpdates: [] }),
    ).toBeUndefined();
  });
});
