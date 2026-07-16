import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  hashSchemaDirectory,
  normalizeSchemaRelativePath,
  verifyGeneratedSchemaDirectory,
  verifyVendoredSchemaBundle,
} from "../codex-app-server-schema.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemaA = process.env.KEIKO_CODEX_SCHEMA_DIR_A;
const schemaB = process.env.KEIKO_CODEX_SCHEMA_DIR_B;
const temporaryRoots = [];

function requiredRealSchemaDirectory(variable, value) {
  if (value === undefined || value.length === 0) {
    throw new Error(`${variable} is required when real schema verification is enabled`);
  }
  if (!existsSync(value)) throw new Error(`${variable} does not exist: ${value}`);
  return value;
}

function configuredRealSchemaDirectories(env) {
  const first = env.KEIKO_CODEX_SCHEMA_DIR_A;
  const second = env.KEIKO_CODEX_SCHEMA_DIR_B;
  if (first === undefined && second === undefined) return undefined;
  return {
    first: requiredRealSchemaDirectory("KEIKO_CODEX_SCHEMA_DIR_A", first),
    second: requiredRealSchemaDirectory("KEIKO_CODEX_SCHEMA_DIR_B", second),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function temporarySchemaFixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-codex-schema-test-"));
  temporaryRoots.push(root);
  const generated = join(root, "schema");
  mkdirSync(join(generated, "v2"), { recursive: true });
  writeFileSync(join(generated, "JSONRPCRequest.json"), '{"title":"request"}', "utf8");
  writeFileSync(join(generated, "v2", "TurnStart.json"), '{"title":"turn"}', "utf8");

  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  const vendoredFiles = [
    ["codex_app_server_protocol.schemas.json", '{"title":"stable"}'],
    ["codex_app_server_protocol.v2.schemas.json", '{"title":"v2"}'],
  ].map(([path, source]) => {
    writeFileSync(join(bundle, path), source, "utf8");
    return { path, canonicalSha256: sha256(source) };
  });
  const generatedEvidence = hashSchemaDirectory(generated);
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({
      algorithm: "keiko-codex-schema-bundle-v1",
      generatedFileCount: generatedEvidence.files.length,
      generatedFolderSha256: generatedEvidence.digest,
      vendoredFiles,
    }),
    "utf8",
  );
  return { bundle, generated };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("Codex app-server schema evidence", () => {
  it("normalizes schema paths independently of the host separator", () => {
    expect(normalizeSchemaRelativePath("v2\\TurnStart.json")).toBe("v2/TurnStart.json");
    expect(normalizeSchemaRelativePath("v2/TurnStart.json")).toBe("v2/TurnStart.json");
    expect(() => normalizeSchemaRelativePath("../TurnStart.json")).toThrow("traversal");
    expect(() => normalizeSchemaRelativePath("/v2/TurnStart.json")).toThrow("must be relative");
    expect(() => normalizeSchemaRelativePath("C:\\v2\\TurnStart.json")).toThrow("must be relative");
  });

  it("fails closed for partial or invalid real-schema verification configuration", () => {
    expect(configuredRealSchemaDirectories({})).toBeUndefined();
    expect(() => configuredRealSchemaDirectories({ KEIKO_CODEX_SCHEMA_DIR_A: repoRoot })).toThrow(
      "KEIKO_CODEX_SCHEMA_DIR_B is required",
    );
    expect(() =>
      configuredRealSchemaDirectories({
        KEIKO_CODEX_SCHEMA_DIR_A: "/missing/a",
        KEIKO_CODEX_SCHEMA_DIR_B: "/missing/b",
      }),
    ).toThrow("KEIKO_CODEX_SCHEMA_DIR_A does not exist");
  });

  it.runIf(schemaA !== undefined || schemaB !== undefined)(
    "normalizes both independently generated official schema folders to the pinned digest",
    () => {
      const configured = configuredRealSchemaDirectories(process.env);
      if (configured === undefined) throw new Error("Real schema verification is not configured");
      const first = hashSchemaDirectory(configured.first);
      const second = hashSchemaDirectory(configured.second);

      expect(first.files).toHaveLength(267);
      expect(second.files).toHaveLength(267);
      expect(first.digest).toBe("05463d8615d2a277cf3be6ee15a84398c5e2ce2307b93415602499dc3e07880a");
      expect(second.digest).toBe(first.digest);
    },
  );

  it("verifies the canonical vendored aggregate schemas", () => {
    const manifest = verifyVendoredSchemaBundle();

    expect(manifest.source).toEqual({ tag: "rust-v0.144.1", version: "0.144.1" });
    expect(manifest.vendoredFiles).toHaveLength(2);
    expect(manifest.generatedFileCount).toBe(267);
    expect(manifest.generatedFolderSha256).toBe(
      "05463d8615d2a277cf3be6ee15a84398c5e2ce2307b93415602499dc3e07880a",
    );
  });

  it("rejects a one-character semantic schema drift", () => {
    const { bundle, generated } = temporarySchemaFixture();
    expect(() => verifyGeneratedSchemaDirectory(generated, bundle)).not.toThrow();
    const file = join(generated, "JSONRPCRequest.json");
    const document = JSON.parse(readFileSync(file, "utf8"));
    document.title = `${document.title}!`;
    writeFileSync(file, canonicalJsonBytes(JSON.stringify(document), file));

    expect(() => verifyGeneratedSchemaDirectory(generated, bundle)).toThrow(
      "Generated schema digest drift",
    );
  });

  it("rejects missing, extra, and malformed generated schema files", () => {
    const missing = temporarySchemaFixture();
    unlinkSync(join(missing.generated, "JSONRPCRequest.json"));
    expect(() => verifyGeneratedSchemaDirectory(missing.generated, missing.bundle)).toThrow(
      "Generated schema file count drift",
    );

    const extra = temporarySchemaFixture();
    writeFileSync(join(extra.generated, "unexpected.json"), "{}", "utf8");
    expect(() => verifyGeneratedSchemaDirectory(extra.generated, extra.bundle)).toThrow(
      "Generated schema file count drift",
    );

    const malformed = temporarySchemaFixture();
    writeFileSync(join(malformed.generated, "JSONRPCRequest.json"), "{", "utf8");
    expect(() => verifyGeneratedSchemaDirectory(malformed.generated, malformed.bundle)).toThrow(
      "is not valid JSON",
    );
  });

  it("rejects vendored schema drift", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-codex-schema-bundle-test-"));
    temporaryRoots.push(root);
    const bundle = join(root, "bundle");
    cpSync(join(repoRoot, "packages/keiko-server/resources/codex-app-server-schema"), bundle, {
      recursive: true,
    });
    const file = join(bundle, "codex_app_server_protocol.v2.schemas.json");
    writeFileSync(file, `${readFileSync(file, "utf8")} `, "utf8");

    expect(() => verifyVendoredSchemaBundle(bundle)).toThrow("Vendored schema is not canonical");
  });
});
