import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// KEIKO-0965: packages/keiko-ui/tsconfig.json used to carry a stale ".next/dev/dev/types/**/*.ts"
// include beside the two canonical Next-emitted entries. The doubled "dev/dev" segment is not
// a path Next ever writes to and the entry matched nothing — residue of a rename. Pin the
// include list so the residue cannot come back and so any legitimate future addition is a
// reviewed change to this pin.

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TSCONFIG_PATH = resolve(REPO_ROOT, "packages", "keiko-ui", "tsconfig.json");

describe("keiko-ui tsconfig include list", () => {
  it("declares only the canonical Next.js emitted-type globs", () => {
    const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8"));
    expect(tsconfig.include).toStrictEqual([
      "next-env.d.ts",
      "**/*.ts",
      "**/*.tsx",
      ".next/types/**/*.ts",
      ".next/dev/types/**/*.ts",
    ]);
  });
});
