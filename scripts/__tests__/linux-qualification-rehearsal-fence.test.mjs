import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The release lane rehearses on every dev push, so a second Sigstore policy exists for certificates
// that name refs/heads/dev. An installed Keiko must only ever accept release-signed Linux
// qualifications, which holds exactly as long as nothing in a package reaches for that second
// policy. These pins keep the rehearsal policy fenced to the one release tool that needs it.

const REHEARSAL_EXPORT =
  /\b(?:LINUX_QUALIFICATION_REHEARSAL_SIGSTORE_POLICY|verifyLinuxQualificationRehearsalBundle)\b/u;
const DEFINING_MODULE = "packages/keiko-server/src/coding-runtime/linuxPortableSigstore.ts";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".next", "out", "coverage"]);

function sourceFiles(root, accept) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path, accept);
    return accept(path) ? [path] : [];
  });
}

const isTest = (path) => /\.test\.[cm]?[jt]sx?$/u.test(path) || path.includes("__tests__");

describe("the Linux qualification rehearsal fence", () => {
  it("keeps the rehearsal policy out of every product module", () => {
    const offenders = sourceFiles(
      "packages",
      (path) => /\.(?:[cm]?[jt]sx?)$/u.test(path) && !isTest(path),
    ).filter(
      (path) => path !== DEFINING_MODULE && REHEARSAL_EXPORT.test(readFileSync(path, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("lets only the Linux release signing tool verify a rehearsal", () => {
    const consumers = sourceFiles(
      "scripts",
      (path) => /\.mjs$/u.test(path) && !isTest(path),
    ).filter((path) => REHEARSAL_EXPORT.test(readFileSync(path, "utf8")));

    expect(consumers).toEqual(["scripts/linux-portable-signing.mjs"]);
  });

  it("keeps the product runtime's Linux attestation on the release verifier", () => {
    const runtime = readFileSync(
      "packages/keiko-server/src/coding-runtime/productionPortableCodingRuntime.ts",
      "utf8",
    );

    expect(runtime).toContain("verifyLinuxQualificationBundle(receipt, bundle)");
    expect(REHEARSAL_EXPORT.test(runtime)).toBe(false);
  });
});
