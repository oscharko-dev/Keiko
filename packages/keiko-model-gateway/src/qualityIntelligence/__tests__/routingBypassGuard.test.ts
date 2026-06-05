import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORBIDDEN_PROVIDER_SDKS: readonly RegExp[] = [
  /from\s+["']openai["']/,
  /from\s+["']@anthropic-ai\//,
  /from\s+["']cohere-ai["']/,
  /from\s+["']@google-cloud\/aiplatform["']/,
  /from\s+["'][^"']*\bazure\b[^"']*["']/,
  /from\s+["']aws-sdk["']/,
  /from\s+["']@aws-sdk\//,
  /from\s+["']@google\/generative-ai["']/,
  /from\s+["'][^"']*-ai-sdk["']/,
];

const HERE = dirname(fileURLToPath(import.meta.url));
const QI_DIR = join(HERE, "..");

function listProductionFiles(root: string): readonly string[] {
  const out: string[] = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    if (entry === "__tests__") {
      continue;
    }
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Quality Intelligence routing bypass guard", () => {
  it("no production source under qualityIntelligence/ imports a provider SDK", () => {
    const files = listProductionFiles(QI_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_PROVIDER_SDKS) {
        if (pattern.test(content)) {
          violations.push(`${file}: matched ${String(pattern)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every production source imports only type-only contracts, type-only security, or relative paths", () => {
    const files = listProductionFiles(QI_DIR);
    const importLine = /^\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/gm;
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = importLine.exec(content)) !== null) {
        const spec = match[1];
        if (spec === undefined) {
          continue;
        }
        const isRelative = spec.startsWith(".") || spec.startsWith("..");
        const isContracts = spec === "@oscharko-dev/keiko-contracts";
        const isSecurity =
          spec === "@oscharko-dev/keiko-security" ||
          spec.startsWith("@oscharko-dev/keiko-security/");
        if (!isRelative && !isContracts && !isSecurity) {
          violations.push(`${file}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
