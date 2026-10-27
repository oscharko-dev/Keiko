// #4098: only a workspace Chat builds under the deployment opt-out (`contentRedaction: "preserve"`)
// reads authorized content unmasked. Every other consumer — the Coding Workbench, its repository
// search, run evidence — keeps the default projection, and the workspace package never reads the
// deployment environment itself.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import { detectWorkspaceAt } from "./detect.js";
import { extractDocumentContext } from "./document-extraction.js";
import { readWorkspaceFile, readWorkspaceFileTextForInternalUse } from "./discovery.js";
import { nodeWorkspaceFs } from "./fs.js";
import { memFs } from "./_memfs.js";
import { readExcerpt, searchText } from "./repoSearch.js";
import { redactWorkspaceSource } from "./sourceRedaction.js";
import { buildWorkspaceIndexScopeKey } from "./workspaceIndex.js";

const ROOT = "/workspace";
const ISSUER_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const DOCUMENT = [
  "Customer contact: +49 30 12345678",
  "Account: DE89 3704 0044 0532 0130 00",
  "Basic authentication is supported.",
  'password: "customer-owned-example"',
  "",
].join("\n");
// The default projection reads this one; the full DOCUMENT above it refuses outright.
const READABLE_DOCUMENT = [
  "Customer contact: +49 30 12345678",
  "Account: DE89 3704 0044 0532 0130 00",
  'password: "customer-owned-example"',
  "",
].join("\n");
const BUDGET = { perDocBytes: 65_536, totalBudgetUsedBytes: 0, totalBudgetBytes: 262_144 };

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function diskWorkspace(files: Readonly<Record<string, string>>): {
  readonly redact: ReturnType<typeof detectWorkspaceAt>;
  readonly preserve: ReturnType<typeof detectWorkspaceAt>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-content-policy-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const redact = detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false });
  return { redact, preserve: { ...redact, contentRedaction: "preserve" } };
}

describe("Chat-only content preservation in the evidence lane", () => {
  it("preserves connected file text and source syntax for a preserving workspace", () => {
    const source = 'public class Example { String password = "customer-owned-example"; }\n';
    const fs = memFs(ROOT, { "customer.txt": DOCUMENT, "Example.java": source, ".env": "private" });
    const workspace = { ...detectWorkspaceAt(ROOT, fs), contentRedaction: "preserve" as const };
    expect(readWorkspaceFile(workspace, "customer.txt", undefined, fs).text).toBe(DOCUMENT);
    expect(readWorkspaceFile(workspace, "Example.java", undefined, fs).text).toBe(source);
    expect(() => readWorkspaceFile(workspace, "../outside.txt", undefined, fs)).toThrow();
    expect(() => readWorkspaceFile(workspace, ".env", undefined, fs)).toThrow();
  });

  it("keeps the default projection for every workspace that does not ask, whatever the environment", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const fs = memFs(ROOT, { "customer.txt": DOCUMENT, "readable.txt": READABLE_DOCUMENT });
    const workspace = detectWorkspaceAt(ROOT, fs);
    const text = readWorkspaceFile(workspace, "readable.txt", undefined, fs).text;
    expect(text).not.toContain("+49 30 12345678");
    expect(text).not.toContain("customer-owned-example");
    // The customer incident: the default projection refuses the whole document.
    expect(() => readWorkspaceFile(workspace, "customer.txt", undefined, fs)).toThrow(
      "code source redaction is unavailable",
    );
  });

  it("still removes credential shapes from preserved content", () => {
    const fs = memFs(ROOT, { "notes.txt": `token ${ISSUER_TOKEN}\nphone 030 12345678\n` });
    const workspace = { ...detectWorkspaceAt(ROOT, fs), contentRedaction: "preserve" as const };
    const text = readWorkspaceFile(workspace, "notes.txt", undefined, fs).text;
    expect(text).toBe("token [REDACTED]\nphone 030 12345678\n");
  });

  it("applies the workspace policy to internal reads, search hits and excerpts", async () => {
    const { redact, preserve } = diskWorkspace({ "customer.txt": READABLE_DOCUMENT });
    for (const [workspace, kept] of [
      [preserve, true],
      [redact, false],
    ] as const) {
      const internal = readWorkspaceFileTextForInternalUse(
        workspace,
        "customer.txt",
        { maxBytes: 65_536 },
        nodeWorkspaceFs,
        "evidence",
      ).content;
      expect(internal.includes("+49 30 12345678")).toBe(kept);
      const scope = { workspace, scopeId: "content-policy", relativePaths: ["customer.txt"] };
      const result = await searchText(scope, {
        kind: "exact-symbol",
        text: "customer-owned-example",
        caseSensitive: true,
        maxResults: 10,
        emittedAtMs: 0,
      });
      expect(result.atoms.length > 0).toBe(kept);
      const excerpt = await readExcerpt(scope, {
        scopePath: "customer.txt",
        startLine: 1,
        endLine: 3,
        maxBytes: 4096,
      });
      expect(excerpt.content.includes("customer-owned-example")).toBe(kept);
    }
  });

  it("keeps physical line coordinates after a removed private key block", () => {
    // A synthetic key block, split so no credential-shaped literal is contiguous in the source.
    const key = [
      "-----BEGIN RSA " + "PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "-----END RSA " + "PRIVATE KEY-----",
    ].join("\n");
    const text = `line1\n${key}\nline6\nline7\n`;
    const preserved = redactWorkspaceSource(text, "notes.txt", true, "preserve");
    expect(preserved.split("\n")).toHaveLength(text.split("\n").length);
    expect(preserved.split("\n")[4]).toBe("line6");
    expect(preserved).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("projects source without a parser under the opt-out instead of refusing it", () => {
    const source = 'class Example { string password = @"private-first""private-second"; }';
    expect(() => redactWorkspaceSource(source, "source.cs")).toThrow(
      "code source redaction is unavailable",
    );
    expect(redactWorkspaceSource(source, "source.cs", true, "preserve")).toBe(source);
  });
});

describe("attached document extraction", () => {
  it("keeps the default projection whatever the deployment environment says", async () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const fs = memFs(ROOT, { "readable.txt": READABLE_DOCUMENT });
    const extracted = await extractDocumentContext(fs, ROOT, "readable.txt", BUDGET);
    if (!extracted.ok) throw new Error("Document extraction failed");
    expect(extracted.context.text).not.toContain("+49 30 12345678");
    expect(extracted.context.text).not.toContain("customer-owned-example");
  });
});

describe("consumers outside Chat", () => {
  it("keeps Coding repository search excerpts redacted under the deployment opt-out", () => {
    vi.stubEnv("KEIKO_CONTENT_REDACTION", "off");
    const hit = codingRepositoryExcerpt("customer.txt", DOCUMENT, 1, 4, 4096);
    expect(hit.snippet).not.toContain("+49 30 12345678");
    expect(hit.snippet).not.toContain("customer-owned-example");
  });

  it("stores a preserving Chat index apart from every default index", () => {
    const { redact, preserve } = diskWorkspace({ "customer.txt": DOCUMENT });
    const policy = {
      policyMode: "workspace-root-default" as const,
      applyGitignore: true,
      omitLowValueWorkspaceFiles: true,
    };
    const scope = { workspace: redact, relativePaths: ["."] };
    const defaultKey = buildWorkspaceIndexScopeKey(scope, policy, 65_536, 2048);
    const preserveKey = buildWorkspaceIndexScopeKey(
      { ...scope, workspace: preserve },
      policy,
      65_536,
      2048,
    );
    expect(defaultKey).not.toHaveProperty("contentRedaction");
    expect(preserveKey).toEqual({ ...defaultKey, contentRedaction: "preserve" });
  });
});
