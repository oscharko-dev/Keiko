import { describe, expect, it } from "vitest";
import {
  checkProperty,
  propertySettings,
  shrinkString,
  unicodeString,
} from "../../../tests/support/property-testing.js";
import {
  decodeWorkspaceIndexContent,
  encodeWorkspaceIndexContent,
  MAX_WORKSPACE_INDEX_CONTENT_BYTES,
  normalizeWorkspaceIndexContent,
  workspaceIndexContentPolicyFingerprint,
  type WorkspaceIndexRecordContent,
} from "./workspaceIndexContent.js";

function encoded(text: string): WorkspaceIndexRecordContent {
  const content = encodeWorkspaceIndexContent(text);
  if (content === undefined) throw new TypeError("Expected the text to fit the content bound");
  return content;
}

describe("workspace index content payload (#4457)", () => {
  it("restores exactly the stored lane text", () => {
    const text = "export const a = 1;\r\n// Ünïcödé — 🚀\n\n";
    expect(decodeWorkspaceIndexContent(encoded(text))).toBe(text);
    expect(decodeWorkspaceIndexContent(encoded(""))).toBe("");
  });

  it("refuses a payload whose digest, size or bytes no longer match", () => {
    const content = encoded("Vesper furnace temperature\n");
    expect(decodeWorkspaceIndexContent({ ...content, sha256: "0".repeat(64) })).toBeUndefined();
    expect(decodeWorkspaceIndexContent({ ...content, bytes: content.bytes + 1 })).toBeUndefined();
    expect(decodeWorkspaceIndexContent({ ...content, deflated: "AAAA" })).toBeUndefined();
    const other = encoded("other").deflated;
    expect(decodeWorkspaceIndexContent({ ...content, deflated: other })).toBeUndefined();
  });

  it("does not store a text above the inflation bound", () => {
    const oversized = "a".repeat(MAX_WORKSPACE_INDEX_CONTENT_BYTES + 1);
    expect(encodeWorkspaceIndexContent(oversized)).toBeUndefined();
  });

  it("normalizes only well-formed payloads", () => {
    const content = encoded("text");
    expect(normalizeWorkspaceIndexContent(JSON.parse(JSON.stringify(content)))).toEqual(content);
    for (const malformed of [
      undefined,
      null,
      "text",
      { ...content, sha256: "ABC" },
      { ...content, bytes: -1 },
      { ...content, bytes: 1.5 },
      { ...content, bytes: MAX_WORKSPACE_INDEX_CONTENT_BYTES + 1 },
      { ...content, deflated: "not base64!" },
      { sha256: content.sha256, bytes: content.bytes },
    ])
      expect(normalizeWorkspaceIndexContent(malformed)).toBeUndefined();
  });

  it("keys the stored text by redaction revision, policy and the set of secrets", () => {
    const base = workspaceIndexContentPolicyFingerprint(8, "preserve", ["alpha", "beta"]);
    expect(workspaceIndexContentPolicyFingerprint(8, "preserve", ["beta", "alpha", "beta"])).toBe(
      base,
    );
    expect(workspaceIndexContentPolicyFingerprint(9, "preserve", ["alpha", "beta"])).not.toBe(base);
    expect(workspaceIndexContentPolicyFingerprint(8, "redact", ["alpha", "beta"])).not.toBe(base);
    expect(workspaceIndexContentPolicyFingerprint(8, "preserve", ["alpha"])).not.toBe(base);
    // Framing keeps adjacent secrets from colliding with one concatenated secret.
    expect(workspaceIndexContentPolicyFingerprint(8, "preserve", ["alphabeta"])).not.toBe(base);
  });

  it("round-trips arbitrary lane text through the persisted shape", async () => {
    const name = "workspace index content round trip";
    let nonAscii = 0;
    await checkProperty({
      name,
      generate: unicodeString(400),
      shrink: shrinkString,
      property: (text) => {
        // Independent oracle: UTF-8 carries the text unchanged.
        if (Buffer.from(text, "utf8").toString("utf8") !== text) {
          expect(encodeWorkspaceIndexContent(text)).toBeUndefined();
          return;
        }
        if (/[^\p{ASCII}]/u.test(text)) nonAscii += 1;
        const stored = normalizeWorkspaceIndexContent(JSON.parse(JSON.stringify(encoded(text))));
        expect(stored).toBeDefined();
        if (stored !== undefined) expect(decodeWorkspaceIndexContent(stored)).toBe(text);
      },
    });
    // Guard against vacuity: an eighth of the runs must reach well-formed non-ASCII text.
    expect(nonAscii).toBeGreaterThan(propertySettings({ name }).runs / 8);
  });

  it("refuses text that UTF-8 cannot carry unchanged", () => {
    expect(encodeWorkspaceIndexContent("before \ud800 after")).toBeUndefined();
    expect(encodeWorkspaceIndexContent("trailing \udc00")).toBeUndefined();
    expect(decodeWorkspaceIndexContent(encoded("paired 🚀 stays"))).toBe("paired 🚀 stays");
  });
});
