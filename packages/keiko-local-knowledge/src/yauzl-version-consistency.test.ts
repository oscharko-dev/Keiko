import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// KEIKO-0568: yauzl floors used to diverge between keiko-local-knowledge (^3.3.2) and both
// keiko-server / root (^3.4.0). npm hoists to the newer floor at install time, so
// keiko-local-knowledge silently ran against a version above its own declared floor — the
// declared floor stopped meaning what it looked like it meant. Pin the three floors to agree.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function yauzlFloor(manifestRelativePath: string): string {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, manifestRelativePath), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const value = manifest.dependencies?.yauzl;
  if (typeof value !== "string") {
    throw new Error(`no yauzl declared in ${manifestRelativePath}`);
  }
  return value;
}

describe("yauzl floor consistency", () => {
  it("declares the same yauzl range in every manifest that pulls it", () => {
    const localKnowledge = yauzlFloor("packages/keiko-local-knowledge/package.json");
    const server = yauzlFloor("packages/keiko-server/package.json");
    const root = yauzlFloor("package.json");
    expect(localKnowledge).toBe(server);
    expect(localKnowledge).toBe(root);
  });
});
