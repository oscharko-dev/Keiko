import { afterEach, describe, expect, it, vi } from "vitest";
import { extractDocumentContext } from "./document-extraction.js";
import { memFs } from "./_memfs.js";
import { readWorkspaceFile } from "./discovery.js";
import { detectWorkspaceAt } from "./detect.js";

const ROOT = "/workspace";
const DOCUMENT = [
  "Customer contact: +49 30 12345678",
  "Account: DE89 3704 0044 0532 0130 00",
  "Basic authentication is supported.",
  'password: "customer-owned-example"',
  "",
].join("\n");

afterEach(() => vi.unstubAllEnvs());

describe("operator-selected content preservation", () => {
  it("preserves attached document text when content redaction is disabled", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const fs = memFs(ROOT, { "customer.txt": DOCUMENT });
    const result = await extractDocumentContext(fs, ROOT, "customer.txt", {
      perDocBytes: 65_536,
      totalBudgetUsedBytes: 0,
      totalBudgetBytes: 262_144,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Document extraction failed");
    expect(result.context.text).toBe(DOCUMENT.trimEnd());
  });

  it("preserves connected file text and source syntax when disabled", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const source = 'public class Example { String password = "customer-owned-example"; }\n';
    const fs = memFs(ROOT, { "customer.txt": DOCUMENT, "Example.java": source, ".env": "private" });
    const workspace = detectWorkspaceAt(ROOT, fs);
    expect(readWorkspaceFile(workspace, "customer.txt", undefined, fs).text).toBe(DOCUMENT);
    expect(readWorkspaceFile(workspace, "Example.java", undefined, fs).text).toBe(source);
    expect(() => readWorkspaceFile(workspace, "../outside.txt", undefined, fs)).toThrow();
    expect(() => readWorkspaceFile(workspace, ".env", undefined, fs)).toThrow();
  });

  it.each([undefined, "on", "false", "invalid"])(
    "retains redaction unless explicitly disabled (%s)",
    async (setting) => {
      vi.stubEnv("KEIKO_CONTENT_REDACTION", setting);
      const fs = memFs(ROOT, { "customer.txt": DOCUMENT });
      const result = await extractDocumentContext(fs, ROOT, "customer.txt", {
        perDocBytes: 65_536,
        totalBudgetUsedBytes: 0,
        totalBudgetBytes: 262_144,
      });
      if (!result.ok) throw new Error("Document extraction failed");
      const text = result.context.text;
      expect(text).not.toContain("+49 30 12345678");
      expect(text).not.toContain("customer-owned-example");
    },
  );
});
