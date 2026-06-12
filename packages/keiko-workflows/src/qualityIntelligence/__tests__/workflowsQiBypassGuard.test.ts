// Gateway-only enforcement for the WORKFLOWS Quality Intelligence runtime (Epic #270, Issue #279).
//
// Issue #279 STOP CONDITION: QI model calls must not bypass the Keiko Model Gateway. The model-routed
// run entry (modelRoutedTestDesign.ts) orchestrates the live generation/judge calls through injected
// ports and must stay provider-SDK-free (ADR-0023 D6: workflows own no gateway wiring). The existing
// independenceGuard.test.ts in this directory only forbids the Test-Intelligence namespace; this scan
// adds the provider-SDK bypass guard so a direct-provider import in the workflow QI layer fails CI.

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
const WORKFLOWS_QI_DIR = join(HERE, "..");

function listProductionFiles(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "__tests__") continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listProductionFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Workflows Quality Intelligence routing bypass guard", () => {
  it("no production source under keiko-workflows/src/qualityIntelligence imports a provider SDK", () => {
    const files = listProductionFiles(WORKFLOWS_QI_DIR);
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
});
