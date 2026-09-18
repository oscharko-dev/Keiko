import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Builds a throwaway repository root with a minimal `packages/keiko-contracts/src/observability.ts`
// (the two canonical registry APIs, same signatures as production) and
// `packages/<pkgName>/src/fixture.ts`, plus any `extraFiles` (repository-relative path ->
// contents, e.g. a fixture test that calls a proof helper), then runs `check(root)` and always
// cleans up. The production generator entry points run against that root unchanged, so a fixture
// exercises the real registry and inventory derivation end to end instead of restating any rule.
export function withTypedRegistryFixture(pkgName, fileContents, check, extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "typed-op-registry-fixture-"));
  try {
    const contractsDir = join(root, "packages", "keiko-contracts", "src");
    const emitterDir = join(root, "packages", pkgName, "src");
    mkdirSync(contractsDir, { recursive: true });
    mkdirSync(emitterDir, { recursive: true });
    writeFileSync(
      join(contractsDir, "observability.ts"),
      [
        "export function defineActivityLogOperation<const T>(value: T): T { return value; }",
        "export function activityLogEvent<const T>(registration: T, _envelope: object, fields: Record<string, unknown>) {",
        '  return { ...fields, contractKind: "activity-log-event" as const, registration };',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(emitterDir, "fixture.ts"), fileContents, "utf8");
    for (const [relativePath, contents] of Object.entries(extraFiles)) {
      const path = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, "utf8");
    }
    return check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
