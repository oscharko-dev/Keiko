import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedToolCatalogManifest } from "../check-tool-catalog-conformance.mjs";
import { readReceipts } from "../check-coding-issue-journey-evidence.mjs";
import { sha256 } from "../lib/digest.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";
import {
  buildToolCatalogCloseout,
  validateToolCatalogCloseout,
  CATALOG_CLOSEOUT_CHECKS,
  CATALOG_CLOSEOUT_CONSUMERS,
  catalogCloseoutHead,
  readCatalogCloseoutReceipts,
  requireExternalManifest,
} from "../check-tool-catalog-closeout.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const producer = await generatedToolCatalogManifest();
  const binding = {
    catalogRevision: producer.catalogRevision,
    profile: producer.profile,
    projectionDigest: producer.projectionDigest,
    // Opaque fixture receipt; these are artifact-joining tests, never live binding evidence.
    handlerSetDigest: sha256("unit fixture handler identity"),
  };
  const context = {
    currentHead: "a".repeat(40),
    artifactDigest: sha256("unit fixture package"),
    h1EvidenceRef: "h1-provenance.v1",
    h1EvidenceDigest: sha256("unit fixture H1 receipt"),
    h1Binding: binding,
    platform: "darwin-arm64",
    runtime: { node: "26.8.1", product: "0.3.17" },
  };
  const root = mkdtempSync(join(tmpdir(), "keiko-catalog-closeout-"));
  roots.push(root);
  const reports = new Map();
  for (const id of CATALOG_CLOSEOUT_CHECKS) {
    const consumer = CATALOG_CLOSEOUT_CONSUMERS.includes(id);
    const report = {
      schemaVersion: 1,
      currentHead: context.currentHead,
      artifactDigest: context.artifactDigest,
      platform: context.platform,
      runtime: context.runtime,
      executionKind:
        id === "managed-opencode"
          ? "real-runtime"
          : consumer
            ? "production-composition"
            : "qualification-gate",
      status: "passed",
      passed: 1,
      failed: 0,
      skipped: 0,
      binding: consumer ? binding : null,
    };
    reports.set(id, structuredClone(report));
    writeFileSync(join(root, `${id}.artifact`), JSON.stringify(report));
    writeFileSync(
      join(root, `${id}.receipt.json`),
      JSON.stringify({
        scenarioId: id,
        commitSha: context.currentHead,
        platform: context.platform,
        testStatus: "passed",
      }),
    );
  }
  const receipts = readReceipts(root);
  return {
    context,
    reports,
    receipts,
    root,
    manifest: buildToolCatalogCloseout(context, receipts, reports),
  };
}
function check(f) {
  return validateToolCatalogCloseout(f.manifest, f.context, f.receipts, f.reports);
}

describe("exact-head catalog closeout artifact", () => {
  it("refuses untracked source files and tracked edits when claiming a clean head", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-closeout-clean-"));
    roots.push(root);
    const git = (...args) =>
      execFileSync(resolveHostExecutable("git"), args, { cwd: root, stdio: "pipe" });
    git("init", "--quiet");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, "owner.ts"), "export const bounded = true;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    const head = catalogCloseoutHead(root);
    expect(head).toMatch(/^[a-f0-9]{40}$/u);
    writeFileSync(join(root, "untracked-schema.ts"), "export const extra = true;\n");
    expect(() => catalogCloseoutHead(root)).toThrow("source checkout is not clean");
    rmSync(join(root, "untracked-schema.ts"));
    writeFileSync(join(root, "owner.ts"), "export const bounded = false;\n");
    expect(() => catalogCloseoutHead(root)).toThrow("source checkout is not clean");
  });
  it("forbids source-tree manifest writes including symlink redirection", async () => {
    const f = await fixture();
    const external = mkdtempSync(join(tmpdir(), "keiko-closeout-output-"));
    roots.push(external);
    expect(() => requireExternalManifest(f.root, join(f.root, "manifest.json"))).toThrow(
      "outside the source checkout",
    );
    symlinkSync(f.root, join(external, "source-link"), "dir");
    expect(() =>
      requireExternalManifest(f.root, join(external, "source-link", "manifest.json")),
    ).toThrow("outside the source checkout");
    expect(() => requireExternalManifest(f.root, join(external, "manifest.json"))).not.toThrow();
  });
  it("parses exactly the artifact bytes that the shared receipt reader hashed", async () => {
    const f = await fixture();
    const snapshot = readCatalogCloseoutReceipts(f.root);
    const bytes = JSON.stringify(snapshot.reports.get("editor"));
    expect(snapshot.receipts.get("editor").digest).toBe(sha256(bytes));
    writeFileSync(
      join(f.root, "editor.artifact"),
      JSON.stringify({ ...snapshot.reports.get("editor"), passed: 2 }),
    );
    expect(readCatalogCloseoutReceipts(f.root)).not.toEqual(snapshot);
    expect(snapshot.reports.get("editor").passed).toBe(1);
  });
  it("preserves a source-only Linux CI check without claiming it tested the local package", async () => {
    const f = await fixture();
    Object.assign(f.reports.get("required-ci"), {
      platform: "linux-x64",
      artifactDigest: null,
      runtime: { node: "24.18.0", product: f.context.runtime.product },
    });
    f.receipts.get("required-ci").platform = "linux-x64";
    const manifest = buildToolCatalogCloseout(f.context, f.receipts, f.reports);
    expect(manifest.checks.find((entry) => entry.id === "required-ci")).toMatchObject({
      platform: "linux-x64",
      artifactDigest: null,
      runtime: { node: "24.18.0" },
    });
    expect(manifest.platform).toBe("darwin-arm64");
  });
  it("joins the real producer identity with byte-hashed receipt artifacts", async () => {
    const f = await fixture();
    expect(check(f)).toEqual(f.manifest);
    expect(f.manifest.checks.find((entry) => entry.id === "managed-opencode").receiptDigest).toBe(
      f.receipts.get("managed-opencode").digest,
    );
    expect(JSON.stringify(f.manifest)).not.toContain(f.root);
  });
  it.each(["currentHead", "artifactDigest", "platform", "runtime"])(
    "rejects a report with stale %s",
    async (field) => {
      const f = await fixture();
      f.reports.get("editor")[field] = "stale";
      expect(() => check(f)).toThrow(`editor has stale ${field}`);
    },
  );
  it.each(["skipped", "failed", "unreachable"])("rejects a %s receipt", async (status) => {
    const f = await fixture();
    f.receipts.get("editor").testStatus = status;
    expect(() => check(f)).toThrow("editor receipt did not pass");
  });
  it("rejects missing mandatory consumer proof", async () => {
    const f = await fixture();
    f.receipts.delete("read-only-child");
    expect(() => check(f)).toThrow("read-only-child has no receipt");
  });
  it.each(["scripted", "mocked", "production-composition"])(
    "refuses %s as real OpenCode proof",
    async (kind) => {
      const f = await fixture();
      f.reports.get("managed-opencode").executionKind = kind;
      expect(() => check(f)).toThrow("managed-opencode is not production qualification evidence");
    },
  );
  it("rejects partial, skipped or empty consumer tests", async () => {
    for (const mutation of [{ failed: 1 }, { skipped: 1 }, { passed: 0 }]) {
      const f = await fixture();
      Object.assign(f.reports.get("editor"), mutation);
      expect(() => check(f)).toThrow();
    }
  });
  it("rejects an H1 handler binding that differs from actual consumer evidence", async () => {
    const f = await fixture();
    f.context.h1Binding = { ...f.context.h1Binding, handlerSetDigest: "b".repeat(64) };
    expect(() => check(f)).toThrow("H1 and managed consumer identities differ");
  });
  it("rejects a byte-modified receipt artifact even when the report still passes", async () => {
    const f = await fixture();
    writeFileSync(
      join(f.root, "editor.artifact"),
      JSON.stringify(f.reports.get("editor"), null, 2),
    );
    f.receipts = readReceipts(f.root);
    expect(() => check(f)).toThrow("manifest differs from current qualified evidence");
  });
  it("rejects foreign receipt heads and incomplete body-free schemas", async () => {
    const f = await fixture();
    f.receipts.get("editor").commitSha = "b".repeat(40);
    expect(() => check(f)).toThrow("editor receipt has stale head");
    f.receipts.get("editor").commitSha = f.context.currentHead;
    f.reports.get("editor").privatePrompt = "private fixture body";
    expect(() => check(f)).toThrow("unexpected evidence fields");
  });
  it("rejects manifest field injection, migration residue and omitted checks", async () => {
    for (const mutation of [
      { privateRoot: "/private/fixture" },
      { migrationCount: 1 },
      { checks: [] },
    ]) {
      const f = await fixture();
      Object.assign(f.manifest, mutation);
      expect(() => check(f)).toThrow();
    }
  });
});
