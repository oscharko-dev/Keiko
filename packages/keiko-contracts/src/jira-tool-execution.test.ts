import { describe, expect, it } from "vitest";
import {
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_LINKS_MAX,
  JIRA_AVATAR_MUTATIONS,
  JIRA_AVATAR_UPLOAD_MUTATIONS,
  isJiraAvatarUploadOperation,
  sanitizeJiraMutationFailureDetail,
  sanitizeJiraMutationLinkAccount,
} from "./jira-tool-execution.js";

const ENCODER = new TextEncoder();

describe("canonical avatar upload identities", () => {
  it("binds file review to exactly the five fixed raw upload tools", () => {
    expect([...JIRA_AVATAR_UPLOAD_MUTATIONS]).toEqual([
      "jira.upload-temporary-avatar", "jira.upload-issue-type-avatar", "jira.upload-project-avatar",
      "jira.upload-owned-avatar", "jira.upload-user-avatar",
    ]);
    for (const name of JIRA_AVATAR_MUTATIONS)
      expect(isJiraAvatarUploadOperation(name)).toBe(name.startsWith("jira.upload-"));
    expect(isJiraAvatarUploadOperation("jira.upload-avatar-arbitrary")).toBe(false);
    expect(Reflect.set(JIRA_AVATAR_UPLOAD_MUTATIONS, "0", "jira.upload-avatar-arbitrary")).toBe(false);
    expect(Reflect.set(JIRA_AVATAR_MUTATIONS, "0", "jira.upload-avatar-arbitrary")).toBe(false);
  });
});
function encodedBytes(value: unknown): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}
function messageBytes(text: string): number {
  return encodedBytes(text) - 2;
}

describe("sanitizeJiraMutationFailureDetail byte bound (#4176)", () => {
  it("keeps only the literal true acknowledgement of an unchanged state", () => {
    expect(sanitizeJiraMutationFailureDetail({ unchanged: true })).toEqual({ unchanged: true });
    for (const unchanged of [false, "true", 1, {}, null])
      expect(sanitizeJiraMutationFailureDetail({ unchanged })).toBeUndefined();
  });
  it.each([
    ["quotes", '"'.repeat(400)],
    ["backslashes", "\\".repeat(400)],
    ["CJK", "字".repeat(400)],
    ["astral", "😀".repeat(400)],
    ["ASCII", "x".repeat(400)],
  ])("cuts %s messages to the JSON-encoded byte bound on code points", (_name, text) => {
    const detail = sanitizeJiraMutationFailureDetail({ messages: [text] });
    const message = detail?.messages?.[0] ?? "";
    expect(message.endsWith("…")).toBe(true);
    expect(messageBytes(message)).toBeLessThanOrEqual(JIRA_MUTATION_DETAIL_LIMITS.messageBytes);
    expect(messageBytes(message)).toBeGreaterThan(JIRA_MUTATION_DETAIL_LIMITS.messageBytes - 8);
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(message.length).toBeLessThanOrEqual(JIRA_MUTATION_DETAIL_LIMITS.messageChars);
  });

  it("keeps a message exactly at the byte bound unchanged", () => {
    const text = "字".repeat(66) + "xx";
    expect(messageBytes(text)).toBe(JIRA_MUTATION_DETAIL_LIMITS.messageBytes);
    expect(sanitizeJiraMutationFailureDetail({ messages: [text] })).toEqual({ messages: [text] });
  });

  it("keeps the largest detail inside the single-write result bound", () => {
    const hostile = '"\\字'.repeat(200);
    const detail = sanitizeJiraMutationFailureDetail({
      fieldId: `customfield_${"9".repeat(16)}`,
      validation: "bounds-exceeded",
      fieldErrors: Array.from({ length: 20 }, () => ({
        fieldId: `a${"b".repeat(63)}`,
        message: hostile,
      })),
      messages: Array.from({ length: 10 }, () => hostile),
    });
    expect(detail?.fieldErrors).toHaveLength(JIRA_MUTATION_DETAIL_LIMITS.fieldErrors);
    expect(detail?.messages).toHaveLength(JIRA_MUTATION_DETAIL_LIMITS.messages);
    const result = { outcome: "failed", reason: "field-validation", ...detail };
    expect(encodedBytes(result)).toBeLessThan(4096);
  });
});

describe("sanitizeJiraMutationLinkAccount (#4176)", () => {
  const missing = { type: "Relates", direction: "outward", issueKey: "SYN-2" };
  const account = { requested: 2, created: 1, missing: [missing], unconfirmed: false };

  it("keeps a well-formed account and only its own fields", () => {
    expect(sanitizeJiraMutationLinkAccount({ ...account, extra: "dropped" })).toEqual(account);
  });

  it.each([
    ["a non-object", "links"],
    ["a count beyond the bound", { ...account, requested: JIRA_MUTATION_LINKS_MAX + 1 }],
    ["more created than requested", { ...account, created: 3 }],
    ["a fractional count", { ...account, requested: 1.5 }],
    ["a missing flag that is not boolean", { ...account, unconfirmed: "no" }],
    ["more missing links than requested", { ...account, missing: [missing, missing, missing] }],
    ["a link with a bad side", { ...account, missing: [{ ...missing, direction: "both" }] }],
    ["a link with a bad key", { ...account, missing: [{ ...missing, issueKey: "not a key" }] }],
    [
      "a link type with a control character",
      { ...account, missing: [{ ...missing, type: "a\n" }] },
    ],
    ["a link that is not an object", { ...account, missing: ["SYN-2"] }],
  ])("refuses %s", (_name, value) => {
    expect(sanitizeJiraMutationLinkAccount(value)).toBeUndefined();
  });
});
