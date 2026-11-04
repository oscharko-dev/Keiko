import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect } from "vitest";

// Qualification reports any non-passing proof run as semantic-proof-execution-failed, including a
// variant that no longer imports or parses. A negative semantic test therefore reruns the declared
// proofs and requires every proof file to be reached and a declared assertion to fail
// (REVIEW-3918-045).
export function expectDeclaredProofFailure(own) {
  const records = own.policy.responsibilities;
  const paths = [...new Set(records.flatMap((record) => record.proofs ?? []))];
  const selectors = records.flatMap((record) => record.proofAssertions ?? []);
  const report = runDeclaredProofs(own.root, paths);
  const root = realpathSync(own.root);
  const files = new Map(
    report.testResults.map((file) => [relative(root, file.name), file.assertionResults]),
  );
  for (const path of paths) expect(files.get(path)?.length ?? 0).toBeGreaterThan(0);
  const failed = selectors.filter((selector) =>
    files
      .get(selector.path)
      .some((test) => test.fullName === selector.testName && test.status === "failed"),
  );
  expect(failed.length).toBeGreaterThan(0);
}

function runDeclaredProofs(root, paths) {
  const temporary = mkdtempSync(join(tmpdir(), "keiko-proof-failure-"));
  try {
    const output = join(temporary, "result.json");
    spawnSync(
      process.execPath,
      [
        realpathSync(process.env.npm_execpath),
        "exec",
        "--offline",
        "--",
        "vitest",
        "run",
        "--reporter=json",
        `--outputFile=${output}`,
        ...paths.map((path) => `./${path}`),
      ],
      { cwd: root, stdio: "ignore", timeout: 180_000 },
    );
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
