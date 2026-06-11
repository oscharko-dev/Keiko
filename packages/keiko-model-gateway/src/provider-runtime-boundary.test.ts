import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

function collectProductionFiles(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = resolve(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      out.push(...collectProductionFiles(absolute));
      continue;
    }
    if (!absolute.endsWith(".ts") || absolute.endsWith(".test.ts")) {
      continue;
    }
    out.push(absolute);
  }
  return out.sort();
}

function readPackageSources(relativeDirectory: string): readonly { path: string; source: string }[] {
  const directory = resolve(REPO_ROOT, relativeDirectory);
  return collectProductionFiles(directory).map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));
}

describe("provider runtime package boundary", () => {
  it("keiko-contracts does not own credential-resolver or Codex CLI runtime details", () => {
    const forbiddenPatterns: readonly RegExp[] = [
      /\bcredentialResolver\b/u,
      /\bCodexCliCredentialResolverConfig\b/u,
      /["']node:child_process["']/u,
      /\bcodex-cli\b/u,
    ];
    const violations: string[] = [];

    for (const file of readPackageSources("packages/keiko-contracts/src")) {
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(file.source)) {
          violations.push(`${file.path} matched ${pattern.source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keiko-server does not own local-session resolver or Codex CLI runtime details", () => {
    const forbiddenPatterns: readonly RegExp[] = [
      /\bcredentialResolver\b/u,
      /\bCodexCliCredentialResolverConfig\b/u,
      /\bcodex-cli\b/u,
      /\bCodexCliClient\b/u,
      /\bCodexLocalSessionAdapter\b/u,
    ];
    const violations: string[] = [];

    for (const file of readPackageSources("packages/keiko-server/src")) {
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(file.source)) {
          violations.push(`${file.path} matched ${pattern.source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keiko-model-gateway remains the owning package for the local-session runtime seam", () => {
    const typesSource = readFileSync(
      resolve(REPO_ROOT, "packages/keiko-model-gateway/src/types.ts"),
      "utf8",
    );
    const cliSource = readFileSync(
      resolve(REPO_ROOT, "packages/keiko-model-gateway/src/codex-cli.ts"),
      "utf8",
    );
    const registrySource = readFileSync(
      resolve(REPO_ROOT, "packages/keiko-model-gateway/src/provider-registry.ts"),
      "utf8",
    );

    expect(typesSource).toMatch(/\binterface CodexCliCredentialResolverConfig\b/u);
    expect(cliSource).toMatch(/from\s+["']node:child_process["']/u);
    expect(registrySource).toMatch(/openai-codex-local-session/u);
  });
});
