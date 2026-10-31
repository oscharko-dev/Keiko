import { describe, expect, it } from "vitest";
import {
  JIRA_MUTATION_DETAIL_LIMITS,
  sanitizeJiraMutationFailureDetail,
} from "./jira-tool-execution.js";

const ENCODER = new TextEncoder();
function encodedBytes(value: unknown): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}
function messageBytes(text: string): number {
  return encodedBytes(text) - 2;
}

describe("sanitizeJiraMutationFailureDetail byte bound (#4176)", () => {
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
