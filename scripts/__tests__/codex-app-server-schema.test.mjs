import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const schemaA = "/tmp/keiko-2255-codex/schema-a";
const schemaB = "/tmp/keiko-2255-codex/schema-b";
const temporaryRoots = [];

function temporarySchemaCopy(source = schemaA) {
  const root = mkdtempSync(join(tmpdir(), "keiko-codex-schema-test-"));
  const destination = join(root, "schema");
  cpSync(source, destination, { recursive: true });
  temporaryRoots.push(root);
  return destination;
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

  it("normalizes both independently generated official schema folders to the pinned digest", () => {
    const first = hashSchemaDirectory(schemaA);
    const second = hashSchemaDirectory(schemaB);

    expect(first.files).toHaveLength(267);
    expect(second.files).toHaveLength(267);
    expect(first.digest).toBe("05463d8615d2a277cf3be6ee15a84398c5e2ce2307b93415602499dc3e07880a");
    expect(second.digest).toBe(first.digest);
  });

  it("verifies the canonical vendored aggregate schemas", () => {
    const manifest = verifyVendoredSchemaBundle();

    expect(manifest.source).toEqual({ tag: "rust-v0.144.1", version: "0.144.1" });
    expect(manifest.vendoredFiles).toHaveLength(2);
    expect(() => verifyGeneratedSchemaDirectory(schemaA)).not.toThrow();
  });

  it("rejects a one-character semantic schema drift", () => {
    const directory = temporarySchemaCopy();
    const file = join(directory, "codex_app_server_protocol.schemas.json");
    const document = JSON.parse(readFileSync(file, "utf8"));
    document.title = `${document.title}!`;
    writeFileSync(file, canonicalJsonBytes(JSON.stringify(document), file));

    expect(() => verifyGeneratedSchemaDirectory(directory)).toThrow(
      "Generated schema digest drift",
    );
  });

  it("rejects missing, extra, and malformed generated schema files", () => {
    const missing = temporarySchemaCopy();
    unlinkSync(join(missing, "JSONRPCRequest.json"));
    expect(() => verifyGeneratedSchemaDirectory(missing)).toThrow(
      "Generated schema file count drift",
    );

    const extra = temporarySchemaCopy();
    writeFileSync(join(extra, "unexpected.json"), "{}", "utf8");
    expect(() => verifyGeneratedSchemaDirectory(extra)).toThrow(
      "Generated schema file count drift",
    );

    const malformed = temporarySchemaCopy();
    writeFileSync(join(malformed, "JSONRPCRequest.json"), "{", "utf8");
    expect(() => verifyGeneratedSchemaDirectory(malformed)).toThrow("is not valid JSON");
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
