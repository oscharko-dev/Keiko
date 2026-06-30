// Regression test for the Issue #1325 local-state audit. It runs under the package coverage vitest
// config (which includes `scripts/__tests__/**/*.test.mjs` with `--experimental-sqlite`), so it is
// part of the required `ci` gate. It proves:
//   - a GENUINELY-encrypted fixture `.keiko` tree passes every confidentiality-class check (AC3);
//   - deliberately drifted state (plaintext credential, loosened file mode) is detected (AC3);
//   - `keiko repair --dry-run` reports a healthy state clean and flags the same drift (AC4).
// The fixture is built with the real workspace store code paths, so the audit cannot drift from the
// implementation it verifies.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runRepairCli } from "@oscharko-dev/keiko-cli";
import { sealString } from "@oscharko-dev/keiko-security";

import { auditLocalState } from "../lib/local-state-audit.mjs";
import { createDriftedFixture, createHealthyFixture } from "../lib/local-state-fixture.mjs";

// Builds a minimal SQLite file at `path` from raw DDL/DML. Used to craft store-shaped databases that
// exercise the auditor's failure branches directly (a plaintext content column, a missing encryption
// marker) without the full store schema or its foreign-key chain.
function craftDb(path, statements) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    for (const sql of statements) db.exec(sql);
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
}

function freshStateDir(name) {
  const dir = join(root, name, ".keiko");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const SEALED_PROBE = sealString(Buffer.alloc(32, 1), "content_encryption_probe");
const SEALED_SECRET = sealString(Buffer.alloc(32, 2), "provider-secret");

function sha256OfJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeConfigWithRef(stateDir, ref = "cred:m") {
  writeFileSync(
    join(stateDir, "keiko.config.json"),
    JSON.stringify({ providers: [{ modelId: "m", apiKeySecretRef: ref }] }),
    { mode: 0o600 },
  );
}

function writeProviderVault(stateDir, content) {
  const dir = join(stateDir, "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload =
    typeof content === "string"
      ? content
      : JSON.stringify(Object.hasOwn(content, "version") ? content : { version: 1, ...content });
  writeFileSync(join(dir, "provider-credentials.vault"), payload, { mode: 0o600 });
}

// Assembles a provider-shaped secret string at runtime from fragments. No contiguous secret literal
// is committed (so GitHub push protection does not flag the test fixtures), yet the joined value
// still matches the auditor's SECRET_PATTERNS so the leak-detection branch is genuinely exercised.
const fake = (...parts) => parts.join("");

let root;

beforeEach(() => {
  // realpathSync resolves the macOS `/var` -> `/private/var` symlink so the credential and Figma
  // vault symlinked-path-segment guards accept the fixture directory.
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-local-state-test-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function classById(result, id) {
  return result.classes.find((c) => c.id === id);
}

function captureRepair(stateDir) {
  // A stub UI static root keeps the install-layout check `ok` so the dry-run exit code reflects only
  // state confidentiality, not whether the dev tree has a built UI export.
  const staticRoot = join(root, "ui-static");
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html>");
  const cleanCwd = join(root, "cwd");
  mkdirSync(cleanCwd, { recursive: true });
  const lines = [];
  const io = {
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
  };
  const code = runRepairCli(
    ["--dry-run", "--state-dir", stateDir, "--config", join(stateDir, "keiko.config.json")],
    io,
    { KEIKO_UI_STATIC_ROOT: staticRoot },
    {
      cwd: cleanCwd,
      homedir: () => cleanCwd,
      isProcessAlive: () => false,
      argv: ["node", "keiko", "repair"],
    },
  );
  return { code, output: lines.join("") };
}

describe("auditLocalState — genuinely-encrypted fixture (#1325 AC3)", () => {
  it("passes every confidentiality class on a healthy fixture", () => {
    const result = auditLocalState(createHealthyFixture(join(root, "healthy", ".keiko")));
    expect(result.ok).toBe(true);
    for (const cls of result.classes) {
      expect(cls.status, `${cls.id}: ${cls.findings.join("; ")}`).not.toBe("fail");
    }
    expect(classById(result, "memory-encryption").status).toBe("pass");
    expect(classById(result, "local-knowledge-encryption").status).toBe("pass");
    expect(classById(result, "evidence-qi").status).toBe("pass");
    expect(classById(result, "credentials").status).toBe("pass");
    expect(classById(result, "file-modes").status).toBe("pass");
    expect(classById(result, "evidence-qi").findings.join(" ")).toContain(
      "1 Figma snapshot record(s)",
    );
    expect(classById(result, "evidence-qi").findings.join(" ")).toContain("1 PE manifest(s)");
    expect(classById(result, "evidence-qi").findings.join(" ")).toContain(
      "1 candidate artifact(s)",
    );
  });

  it("detects a plaintext credential and a loosened file mode on a drifted fixture", () => {
    const result = auditLocalState(createDriftedFixture(join(root, "drifted", ".keiko")));
    expect(result.ok).toBe(false);
    expect(classById(result, "credentials").status).toBe("fail");
    expect(classById(result, "file-modes").status).toBe("fail");
    // The drift is confined to those two classes; encryption of Memory/LK content still holds.
    expect(classById(result, "memory-encryption").status).toBe("pass");
    expect(classById(result, "local-knowledge-encryption").status).toBe("pass");
  });
});

describe("auditLocalState — focused class behaviour", () => {
  it("skips absent stores instead of failing", () => {
    const stateDir = join(root, "empty", ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const result = auditLocalState(stateDir);
    expect(result.ok).toBe(true);
    expect(classById(result, "memory-encryption").status).toBe("skip");
    expect(classById(result, "local-knowledge-encryption").status).toBe("skip");
    expect(classById(result, "evidence-qi").status).toBe("skip");
  });

  it("fails when the gateway config carries a plaintext apiKey", () => {
    const stateDir = join(root, "plain", ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateDir, "keiko.config.json"),
      JSON.stringify({ providers: [{ modelId: "m", apiKey: "sk-plaintext-leak-0123456789" }] }),
      { mode: 0o600 },
    );
    const result = auditLocalState(stateDir);
    expect(result.ok).toBe(false);
    expect(classById(result, "credentials").status).toBe("fail");
  });

  it("fails when a sensitive artifact is group/world-readable", () => {
    if (process.platform === "win32") return;
    const stateDir = join(root, "loose", ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = join(stateDir, "keiko.config.json");
    writeFileSync(configPath, JSON.stringify({ providers: [] }), { mode: 0o600 });
    chmodSync(configPath, 0o644);
    const result = auditLocalState(stateDir);
    expect(result.ok).toBe(false);
    expect(classById(result, "file-modes").status).toBe("fail");
  });
});

describe("keiko repair --dry-run on the fixture (#1325 AC4)", () => {
  it("reports a healthy fixture as clean", () => {
    const { code, output } = captureRepair(createHealthyFixture(join(root, "healthy", ".keiko")));
    expect(output).toContain("[ok] Credential storage");
    expect(output).not.toContain("[action] Credential storage");
    expect(output).not.toContain("[would-fix] Runtime state artifacts");
    expect(code).toBe(0);
  });

  it("flags the drifted fixture: plaintext credentials and loose permissions", () => {
    const { code, output } = captureRepair(createDriftedFixture(join(root, "drifted", ".keiko")));
    expect(output).toContain("[action] Credential storage");
    expect(output).toContain("[would-fix] Runtime state artifacts");
    expect(code).toBe(1);
  });
});

// Mutation-robustness: each audit class has at least one negative case that drives it to `fail`, so
// deleting or weakening a check in local-state-audit.mjs is caught by a red test.
describe("auditLocalState — per-class failure detection", () => {
  it("credentials: detects a plaintext figma accessToken", () => {
    const stateDir = freshStateDir("figma-leak");
    writeFileSync(
      join(stateDir, "keiko.config.json"),
      JSON.stringify({ figma: { accessToken: "plaintext-figma-token-placeholder" } }),
      { mode: 0o600 },
    );
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "credentials").status).toBe(
      "fail",
    );
  });

  it("credentials: detects a referenced secret with no vault", () => {
    const stateDir = freshStateDir("orphan-ref");
    writeConfigWithRef(stateDir);
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("missing");
  });

  it("credentials: detects a malformed provider credential vault", () => {
    const stateDir = freshStateDir("malformed-vault");
    writeConfigWithRef(stateDir);
    writeProviderVault(stateDir, "{not-json");
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("not valid JSON");
  });

  it("credentials: validates an existing provider vault even when config has no refs", () => {
    const stateDir = freshStateDir("malformed-unreferenced-vault");
    writeFileSync(join(stateDir, "keiko.config.json"), JSON.stringify({ providers: [] }), {
      mode: 0o600,
    });
    writeProviderVault(stateDir, "{not-json");
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("not valid JSON");
  });

  it("credentials: rejects a provider credential vault with the wrong schema version", () => {
    const stateDir = freshStateDir("wrong-vault-version");
    writeConfigWithRef(stateDir);
    writeProviderVault(stateDir, { version: 2, entries: { "cred:m": SEALED_SECRET } });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("schema version");
  });

  it("credentials: detects a vault without entries", () => {
    const stateDir = freshStateDir("missing-entries-vault");
    writeConfigWithRef(stateDir);
    writeProviderVault(stateDir, {});
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("entries object");
  });

  it("credentials: detects an empty vault missing the referenced entry", () => {
    const stateDir = freshStateDir("empty-vault");
    writeConfigWithRef(stateDir);
    writeProviderVault(stateDir, { entries: {} });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("missing from the provider vault");
  });

  it("credentials: detects an unsealed referenced provider credential", () => {
    const stateDir = freshStateDir("unsealed-ref");
    writeConfigWithRef(stateDir);
    writeProviderVault(stateDir, { entries: { "cred:m": "plaintext-provider-value" } });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("not sealed");
  });

  it("credentials: rejects an empty provider credential reference", () => {
    const stateDir = freshStateDir("empty-ref");
    writeConfigWithRef(stateDir, "");
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("non-empty provider credential reference");
  });

  it("credentials: accepts a referenced sealed provider credential", () => {
    const stateDir = freshStateDir("sealed-ref");
    writeConfigWithRef(stateDir);
    writeProviderVault(stateDir, { entries: { "cred:m": SEALED_SECRET } });
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "credentials").status).toBe(
      "pass",
    );
  });

  it("credentials: refuses symlinked credential directories without reporting targets", () => {
    if (process.platform === "win32") return;
    const stateDir = freshStateDir("credentials-symlink");
    const outsideDir = join(root, "outside-credentials");
    mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    writeConfigWithRef(stateDir);
    writeFileSync(
      join(outsideDir, "provider-credentials.vault"),
      JSON.stringify({ version: 1, entries: { "cred:m": SEALED_SECRET } }),
      { mode: 0o600 },
    );
    symlinkSync(outsideDir, join(stateDir, "credentials"));
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("symbolic link");
    expect(cls.findings.join(" ")).not.toContain(outsideDir);
  });

  it("credentials: does not echo malformed secret-shaped refs in findings", () => {
    const stateDir = freshStateDir("secret-shaped-ref");
    const ref = fake("sk-", "abcdefghijklmnop0123456789");
    writeConfigWithRef(stateDir, ref);
    writeProviderVault(stateDir, { entries: {} });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("credential reference #1");
    expect(cls.findings.join(" ")).not.toContain(ref);
    expect(cls.findings.join(" ")).not.toContain("sk-");
  });

  it("credentials: rejects a sealed vault entry under a secret-shaped ref name", () => {
    const stateDir = freshStateDir("sealed-secret-shaped-ref");
    const ref = fake("sk-", "abcdefghijklmnop0123456789");
    writeConfigWithRef(stateDir, ref);
    writeProviderVault(stateDir, { entries: { [ref]: SEALED_SECRET } });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "credentials");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("credential reference #1");
    expect(cls.findings.join(" ")).not.toContain(ref);
  });

  it("file-modes: detects a group/world-readable state directory", () => {
    if (process.platform === "win32") return;
    const stateDir = freshStateDir("loose-dir");
    chmodSync(stateDir, 0o755);
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "file-modes").status).toBe(
      "fail",
    );
  });

  it("file-modes: detects a group/world-readable subdirectory", () => {
    if (process.platform === "win32") return;
    const stateDir = freshStateDir("loose-subdir");
    const sub = join(stateDir, "credentials");
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    chmodSync(sub, 0o755);
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "file-modes").status).toBe(
      "fail",
    );
  });

  it("memory-encryption: detects a plaintext memory body", () => {
    const stateDir = freshStateDir("memory-plain");
    craftDb(join(stateDir, "memory", "keiko-memory.db"), [
      "CREATE TABLE memories (body TEXT, payload_json TEXT, tags_json TEXT)",
      "INSERT INTO memories (body, tags_json) VALUES ('plaintext-not-sealed', '[]')",
    ]);
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "memory-encryption").status).toBe(
      "fail",
    );
  });

  it.each([
    ["memories", "capture_rationale"],
    ["memories", "stale_reason"],
    ["memory_edges", "provenance_summary"],
    ["memory_tombstones", "reason"],
  ])("memory-encryption: detects plaintext %s.%s", (table, column) => {
    const stateDir = freshStateDir(`memory-${table}-${column}`);
    craftDb(join(stateDir, "memory", "keiko-memory.db"), [
      `CREATE TABLE ${table} (${column} TEXT)`,
      `INSERT INTO ${table} (${column}) VALUES ('plaintext-new-memory-target')`,
    ]);
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "memory-encryption");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain(`${table}.${column}`);
  });

  it("local-knowledge-encryption: detects a store with no encryption marker", () => {
    const stateDir = freshStateDir("lk-unmarked");
    craftDb(join(stateDir, "local-knowledge", "default", "capsules.db"), [
      "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)",
      "CREATE TABLE document_texts (normalized_text TEXT)",
    ]);
    expect(
      auditLocalState(stateDir).classes.find((c) => c.id === "local-knowledge-encryption").status,
    ).toBe("fail");
  });

  it("local-knowledge-encryption: detects a marked store with a plaintext content row", () => {
    const stateDir = freshStateDir("lk-plain-row");
    craftDb(join(stateDir, "local-knowledge", "default", "capsules.db"), [
      "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)",
      "INSERT INTO schema_meta VALUES ('content_encryption', 'aes-256-gcm/v1')",
      `INSERT INTO schema_meta VALUES ('content_encryption_probe', '${SEALED_PROBE}')`,
      "CREATE TABLE document_texts (normalized_text TEXT)",
      "INSERT INTO document_texts VALUES ('leaked plaintext document content')",
    ]);
    const cls = auditLocalState(stateDir).classes.find(
      (c) => c.id === "local-knowledge-encryption",
    );
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("normalized_text");
  });

  it.each([
    ["document_text_windows", "normalized_text"],
    ["sections", "section_path_json"],
    ["parsed_units", "section_path_json"],
    ["parsed_units", "heading_path_json"],
  ])("local-knowledge-encryption: detects plaintext %s.%s", (table, column) => {
    const stateDir = freshStateDir(`lk-${table}-${column}`);
    craftDb(join(stateDir, "local-knowledge", "default", "capsules.db"), [
      "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)",
      "INSERT INTO schema_meta VALUES ('content_encryption', 'aes-256-gcm/v1')",
      `INSERT INTO schema_meta VALUES ('content_encryption_probe', '${SEALED_PROBE}')`,
      `CREATE TABLE ${table} (${column} TEXT)`,
      `INSERT INTO ${table} (${column}) VALUES ('plaintext-new-lk-target')`,
    ]);
    const cls = auditLocalState(stateDir).classes.find(
      (c) => c.id === "local-knowledge-encryption",
    );
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain(`${table}.${column}`);
  });

  it("evidence-qi: detects an unredacted secret in an evidence manifest", () => {
    const stateDir = freshStateDir("evidence-leak");
    const evidenceDir = join(stateDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(evidenceDir, "run-leak.json"),
      JSON.stringify({ note: `key=${fake("sk-", "proj-abcdefghijklmnop0123456789")}` }),
      { mode: 0o600 },
    );
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi").status).toBe(
      "fail",
    );
  });

  it("evidence-qi: detects a QI manifest without integrity hashes", () => {
    const stateDir = freshStateDir("qi-no-hash");
    const qiDir = join(stateDir, "evidence", "qi");
    mkdirSync(qiDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(qiDir, "run-1.qi.json"), JSON.stringify({ runId: "run-1" }), {
      mode: 0o600,
    });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("integrity");
  });

  it("evidence-qi: detects a QI integrity hash mismatch", () => {
    const stateDir = freshStateDir("qi-bad-hash");
    const qiDir = join(stateDir, "evidence", "qi");
    mkdirSync(qiDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(qiDir, "run-1.qi.json"),
      JSON.stringify({
        runId: "run-1",
        findings: [{ id: "f-1" }],
        exports: [],
        evidenceRefs: [],
        integrityHashes: {
          findings: "0".repeat(64),
          exports: sha256OfJson([]),
          evidenceRefs: sha256OfJson([]),
        },
      }),
      { mode: 0o600 },
    );
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("integrity hash mismatch");
  });

  it("evidence-qi: includes Figma snapshot side-files and detects hash drift", () => {
    const stateDir = freshStateDir("figma-sidefile-drift");
    const qiDir = join(stateDir, "evidence", "qi");
    const sideDir = join(qiDir, "figma-snapshots", "figma-run-1");
    mkdirSync(sideDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(sideDir, "screen.png"), "actual bytes", { mode: 0o600 });
    writeFileSync(
      join(qiDir, "figma-run-1.figma-snapshot.json"),
      JSON.stringify({
        figmaSnapshotSchemaVersion: 1,
        runId: "figma-run-1",
        provenance: { fileKey: "f", nodeId: "0:1", fetchedAt: "2026-06-21T00:00:00.000Z" },
        integrityHash: "snapshot-hash",
        screens: [
          {
            screenId: "s1",
            irJson: { root: { id: "s1", children: [] } },
            integrityHash: "screen-hash",
            image: {
              path: "screen.png",
              mimeType: "image/png",
              sha256: "f".repeat(64),
              byteLength: 12,
            },
          },
        ],
        skippedScreens: [],
        redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
      }),
      { mode: 0o600 },
    );
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("sha256 does not match");
  });

  it("evidence-qi: refuses symlinked artifacts without reporting their targets", () => {
    if (process.platform === "win32") return;
    const stateDir = freshStateDir("evidence-symlink");
    const evidenceDir = join(stateDir, "evidence");
    const outsideDir = join(root, "outside-evidence");
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    const outsideTarget = join(outsideDir, "outside.json");
    writeFileSync(outsideTarget, JSON.stringify({ note: "outside" }), { mode: 0o600 });
    symlinkSync(outsideTarget, join(evidenceDir, "linked.json"));
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("symbolic link");
    expect(cls.findings.join(" ")).not.toContain(outsideTarget);
  });

  it("evidence-qi: refuses a symlinked evidence root without reporting its target", () => {
    if (process.platform === "win32") return;
    const stateDir = freshStateDir("evidence-root-symlink");
    const outsideDir = join(root, "outside-evidence-root");
    mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(outsideDir, "run-1.json"), JSON.stringify({ runId: "outside" }), {
      mode: 0o600,
    });
    symlinkSync(outsideDir, join(stateDir, "evidence"));
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("symbolic link");
    expect(cls.findings.join(" ")).not.toContain(outsideDir);
  });

  it("evidence-qi: refuses Figma image side-files through symlinked parent directories", () => {
    if (process.platform === "win32") return;
    const stateDir = freshStateDir("figma-sidefile-parent-symlink");
    const qiDir = join(stateDir, "evidence", "qi");
    const snapshotRoot = join(qiDir, "figma-snapshots");
    const outsideRunDir = join(root, "outside-figma-run");
    const image = Buffer.from("png-bytes");
    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    mkdirSync(outsideRunDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(outsideRunDir, "screen.png"), image, { mode: 0o600 });
    symlinkSync(outsideRunDir, join(snapshotRoot, "run-symlink"));
    writeFileSync(
      join(qiDir, "run-symlink.figma-snapshot.json"),
      JSON.stringify({
        runId: "run-symlink",
        integrityHash: "present",
        artifactHashes: {},
        screens: [
          {
            screenId: "screen",
            integrityHash: "present",
            image: {
              relativePath: "screen.png",
              byteLength: image.byteLength,
              sha256: createHash("sha256").update(image).digest("hex"),
            },
          },
        ],
        redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
      }),
      { mode: 0o600 },
    );
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("symbolic link");
    expect(cls.findings.join(" ")).not.toContain(outsideRunDir);
  });

  it("evidence-qi: detects an unsealed Figma token vault", () => {
    const stateDir = freshStateDir("figma-unsealed");
    const figmaDir = join(stateDir, "evidence", "figma");
    mkdirSync(figmaDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(figmaDir, "figma-token.vault"), "unsealed-token-not-a-kv1-envelope", {
      mode: 0o600,
    });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("sealed");
  });
});

describe("auditLocalState — secret-shape detection", () => {
  it.each([
    ["openai", fake("sk-", "proj-abcdefghijklmnop0123456789")],
    ["github-oauth", fake("gho", "_abcdefghijklmnopqrstuvwxyz0123456789")],
    ["google", fake("AIza", "SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456")],
    ["stripe", fake("sk", "_live_", "abcdefghijklmnop0123456789")],
    ["bearer", `Bearer ${fake("tok.", "abcdefghijklmnop0123456789")}`],
    ["basic", `Basic ${fake("YWJj", "ZGVmZ2hpamtsbW5vcA==")}`],
    ["x-api-key-header", `x-api-key: ${fake("secret", "abcdefghijklmnop")}`],
    ["api-key-assignment", `api_key=${fake("secret", "abcdefghijklmnop")}`],
    ["secret-key-assignment", `refresh_token=${fake("secret", "abcdefghijklmnop")}`],
    ["url-credentials", `https://${fake("user", "name")}:${fake("pass", "word123")}@example.com`],
  ])("flags a leaked %s key in an evidence artifact", (_label, secret) => {
    const stateDir = freshStateDir(`secret-${_label}`);
    const evidenceDir = join(stateDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(evidenceDir, "run-1.json"), JSON.stringify({ leaked: secret }), {
      mode: 0o600,
    });
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi").status).toBe(
      "fail",
    );
  });

  it("does not flag a correctly redacted placeholder", () => {
    const stateDir = freshStateDir("redacted-ok");
    const evidenceDir = join(stateDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(evidenceDir, "run-1.json"),
      JSON.stringify({ token: "[REDACTED]", authorization: "Bearer [REDACTED]" }),
      { mode: 0o600 },
    );
    expect(auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi").status).toBe(
      "pass",
    );
  });

  it("flags a partially redacted secret assignment", () => {
    const stateDir = freshStateDir("partial-redaction");
    const evidenceDir = join(stateDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(evidenceDir, "run-1.json"), JSON.stringify({ token: "[REDACTED]tail" }), {
      mode: 0o600,
    });
    const cls = auditLocalState(stateDir).classes.find((c) => c.id === "evidence-qi");
    expect(cls.status).toBe("fail");
    expect(cls.findings.join(" ")).toContain("secret key assignment");
  });
});
